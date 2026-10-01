// J8: the scopes, landed from canvas J (design-source/canvas/J, RULES 2–3,
// 18–22): a «Скопы» tab of the side panel and a window of its own. They read
// the frame the preview drew at the playhead — after colour, before «До и
// после» draws over it — as a small downscale the Player hands over
// (`subscribeScopes`), and count it with `shared/scopes.ts`. Traces are density
// plots in the system's tokens, drawn on 2D canvases sized to their boxes.
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useT, type TKey } from '@/i18n'
import { useEditor, useSettings } from '@/state/store'
import { scopeTap, subscribeScopes, videoLayersAt } from '@/engine/player'
import { fragmentNeedsCapture } from '@/engine/fragmentCapture'
import { useColourUi } from '@/engine/colourUi'
import { scopesPopout } from '@/engine/popout'
import { formatTime } from '@/engine/timelineMath'
import { token } from '@/theme'
import { Icon } from './icons'
import {
  SCOPE_KINDS, type ScopeKind, waveGrid, vectorGrid, histogram, VECTOR_TARGETS, SKIN_ANGLE
} from '@shared/scopes'
import type { Project } from '@shared/types'

const KINDS_KEY = 'kadr.scopes'
const LABEL: Record<ScopeKind, TKey> = { wave: 'scWave', parade: 'scParade', vector: 'scVector', hist: 'scHist' }

/** which scopes the panel shows — at most two, a third turns off the earliest (RULES 18) */
export const useScopesUi = create<{ kinds: ScopeKind[]; toggle(k: ScopeKind): void }>((set, get) => ({
  kinds: (() => {
    try {
      const v = JSON.parse(localStorage.getItem(KINDS_KEY) ?? 'null')
      if (Array.isArray(v) && v.every((k) => SCOPE_KINDS.includes(k))) return v.slice(0, 2)
    } catch { /* a view preference */ }
    return ['wave', 'vector']
  })(),
  toggle: (k) => {
    const cur = get().kinds
    const kinds = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k].slice(-2)
    try { localStorage.setItem(KINDS_KEY, JSON.stringify(kinds)) } catch { /* a view preference */ }
    set({ kinds })
  }
}))

/** what is under the playhead for the scopes: a GL picture, only iframe fragments, or nothing */
function pictureAt(p: Project, t: number): 'pic' | 'pic-nofrag' | 'frag' | 'none' {
  const ls = videoLayersAt(p, t)
  if (!ls.length) return 'none'
  const iframes = ls.filter((l) => l.clip.kind === 'remotion' && !fragmentNeedsCapture(l.track, l.clip, p)).length
  return iframes === ls.length ? 'frag' : iframes ? 'pic-nofrag' : 'pic'
}

export function ScopesPanel({ inWindow = false }: { inWindow?: boolean }) {
  const t = useT()
  const kinds = useScopesUi((s) => s.kinds)
  const toggle = useScopesUi((s) => s.toggle)
  const shown = inWindow ? SCOPE_KINDS : kinds
  const pic = useEditor((s) => pictureAt(s.project, s.playhead))
  const fps = useEditor((s) => s.project.fps)
  // not while playing: the foot then follows the frames read (≤ 15 a second), not every tick
  const playhead = useEditor((s) => (s.playing ? -1 : s.playhead))
  const compare = useColourUi((s) => s.compare)
  const quality = useSettings((s) => s.effective('playback.previewQuality').value) as string
  const [frameT, setFrameT] = useState<number | null>(null)
  const boxes = useRef(new Map<ScopeKind, HTMLDivElement>())

  useEffect(() => {
    const draw = () => {
      const f = scopeTap.frame
      if (!f) return
      setFrameT(f.t)
      for (const [k, box] of boxes.current) drawScope(k, box, f.px, f.w, f.h)
    }
    const off = subscribeScopes(draw)
    return off
  }, [])
  // a scope that appears (a toggle, the window's 2×2) draws the last frame at once
  useEffect(() => {
    const f = scopeTap.frame
    if (f) for (const [k, box] of boxes.current) drawScope(k, box, f.px, f.w, f.h)
  }, [shown.join(), pic])

  const empty = pic === 'none' || pic === 'frag'
  const foot = t('scFoot').replace('{t}', formatTime(playhead >= 0 ? playhead : frameT ?? 0, fps || 30)) +
    (empty ? '' : (compare ? t('scFootCompare') : t('scFootColour')) +
      (quality === 'half' || quality === 'quarter' ? t('scFootQuality').replace('{q}', quality === 'half' ? '½' : '¼') : '') +
      (pic === 'pic-nofrag' ? t('scFootNoFrag') : '') +
      (inWindow ? t('scFootRate') : ''))
  const box = (k: ScopeKind) => (
    <div key={k} className="sc-box" data-scope={k} ref={(el) => { if (el) boxes.current.set(k, el); else boxes.current.delete(k) }}>
      <canvas aria-hidden="true" />
      {k === 'vector'
        ? <span className="sc-label" title={t('scVectorTitle')}>{t('scVectorLabel')}</span>
        : <span className="sc-label">{t(k === 'wave' ? 'scWaveLabel' : k === 'parade' ? 'scParadeLabel' : 'scHistLabel')}</span>}
      {(k === 'wave' || k === 'parade') && [100, 75, 50, 25, 0].map((v) => (
        <span key={v} className="sc-tick" style={{ right: 3, top: `calc(${100 - v}% - ${v === 100 ? 0 : v === 0 ? 11 : 5}px)` }}>{v}</span>
      ))}
      {k === 'hist' && <><span className="sc-tick" style={{ left: 3, bottom: 3 }}>0</span><span className="sc-tick" style={{ right: 3, bottom: 3 }}>255</span></>}
    </div>
  )

  return (
    <div className="sc-panel" data-act="scopes">
      <div className="panel-head">
        <span>{inWindow ? t('scPopTitle') : t('scTab')}</span>
        <button className="ghost icon-only" data-act={inWindow ? 'scopes-popin' : 'scopes-popout'}
          title={t(inWindow ? 'scPopin' : 'scPopout')} aria-label={t(inWindow ? 'scPopin' : 'scPopout')}
          onClick={() => (inWindow ? scopesPopout.dock() : scopesPopout.open())}>
          <Icon name={inWindow ? 'popin' : 'popout'} size={14} />
        </button>
      </div>
      {!inWindow && (
        <div className="sc-tools">
          {SCOPE_KINDS.map((k) => (
            <button key={k} className={kinds.includes(k) ? 'ghost toggled' : 'ghost'} aria-pressed={kinds.includes(k)}
              data-act={`scope-${k}`} onClick={() => toggle(k)}>{t(LABEL[k])}</button>
          ))}
        </div>
      )}
      {empty ? (
        <div className="sc-empty">
          <b>{t(pic === 'frag' ? 'scFragHead' : 'scEmptyHead')}</b>
          <span>{t(pic === 'frag' ? 'scFragBody' : 'scEmptyBody')}</span>
        </div>
      ) : (
        <div className={inWindow ? 'sc-grid' : 'sc-stack'}>{shown.map(box)}</div>
      )}
      <div className="sc-foot">{foot}</div>
    </div>
  )
}

// ---- drawing ---------------------------------------------------------------

const rgbCache = new Map<string, [number, number, number, number]>()
/** a colour token as r, g, b (0…255) and alpha (0…1) */
function rgbOf(name: string): [number, number, number, number] {
  const hit = rgbCache.get(name)
  if (hit) return hit
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = token(name)
  const s = String(ctx.fillStyle)
  const m = s.startsWith('#')
    ? [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1]
    : (s.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number)
  const v: [number, number, number, number] = [m[0], m[1], m[2], m[3] ?? 1]
  rgbCache.set(name, v)
  return v
}

/** a density grid (cols × rows, row 0 at the top) painted into ctx at (x, y): log-scaled alpha */
function paintDensity(ctx: CanvasRenderingContext2D, grid: Uint32Array, cols: number, rows: number, x: number, y: number, colour: string) {
  let max = 0
  for (const v of grid) if (v > max) max = v
  if (!max) return
  const [r, g, b, a] = rgbOf(colour)
  const img = ctx.createImageData(cols, rows)
  const lm = Math.log1p(max)
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]
    if (!v) continue
    const o = i * 4
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b
    img.data[o + 3] = 255 * a * (0.2 + 0.8 * Math.log1p(v) / lm)
  }
  // putImageData ignores compositing: go through a scratch canvas so the graticule stays under
  const tmp = new OffscreenCanvas(cols, rows)
  tmp.getContext('2d')!.putImageData(img, 0, 0)
  ctx.drawImage(tmp, x, y)
}

function hLines(ctx: CanvasRenderingContext2D, x: number, w: number, h: number) {
  ctx.strokeStyle = token('--c-line-2')
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round((1 - v) * (h - 1)) + 0.5
    ctx.moveTo(x, y); ctx.lineTo(x + w, y)
  }
  ctx.stroke()
}

function drawScope(kind: ScopeKind, box: HTMLDivElement, px: Uint8Array, w: number, h: number) {
  const canvas = box.querySelector('canvas')
  if (!canvas) return
  const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1
  const cw = Math.round(box.clientWidth * dpr), ch = Math.round(box.clientHeight * dpr)
  if (cw < 4 || ch < 4) return
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, cw, ch)
  if (kind === 'wave') {
    hLines(ctx, 0, cw, ch)
    paintDensity(ctx, waveGrid(px, w, h, 'y', cw, ch), cw, ch, 0, 0, '--c-wave-rms')
  } else if (kind === 'parade') {
    hLines(ctx, 0, cw, ch)
    const gap = Math.round(2 * dpr), pw = Math.floor((cw - 2 * gap) / 3)
    ;(['r', 'g', 'b'] as const).forEach((c, i) =>
      paintDensity(ctx, waveGrid(px, w, h, c, pw, ch), pw, ch, i * (pw + gap), 0, c === 'r' ? '--c-danger' : c === 'g' ? '--c-ok' : '--c-accent'))
  } else if (kind === 'vector') {
    const n = Math.min(cw, ch), x0 = Math.floor((cw - n) / 2), y0 = Math.floor((ch - n) / 2)
    const cx = x0 + n / 2, cy = y0 + n / 2, R = n * 0.45
    ctx.strokeStyle = token('--c-line-2')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy)
    ctx.stroke()
    // the 75 % bar targets and their names
    ctx.font = `${Math.round((parseFloat(token('--fz-micro')) || 10) * dpr)}px ${token('--font-mono') || 'monospace'}`
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = token('--c-text-3')
    ctx.fillStyle = token('--c-text-3')
    const s = Math.max(4, n * 0.05)
    for (const tg of VECTOR_TARGETS) {
      const tx = x0 + tg.x / 100 * n, ty = y0 + tg.y / 100 * n
      ctx.strokeRect(tx - s / 2, ty - s / 2, s, s)
      const out = Math.hypot(tx - cx, ty - cy) || 1
      ctx.textAlign = tx < cx ? 'right' : 'left'
      ctx.fillText(tg.name, tx + (tx - cx) / out * s * 1.6 + (tx < cx ? -2 : 2), ty + (ty - cy) / out * s * 1.2)
    }
    // the skin-tone line, dashed
    ctx.strokeStyle = token('--c-mask')
    ctx.setLineDash([3 * dpr, 3 * dpr])
    ctx.beginPath()
    ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(SKIN_ANGLE), cy - R * Math.sin(SKIN_ANGLE))
    ctx.stroke()
    ctx.setLineDash([])
    paintDensity(ctx, vectorGrid(px, w, h, n), n, n, x0, y0, '--c-wave-rms')
  } else {
    // three overlaid RGB histograms, √ count so a flat field does not flatten the rest
    const hs = histogram(px, w, h)
    let max = 0
    for (const a of [hs.r, hs.g, hs.b]) for (const v of a) max = Math.max(max, Math.sqrt(v))
    ctx.strokeStyle = token('--c-line-2')
    ctx.beginPath()
    for (const v of [0.25, 0.5, 0.75]) { const x = Math.round(v * cw) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ch) }
    ctx.stroke()
    if (!max) return
    for (const [a, tok] of [[hs.r, '--c-danger'], [hs.g, '--c-ok'], [hs.b, '--c-accent']] as const) {
      ctx.beginPath()
      ctx.moveTo(0, ch)
      for (let i = 0; i < 256; i++) {
        const y = ch - Math.sqrt(a[i]) / max * ch * 0.92
        ctx.lineTo(i / 256 * cw, y); ctx.lineTo((i + 1) / 256 * cw, y)
      }
      ctx.lineTo(cw, ch)
      ctx.closePath()
      ctx.fillStyle = token(tok)
      ctx.globalAlpha = 0.3
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = token(tok)
      ctx.stroke()
    }
  }
}

/** the side panel's tab body: the docked panel's slot, or a word that it is in its window */
export function ScopesTab() {
  const t = useT()
  const win = scopesPopout.use((s) => s.win)
  if (win) {
    return (
      <div className="preview-detached">
        <Icon name="popout" size={30} />
        <span>{t('scPopout')}</span>
        <button onClick={() => scopesPopout.dock()} data-act="scopes-popin">
          <Icon name="popin" /> {t('scPopin')}
        </button>
      </div>
    )
  }
  return <div className="sc-slot" ref={scopesPopout.setSlot} />
}
