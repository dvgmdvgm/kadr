// L3: a clip's speed as a curve over clip time (`Clip.speedRamp`, absolute
// speeds; `Clip.speed` stays the base the presets are drawn from). The source
// runs at the INTEGRAL of the speed, and every consumer that turns a clip-local
// second into a source second — the preview, the export's frames and frame
// signature, the demux reads behind them, the audio chunks, markers, trims and
// splits — goes through `sourceOffset`, so no two of them can disagree.
// Without a ramp everything is the old `rel × speed`, to the bit.
// Pure; tested by scripts/check-speed-ramp.mjs.
import type { Anim, Clip, Easing } from './types'
import { evalAnim } from './anim'

/** = speedLayout's SPEED_MIN / SPEED_MAX: a ramp never stops or reverses the source */
export const RAMP_MIN = 0.02
export const RAMP_MAX = 100

type Sped = Pick<Clip, 'speed' | 'speedRamp'>

const clamp = (v: number) => Math.min(RAMP_MAX, Math.max(RAMP_MIN, Number.isFinite(v) ? v : 1))

export const hasRamp = (c: Sped): boolean => !!c.speedRamp?.keyframes?.length

/** The speed at clip-local `rel` — the instantaneous playback rate. */
export function speedAt(c: Sped, rel: number): number {
  return hasRamp(c) ? clamp(evalAnim(c.speedRamp, rel)) : c.speed || 1
}

// Simpson per key segment, 64 panels: exact for linear / easeIn / easeOut and
// for the halves of easeInOut (the midpoint is a panel edge), within 1e-9 s of
// the smooth curves. A segment's end is sampled just inside it, so a hold key
// integrates as the step it is.
const PANELS = 64
function simpson(a: Anim, x0: number, x1: number): number {
  if (!(x1 > x0)) return 0
  const h = (x1 - x0) / PANELS
  const end = x1 - (x1 - x0) * 1e-9
  let s = clamp(evalAnim(a, x0)) + clamp(evalAnim(a, end))
  for (let i = 1; i < PANELS; i++) s += (i % 2 ? 4 : 2) * clamp(evalAnim(a, x0 + i * h))
  return (s * h) / 3
}

/** the integral up to each key, from the first; cached per (immutable) Anim */
const cums = new WeakMap<Anim, number[]>()
function cumOf(a: Anim): number[] {
  let c = cums.get(a)
  if (!c) {
    const k = a.keyframes!
    c = [0]
    for (let i = 1; i < k.length; i++) c.push(c[i - 1] + simpson(a, k[i - 1].time, k[i].time))
    cums.set(a, c)
  }
  return c
}

/** antiderivative of the ramp, 0 at its first key; constant speed outside the keys */
function G(a: Anim, t: number): number {
  const k = a.keyframes!
  const c = cumOf(a)
  if (t <= k[0].time) return clamp(k[0].value) * (t - k[0].time)
  const n = k.length - 1
  if (t >= k[n].time) return c[n] + clamp(k[n].value) * (t - k[n].time)
  let i = 0
  while (k[i + 1].time <= t) i++
  return c[i] + simpson(a, k[i].time, t)
}

/** Source seconds the clip has advanced at clip-local `rel` (from its in point, before any loop). */
export function sourceOffset(c: Sped, rel: number): number {
  if (!hasRamp(c)) return rel * (c.speed || 1)
  return G(c.speedRamp!, rel) - G(c.speedRamp!, 0)
}

/** The inverse: the clip-local second at which the source has advanced `off`. */
export function relAtOffset(c: Sped, off: number): number {
  if (!hasRamp(c)) return off / (c.speed || 1)
  const a = c.speedRamp!
  const k = a.keyframes!
  const want = off + G(a, 0)
  const c0 = cumOf(a)
  const n = k.length - 1
  if (want <= 0) return k[0].time + want / clamp(k[0].value)
  if (want >= c0[n]) return k[n].time + (want - c0[n]) / clamp(k[n].value)
  let i = 0
  while (c0[i + 1] <= want) i++
  let lo = k[i].time
  let hi = k[i + 1].time
  for (let j = 0; j < 60 && hi - lo > 1e-12; j++) {
    const mid = (lo + hi) / 2
    if (c0[i] + simpson(a, k[i].time, mid) < want) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Scale a ramp's speeds by `r` (a speed change of the whole clip; its times
    are rescaled with the clip's other keys by rescaleClipAnims). */
export function scaleRampValues(c: Clip, r: number) {
  const a = c.speedRamp
  if (!a?.keyframes?.length) return
  c.speedRamp = { ...a, value: clamp(a.value * r), keyframes: a.keyframes.map((k) => ({ ...k, value: clamp(k.value * r) })) }
}

export type RampPreset = 'up' | 'down' | 'peak' | 'dip'
export const RAMP_PRESETS: RampPreset[] = ['up', 'down', 'peak', 'dip']

/** speed multipliers of the base at fractions of the clip */
const SHAPES: Record<RampPreset, Array<[number, number]>> = {
  up: [[0, 1], [1, 4]],
  down: [[0, 4], [1, 1]],
  peak: [[0, 1], [0.5, 4], [1, 1]],
  dip: [[0, 1], [0.5, 0.25], [1, 1]]
}

/** A preset drawn over a clip of `duration` timeline seconds at `base` speed. */
export function rampAnim(preset: RampPreset, base: number, duration: number): Anim {
  const easing: Easing = 'easeInOut'
  const keyframes = SHAPES[preset].map(([f, m]) => ({ time: f * duration, value: clamp(base * m), easing }))
  return { value: keyframes[0].value, keyframes }
}

/** The mean speed of a preset — a clip covering `span` source seconds with it
    lasts span / mean (the integral is linear in the duration). */
export function rampMean(preset: RampPreset, base: number): number {
  return sourceOffset({ speed: base, speedRamp: rampAnim(preset, base, 1) }, 1)
}

/** Which preset a clip's ramp is (for the menu's highlight); null = none or hand-drawn. */
export function rampPresetOf(c: Pick<Clip, 'speed' | 'speedRamp' | 'duration'>): RampPreset | null {
  const k = c.speedRamp?.keyframes
  if (!k?.length) return null
  return RAMP_PRESETS.find((p) => {
    const want = rampAnim(p, c.speed || 1, c.duration).keyframes!
    return want.length === k.length && want.every((w, i) =>
      Math.abs(w.time - k[i].time) < 1e-6 && Math.abs(w.value - k[i].value) < 1e-9 && w.easing === k[i].easing)
  }) ?? null
}
