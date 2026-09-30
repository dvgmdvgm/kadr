import { useEffect, useRef, useState } from 'react'
import type { Clip } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { usePopout } from '@/engine/popout'
import { clipGeom } from '@/engine/player'
import { layerQuad, type LayerGeom } from '@/gl/compositor'
import { getTextLayer } from '@/engine/text'
import { useT } from '@/i18n'
import { applyValue, KF_EPS, knobAt } from './animUtils'

type Key = 'x' | 'y' | 'scale' | 'rotation'
type Pt = { x: number; y: number }

const TILT = 1e-3
const tilted = (g: LayerGeom) =>
  Math.abs(g.rotX ?? 0) > TILT || Math.abs(g.rotY ?? 0) > TILT ||
  (!!g.outer && (Math.abs(g.outer.rotX) > TILT || Math.abs(g.outer.rotY) > TILT))

/**
 * Mouse control for the selected visual clip (footage, image, text, fragment)
 * in the preview: drag the box to move it, drag the corner handle or scroll
 * the wheel to scale, drag the handle above it to rotate (Shift: 15° steps).
 * The box is the compositor's own geometry (`layerQuad`), so it sits on the
 * picture at any fit, rotation and track motion; a tilted 3D layer shows its
 * projected outline and no rotate handle. Writes like the animation editor:
 * a keyframed parameter, or any with «Привязка к таймлайну» on, gets a key at
 * the playhead. One undo step per gesture.
 */
export function ClipGizmo({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const t = useT()
  // the preview may be detached into a window of its own — see the observer below
  const popped = usePopout((s) => s.win)
  const selId = useEditor((s) => s.selection[0])
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  // the canvas box, and the preview area around it (`pv`, in the box's own
  // coordinates) that nothing of the gizmo may paint outside
  const [rect, setRect] = useState<{
    left: number; top: number; w: number; h: number
    pv: { left: number; top: number; right: number; bottom: number }
  } | null>(null)
  const gesture = useRef<{
    kind: 'move' | 'scale' | 'rotate'
    x0: number
    y0: number
    base: Record<Key, number>
    /** screen px → clip x/y (inverse Jacobian of the box centre) */
    inv: [number, number, number, number]
    c: Pt
    d0: number
    a0: number
    pushed: boolean
  } | null>(null)
  const lastWheel = useRef(0)

  let found: { clip: Clip; geom: LayerGeom } | null = null
  if (selId) {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selId)
      if (!clip) continue
      if (track.kind === 'video' && !track.locked && !clip.disabled &&
          playhead >= clip.start - 1e-9 && playhead < clip.start + clip.duration) {
        const geom = clipGeom(project, track, clip, playhead)
        if (geom) found = { clip, geom }
      }
      break
    }
  }
  const active = !!found

  useEffect(() => {
    const el = canvas.current
    if (!el || !active) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement!.getBoundingClientRect()
      const a = (el.closest('.preview') ?? el.parentElement!).getBoundingClientRect()
      setRect({
        left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height,
        pv: { left: a.left - c.left, top: a.top - c.top, right: a.right - c.left, bottom: a.bottom - c.top }
      })
    }
    measure()
    // created in the window the canvas is in, and rebuilt when the preview
    // moves to another one — see the same note in FragmentOverlays
    const win = el.ownerDocument.defaultView ?? window
    let raf = 0
    const ro = new win.ResizeObserver(() => {
      win.cancelAnimationFrame(raf)
      raf = win.requestAnimationFrame(measure)
    })
    ro.observe(el)
    return () => {
      try { win.cancelAnimationFrame(raf) } catch { /* window gone */ }
      ro.disconnect()
    }
  }, [canvas, active, popped])

  if (!found || !rect) return null
  const { clip, geom } = found
  const W = project.width
  const H = project.height
  const disp = rect.w / Math.max(1, W)
  // a text layer is project-sized: frame the block that is actually drawn
  const sub = clip.kind === 'text' && clip.textStyle
    ? getTextLayer(clip.id, clip.text ?? '', clip.textStyle, W, H).ink
    : undefined
  const quadOf = (g: LayerGeom) => layerQuad(g, W, H, sub).map((q) => ({ x: q.sx * disp, y: q.sy * disp }))
  const centreOf = (q: Pt[]) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 })
  // TL, BL, TR, BR → outline order TL, TR, BR, BL
  const q = quadOf(geom)
  const outline = [q[0], q[2], q[3], q[1]]
  const c = centreOf(q)
  const flat = !tilted(geom)
  // the knob sits over the picture's top as placed, not the source's (a flipY moves that to the bottom)
  const qt = geom.flipY ? quadOf({ ...geom, flipY: false }) : q
  const topMid = { x: (qt[0].x + qt[2].x) / 2, y: (qt[0].y + qt[2].y) / 2 }
  // above the box, or inside it when the box fills the preview (card F1f)
  const rot = knobAt(topMid, c, rect.pv)

  let rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  // land exactly on the clip edges, as the animation editor does
  if (rel < KF_EPS) rel = 0
  else if (clip.duration - rel < KF_EPS) rel = clip.duration

  const st = () => useEditor.getState()
  const write = (vals: Partial<Record<Key, number>>) => {
    const s = st()
    const cur = s.project.tracks.flatMap((tr) => tr.clips).find((cc) => cc.id === clip.id)
    if (!cur) return
    const transform = { ...cur.transform }
    for (const k of Object.keys(vals) as Key[]) {
      transform[k] = applyValue(transform[k], rel, vals[k]!, s.animLinked)
    }
    s.updateClip(cur.id, { transform })
  }
  const pushOnce = () => {
    const s = st()
    const keyed = (['x', 'y', 'scale', 'rotation'] as Key[]).some((k) => clip.transform[k].keyframes?.length)
    s.pushHistory(s.animLinked || keyed ? 'hKeyframe' : 'hEdit')
  }

  const begin = (kind: 'move' | 'scale' | 'rotate') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const host = (e.currentTarget as Element).closest('.clip-gizmo')!.getBoundingClientRect()
    const base = {
      x: evalAnim(clip.transform.x, rel),
      y: evalAnim(clip.transform.y, rel),
      scale: evalAnim(clip.transform.scale, rel),
      rotation: evalAnim(clip.transform.rotation, rel)
    }
    // how the box centre moves per unit of x and y (track motion scales and
    // turns it, perspective shrinks it) — inverted, it maps the hand to x/y
    const cx = centreOf(quadOf({ ...geom, x: geom.x + 1 }))
    const cy = centreOf(quadOf({ ...geom, y: geom.y + 1 }))
    const a = cx.x - c.x, b = cy.x - c.x, cc = cx.y - c.y, d = cy.y - c.y
    const det = a * d - b * cc || 1
    const centre = { x: host.left + c.x, y: host.top + c.y }
    gesture.current = {
      kind,
      x0: e.clientX,
      y0: e.clientY,
      base,
      inv: [d / det, -b / det, -cc / det, a / det],
      c: centre,
      d0: Math.max(4, Math.hypot(e.clientX - centre.x, e.clientY - centre.y)),
      a0: Math.atan2(e.clientY - centre.y, e.clientX - centre.x),
      pushed: false
    }
  }
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    if (!g.pushed) {
      pushOnce()
      g.pushed = true
    }
    if (g.kind === 'move') {
      const dx = e.clientX - g.x0
      const dy = e.clientY - g.y0
      write({ x: g.base.x + g.inv[0] * dx + g.inv[1] * dy, y: g.base.y + g.inv[2] * dx + g.inv[3] * dy })
    } else if (g.kind === 'scale') {
      // corner drag: scale around the centre, keep proportions
      const d1 = Math.max(4, Math.hypot(e.clientX - g.c.x, e.clientY - g.c.y))
      write({ scale: Math.min(20, Math.max(0.05, g.base.scale * (d1 / g.d0))) })
    } else {
      const a1 = Math.atan2(e.clientY - g.c.y, e.clientX - g.c.x)
      let r = g.base.rotation + ((a1 - g.a0) * 180) / Math.PI
      if (e.shiftKey) r = Math.round(r / 15) * 15
      write({ rotation: r })
    }
  }
  const onUp = () => {
    gesture.current = null
  }
  const onWheel = (e: React.WheelEvent) => {
    // a burst of wheel ticks is one gesture, one undo step
    if (e.timeStamp - lastWheel.current > 500) pushOnce()
    lastWheel.current = e.timeStamp
    const s0 = evalAnim(clip.transform.scale, rel)
    write({ scale: Math.min(20, Math.max(0.05, s0 * Math.pow(1.05, -e.deltaY / 100))) })
  }
  const on = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp }

  return (
    <div
      className={`clip-gizmo${clip.kind === 'remotion' ? ' fragment' : ''}`}
      style={{
        left: rect.left, top: rect.top, width: rect.w, height: rect.h,
        // a box scaled past the preview is cut at its edge, not drawn over the top bar
        clipPath: `inset(${rect.pv.top}px ${rect.w - rect.pv.right}px ${rect.h - rect.pv.bottom}px ${rect.pv.left}px)`
      }}
    >
      <svg width={rect.w} height={rect.h}>
        <polygon
          data-act="gizmo-box"
          points={outline.map((p) => `${p.x},${p.y}`).join(' ')}
          onPointerDown={begin('move')}
          onWheel={onWheel}
          {...on}
        >
          <title>{t('gizmoHint')}</title>
        </polygon>
        {flat && <line x1={topMid.x} y1={topMid.y} x2={rot.x} y2={rot.y} />}
      </svg>
      <div
        className="clip-gizmo-handle"
        data-act="gizmo-scale"
        style={{ left: q[3].x, top: q[3].y }}
        onPointerDown={begin('scale')}
        {...on}
      />
      {flat && (
        <div
          className="clip-gizmo-handle rotate"
          data-act="gizmo-rotate"
          style={{ left: rot.x, top: rot.y }}
          onPointerDown={begin('rotate')}
          {...on}
        />
      )}
    </div>
  )
}
