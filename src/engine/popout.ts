// The preview in its own OS window.
//
// What is moved matters more than where to. The picture is a live WebGL2
// canvas with Remotion iframes positioned over it, so it must not be built a
// second time on the far side: a new canvas means a new GL context (Chromium
// keeps 16 per renderer and force-loses the OLDEST beyond that — the very
// trap Compositor.dispose exists for), and every fragment iframe would
// reload on each toggle.
//
// So nothing is re-created. The preview always lives in ONE host div that a
// React portal renders into, and popping out only moves that div into the
// popup's document. React attaches its event listeners to the portal
// container itself, so they travel with the div; the canvas keeps the very
// same GL context; the Player never detaches. `window.open` gives a real
// BrowserWindow — resizable, movable, and free to sit on another monitor.
//
// The popup is `about:blank`, i.e. same-origin with the editor and in the
// same renderer process: without that the DOM could not be adopted at all.
//
// K12: the mixer pops out the same way (canvas K, RULES 3) — a window and a
// host of its own; the AudioContext stays this window's, as for the preview.
import { create } from 'zustand'
import { tr, type TKey } from '@/i18n'
import { logWarn } from './log'

const MIN_W = 320
const MIN_H = 200

/** null = the preview is docked in the editor. */
export const usePopout = create<{ win: Window | null }>(() => ({ win: null }))
/** null = the mixer is docked under the timeline's toolbar (or hidden). */
export const useMixerPopout = create<{ win: Window | null }>(() => ({ win: null }))

const host = () => {
  const el = document.createElement('div')
  el.className = 'preview-host'
  return el
}
/** The one element the preview ever lives in; only its parent changes. */
export const previewHost: HTMLDivElement = host()
/** The mixer's place in its own window: a portal renders the strips into it. */
export const mixerHost: HTMLDivElement = host()

let slot: HTMLElement | null = null

/** App.tsx hands over the place the preview sits in when docked. */
export function setPreviewSlot(el: HTMLElement | null): void {
  slot = el
  if (el && !usePopout.getState().win && previewHost.parentElement !== el) el.appendChild(previewHost)
}

interface Geom { w: number; h: number; x?: number; y?: number }

function readGeom(key: string, w: number, h: number): Geom {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const g = JSON.parse(raw) as Geom
      if (Number.isFinite(g.w) && Number.isFinite(g.h) && g.w >= MIN_W && g.h >= MIN_H) return g
    }
  } catch { /* a corrupt entry must not cost the button */ }
  return { w, h }
}

/** Read while the window is ALIVE — a closed one reports zeros. */
function saveGeom(key: string, w: Window): void {
  try {
    const g: Geom = {
      w: Math.round(w.outerWidth), h: Math.round(w.outerHeight),
      x: Math.round(w.screenX), y: Math.round(w.screenY)
    }
    if (g.w >= MIN_W && g.h >= MIN_H) localStorage.setItem(key, JSON.stringify(g))
  } catch { /* geometry is a convenience, never a failure */ }
}

/**
 * The popup carries no stylesheet of its own: every style and stylesheet link
 * of the editor is cloned into it, and re-cloned when they change — a CSS edit
 * in dev arrives as a mutation of the injected <style>, and without this the
 * detached preview would keep the styles it was born with. New nodes are
 * appended BEFORE the old ones go, so a resync never flashes unstyled.
 */
function mirrorStyles(doc: Document): () => void {
  const sync = () => {
    const old = Array.from(doc.head.querySelectorAll('[data-kadr-style]'))
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
      const clone = doc.importNode(node, true) as HTMLElement
      // href is relative to the editor's document; about:blank would resolve
      // it against itself and silently load nothing
      if (node instanceof HTMLLinkElement) clone.setAttribute('href', node.href)
      clone.setAttribute('data-kadr-style', '')
      doc.head.appendChild(clone)
    }
    for (const node of old) node.remove()
  }
  sync()
  let timer = 0
  const obs = new MutationObserver(() => {
    clearTimeout(timer)
    timer = window.setTimeout(sync, 30)
  })
  obs.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => { obs.disconnect(); clearTimeout(timer) }
}

/** One OS window that one host div moves into, and back out of. */
function popout(o: {
  name: string; geomKey: string; w: number; h: number; title: TKey
  store: typeof usePopout; host: HTMLElement
  /** where the host goes back to (null: out of every document) */
  home: () => HTMLElement | null
}) {
  let stopStyles: (() => void) | null = null
  let leave: (() => void) | null = null
  let watchdog = 0

  /** The editor going away (a reload, a quit) must not leave the popup behind. */
  const closeOnMainUnload = () => {
    const w = o.store.getState().win
    if (w && !w.closed) {
      saveGeom(o.geomKey, w)
      try { w.close() } catch { /* already gone */ }
    }
  }

  function dock(closing: boolean): void {
    const w = o.store.getState().win
    if (watchdog) { clearInterval(watchdog); watchdog = 0 }
    window.removeEventListener('beforeunload', closeOnMainUnload)
    if (w && leave) {
      w.removeEventListener('beforeunload', leave)
      w.removeEventListener('pagehide', leave)
    }
    leave = null
    stopStyles?.()
    stopStyles = null
    // the host has to leave the popup's document while that document is still
    // alive: the canvas, its GL context and the fragment iframes go with it
    const home = o.home()
    if (home) home.appendChild(o.host)
    else o.host.remove()
    o.store.setState({ win: null })
    if (w && !closing && !w.closed) {
      saveGeom(o.geomKey, w)
      try { w.close() } catch { /* already gone */ }
    }
  }

  function open(): boolean {
    if (o.store.getState().win) return true
    const g = readGeom(o.geomKey, o.w, o.h)
    const feat = `width=${g.w},height=${g.h},resizable=yes` +
      (g.x !== undefined && g.y !== undefined ? `,left=${g.x},top=${g.y}` : '')
    let w: Window | null = null
    try {
      w = window.open('', o.name, feat)
    } catch (err) {
      logWarn(tr('lgPreview'), tr('lmPopoutFail'), err)
      return false
    }
    if (!w) {
      logWarn(tr('lgPreview'), tr('lmPopoutFail'))
      return false
    }
    const doc = w.document
    // about:blank normally arrives with a body; write one when it does not
    if (!doc.body) {
      doc.write('<!doctype html><html><head></head><body></body></html>')
      doc.close()
    }
    doc.documentElement.lang = document.documentElement.lang || 'ru'
    doc.title = tr(o.title)
    doc.body.className = 'kadr-popout'
    stopStyles = mirrorStyles(doc)
    doc.body.appendChild(o.host)

    const win = w
    leave = () => {
      // still alive here, so the geometry is readable and the host can be
      // carried out before this document (and the canvas in it) is destroyed
      saveGeom(o.geomKey, win)
      dock(true)
    }
    win.addEventListener('beforeunload', leave)
    win.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', closeOnMainUnload)
    // backstop: a window destroyed without unloading (a hard kill) would
    // otherwise leave the button stuck in the "detached" state forever
    watchdog = window.setInterval(() => {
      if (win.closed) dock(true)
    }, 1000)
    o.store.setState({ win })
    try { win.focus() } catch { /* the WM decides */ }
    return true
  }

  return {
    open,
    dock: () => dock(false),
    toggle: (): boolean => {
      if (!o.store.getState().win) return open()
      dock(false)
      return false
    }
  }
}

const preview = popout({
  name: 'kadr-preview', geomKey: 'kadr.previewWindow', w: 960, h: 560, title: 'popoutTitle',
  store: usePopout, host: previewHost, home: () => slot ?? document.body
})
export const openPreviewWindow = preview.open
export const dockPreviewWindow = preview.dock
export const togglePreviewWindow = preview.toggle

// canvas K, board Window: all twelve strips at full width in 1320 px
const mixer = popout({
  name: 'kadr-mixer', geomKey: 'kadr.mixerWindow', w: 1320, h: 560, title: 'mxWinTitle',
  store: useMixerPopout, host: mixerHost, home: () => null
})
export const openMixerWindow = mixer.open
export const dockMixerWindow = mixer.dock
