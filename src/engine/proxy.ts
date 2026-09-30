// Preview proxies: heavy sources get a background 540p copy from the main
// process; the preview's MediaPool then decodes the proxy while export keeps
// reading the original (WYSIWYG quality).
import { create } from 'zustand'
import type { MediaAsset } from '@shared/types'
import { useEditor, useSettings, setting } from '@/state/store'
import { previewPrefs } from './player'
import { chromiumCanDecode } from './codecs'
import { buildsProxy, type ProxyEnv } from '@shared/proxyChoice'


interface ProxyProgressState {
  /** asset id → 0..1 while a proxy is being generated */
  jobs: Record<string, number>
}

export const useProxyProgress = create<ProxyProgressState>(() => ({ jobs: {} }))

/** the env of shared/proxyChoice.ts for this asset, from the live settings */
export function proxyEnv(a: MediaAsset): ProxyEnv {
  return {
    proxies: setting('playback.proxies') === true,
    minSide: setting<number>('playback.proxyMinSide'),
    canDecode: chromiumCanDecode(a.codec)
  }
}

export function wantsProxy(a: MediaAsset): boolean {
  return buildsProxy(a, proxyEnv(a))
}

const inflight = new Set<string>()

/**
 * Kick off proxy builds for every heavy asset. Safe to call repeatedly: an
 * already-built proxy resolves instantly from the main-process cache, which
 * also re-creates proxies referenced by old projects but wiped from disk.
 */
export function ensureProxies() {
  const st = useEditor.getState()
  for (const a of st.project.assets) {
    if (!wantsProxy(a) || inflight.has(a.id)) continue
    // A proxy the project remembers but the disk no longer has — the storage
    // panel wiped it, or a cleanup did. Clear the reference FIRST: the pool
    // then decodes the original on the very next draw instead of pointing a
    // <video> at a missing file, and the rebuild below sets the path again.
    // Without this the clip stays black, because the rebuilt proxy lands under
    // the SAME name, nothing in the store changes, and the failed element is
    // never told to reload.
    if (a.proxyPath) {
      const proxyPath = a.proxyPath
      void window.kadr.statFile(proxyPath).then((mtime) => {
        if (mtime !== null) return
        const cur = useEditor.getState().project.assets.find((x) => x.id === a.id)
        if (cur?.proxyPath === proxyPath) {
          useEditor.getState().updateAsset(a.id, { proxyPath: undefined })
        }
      })
    }
    build(a)
  }
}

/** «Пересобрать прокси» (H7): the cached file is deleted and built again.
    The path is cleared first so the preview drops to the original meanwhile
    and reloads when the path comes back (the new file has the SAME name). */
export function rebuildProxy(assetId: string) {
  const a = useEditor.getState().project.assets.find((x) => x.id === assetId)
  if (!a || !wantsProxy(a) || inflight.has(a.id)) return
  build(a, true) // first: it marks the asset in flight, so the store change below queues no second build
  if (a.proxyPath) useEditor.getState().updateAsset(a.id, { proxyPath: undefined })
}

function build(a: MediaAsset, rebuild = false) {
  inflight.add(a.id)
  useProxyProgress.setState((s) => ({ jobs: { ...s.jobs, [a.id]: 0 } }))
  ;(async () => {
    // assets saved before codec/hasAlpha existed: re-probe once so alpha
    // sources stop getting (and keeping) an H.264 proxy that bakes the
    // transparency into a solid background
    let { codec, hasAlpha } = a
    if (a.kind === 'video' && codec === undefined) {
      const fresh = (await window.kadr.probeMedia(a.path)).asset
      codec = fresh.codec
      hasAlpha = fresh.hasAlpha
      useEditor.getState().updateAsset(a.id, { codec, hasAlpha: !!hasAlpha })
    }
    return window.kadr.requestProxy(a.path, a.duration, { alpha: !!hasAlpha, codec, rebuild })
  })()
    .then((proxyPath) => {
      const cur = useEditor.getState().project.assets.find((x) => x.id === a.id)
      if (cur && cur.proxyPath !== proxyPath) {
        useEditor.getState().updateAsset(a.id, { proxyPath })
      }
    })
    .catch(() => { /* preview keeps decoding the original */ })
    .finally(() => {
      inflight.delete(a.id)
      useProxyProgress.setState((s) => {
        const jobs = { ...s.jobs }
        delete jobs[a.id]
        return { jobs }
      })
    })
}

let wired = false

/** Subscribe once: new assets (import or project open) get proxies queued. */
export function wireProxies() {
  if (wired) return
  wired = true
  const sync = () => {
    const on = setting('playback.proxies') === true
    if (on !== previewPrefs.proxies) { previewPrefs.proxies = on; ensureProxies() }
  }
  sync()
  useSettings.subscribe(sync)
  window.kadr.onProxyProgress(({ path, progress }) => {
    const a = useEditor.getState().project.assets.find((x) => x.path === path)
    if (a && inflight.has(a.id)) {
      useProxyProgress.setState((s) => ({ jobs: { ...s.jobs, [a.id]: progress } }))
    }
  })
  let lastAssets: unknown = null
  useEditor.subscribe((s) => {
    if (s.project.assets !== lastAssets) {
      lastAssets = s.project.assets
      ensureProxies()
    }
  })
  ensureProxies()
}
