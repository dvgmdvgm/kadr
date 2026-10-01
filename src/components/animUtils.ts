// Keyframe helpers shared by the clip animation editor and track motion.
import type { Anim, Easing, Keyframe } from '@shared/types'
import { evalAnim } from '@/engine/anim'

export const KF_EPS = 0.02

export function sortedKfs(a: Anim): Keyframe[] {
  return [...(a.keyframes ?? [])].sort((x, y) => x.time - y.time)
}

export function upsertKf(a: Anim, time: number, value: number, easing: Easing = 'linear'): Anim {
  const existing = a.keyframes?.find((k) => Math.abs(k.time - time) < KF_EPS)
  const kfs = sortedKfs(a).filter((k) => Math.abs(k.time - time) >= KF_EPS)
  kfs.push({ time, value, easing: existing?.easing ?? easing })
  kfs.sort((x, y) => x.time - y.time)
  return { ...a, keyframes: kfs }
}

const atAny = (t: number, times: number[]) => times.some((x) => Math.abs(x - t) < KF_EPS)

/** Give every key at one of `times` this easing (it shapes the segment the key starts). */
export function setKfEasing(a: Anim, times: number[], easing: Easing): Anim {
  if (!a.keyframes?.some((k) => atAny(k.time, times))) return a
  return { ...a, keyframes: a.keyframes.map((k) => (atAny(k.time, times) ? { ...k, easing } : k)) }
}

/** The easing of the first key found at `time`, for the menu's check mark. */
export function kfEasingAt(anims: Anim[], time: number): Easing | undefined {
  for (const a of anims) {
    const k = a.keyframes?.find((kf) => Math.abs(kf.time - time) < KF_EPS)
    if (k) return k.easing
  }
  return undefined
}

/**
 * Apply a new value. A parameter that already has keyframes always records a
 * state at the given time; `linked` controls whether static params start
 * recording too.
 */
export function applyValue(anim: Anim, rel: number, value: number, linked: boolean): Anim {
  if (anim.keyframes?.length || linked) return upsertKf(anim, rel, value)
  return { ...anim, value }
}

/** Reset helper: keyframed params get a default keyframe, static ones reset. */
export function resetValue(anim: Anim, rel: number, def: number): Anim {
  return anim.keyframes?.length ? upsertKf(anim, rel, def) : { ...anim, value: def }
}

// ---- K1: the clip's level line (gain for audio, opacity for video) takes
// points; they are the Anim's keys, at clip-local times.

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** The level line's box on screen: the clip's rect, the band the line moves in. */
export interface LevelLine { left: number; top: number; width: number; duration: number; pad: number; usable: number; max: number }

/** Clip-local time and level under the pointer. */
export function levelAt(l: LevelLine, x: number, y: number): { t: number; v: number } {
  return {
    t: clamp(((x - l.left) / l.width) * l.duration, 0, l.duration),
    v: clamp((1 - (y - l.top - l.pad) / l.usable) * l.max, 0, l.max)
  }
}

/** A point on the line at `t`, at the level the line has there. */
export function addLevelPoint(a: Anim, t: number): Anim {
  return upsertKf(a, t, evalAnim(a, t))
}

/** Move key `i`; it stays between its neighbours and inside the clip.
    `keepLevel` (Shift) moves it along the time axis only. */
export function moveLevelPoint(a: Anim, i: number, t: number, v: number,
  o: { duration: number; max: number; keepLevel?: boolean }): Anim {
  const kfs = sortedKfs(a)
  const lo = i > 0 ? kfs[i - 1].time + KF_EPS : 0
  const hi = i < kfs.length - 1 ? kfs[i + 1].time - KF_EPS : o.duration
  kfs[i] = { ...kfs[i], time: clamp(t, lo, Math.max(lo, hi)), value: o.keepLevel ? kfs[i].value : clamp(v, 0, o.max) }
  return { ...a, keyframes: kfs }
}

/** Remove key `i`; the last one leaves a flat level at its value. */
export function deleteLevelPoint(a: Anim, i: number): Anim {
  const kfs = sortedKfs(a)
  const [gone] = kfs.splice(i, 1)
  if (kfs.length) return { ...a, keyframes: kfs }
  const { keyframes: _, ...rest } = a
  return { ...rest, value: gone?.value ?? a.value }
}

/** The line itself dragged: every point (or the flat level) moves by `dv`. */
export function shiftLevel(a: Anim, dv: number, max: number): Anim {
  if (!a.keyframes?.length) return { ...a, value: clamp(a.value + dv, 0, max) }
  return { ...a, keyframes: a.keyframes.map((k) => ({ ...k, value: clamp(k.value + dv, 0, max) })) }
}

export function snap1(v: number, targets: number[], tol: number): number {
  let best = v
  let bd = tol
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best
}

export function windowDrag(
  e: { clientX: number; clientY: number },
  move: (dx: number, dy: number, ev: PointerEvent) => void,
  done?: (moved: boolean) => void
) {
  const sx = e.clientX
  const sy = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true
    move(ev.clientX - sx, ev.clientY - sy, ev)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    done?.(moved)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

export { evalAnim }

type P = { x: number; y: number }
/**
 * Where the gizmo's rotate knob goes: `gap` px beyond the box's top edge, away
 * from its centre — or as far inside when that would leave the preview
 * (`bounds`, in the gizmo's coordinates; `r` keeps the whole knob in), and
 * clamped into it when neither fits, so the knob is always there to grab.
 */
export function knobAt(topMid: P, c: P, bounds: { left: number; top: number; right: number; bottom: number }, gap = 22, r = 9): P {
  const up = Math.hypot(topMid.x - c.x, topMid.y - c.y) || 1
  const at = (d: number) => ({ x: topMid.x + ((topMid.x - c.x) / up) * d, y: topMid.y + ((topMid.y - c.y) / up) * d })
  const fits = (p: P) => p.x >= bounds.left + r && p.x <= bounds.right - r && p.y >= bounds.top + r && p.y <= bounds.bottom - r
  const out = at(gap)
  if (fits(out)) return out
  const inn = at(-gap)
  if (fits(inn)) return inn
  return {
    x: Math.min(bounds.right - r, Math.max(bounds.left + r, out.x)),
    y: Math.min(bounds.bottom - r, Math.max(bounds.top + r, out.y))
  }
}
