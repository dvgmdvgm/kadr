// J7: lift/gamma/gain wheels and Y/R/G/B curves — the reference maths, the bake
// and the GLSL in one file (`scripts/check-curves.mjs` renders the GLSL and
// compares). Both are per-channel functions of the colour the clip shows
// (display-referred, encoded 0…1, after the J1 grade), so together they bake
// into ONE 1D table per clip, rebuilt only when they change; the shader samples
// it like a 1D .cube (J2's sampling), between the grade and the LUT.
//
// Wheels (ASC-CDL-like, per channel): out = (gain·(x + lift·(1 − x)))^(2^−gamma),
// so lift moves black and pins white, gain scales white and pins black, gamma
// bends the mids and pins both. Each wheel is a puck (x right, y DOWN — screen
// coordinates, unit disc) plus a level −1…1; the puck adds a zero-sum shift
// along the hue it points at: red at 0°, yellow 60°, green 120°, cyan 180°,
// blue 240°, magenta 300°, clockwise on screen.
// Curves: monotone cubic (Fritsch–Carlson tangents, d3's monotoneX) through the
// user's points, with (0,0) and (1,1) added unless a point sits at that end —
// no overshoot, and a non-monotone curve peaks AT its point. Y applies to all
// three channels, then the channel's own curve.

import type { CubeLut } from './lut'

export const WHEEL_KEYS = ['lift', 'gamma', 'gain'] as const
export type WheelKey = (typeof WHEEL_KEYS)[number]
export interface Wheel { x: number; y: number; level: number }
export type ClipWheels = Record<WheelKey, Wheel>
export const CURVE_CHS = ['y', 'r', 'g', 'b'] as const
export type CurveCh = (typeof CURVE_CHS)[number]
export type CurvePoint = [number, number]
/** a channel absent or empty = identity */
export type ClipCurves = Partial<Record<CurveCh, CurvePoint[]>>

/** how far a puck on the rim moves a channel, in level units */
const SHIFT = 0.5
const PHASE = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const wheelIsNeutral = (w?: Wheel) => !w || (w.x === 0 && w.y === 0 && w.level === 0)
const wheelsNeutral = (ws?: ClipWheels) => !ws || WHEEL_KEYS.every((k) => wheelIsNeutral(ws[k]))
const curveNeutral = (p?: CurvePoint[]) => !p?.length || p.every(([x, y]) => x === y)

/** the wheel's level on channel c (0 R, 1 G, 2 B) */
export const wheelChannel = (w: Wheel, c: number) => w.level + SHIFT * (w.x * Math.cos(PHASE[c]) + w.y * Math.sin(PHASE[c]))

/** the curve through `pts` (sorted by x) on 0…1 */
export function curveFn(pts: CurvePoint[]): (x: number) => number {
  const P = [...pts]
  if (!P.length || P[0][0] > 0) P.unshift([0, 0])
  if (P[P.length - 1][0] < 1) P.push([1, 1])
  const n = P.length
  const h = P.slice(1).map((p, i) => p[0] - P[i][0])
  const s = P.slice(1).map((p, i) => (p[1] - P[i][1]) / h[i])
  const m = new Array<number>(n)
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i])
    m[i] = (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0
  }
  m[0] = n > 2 ? (3 * s[0] - m[1]) / 2 : s[0]
  m[n - 1] = n > 2 ? (3 * s[n - 2] - m[n - 2]) / 2 : s[0]
  return (x: number) => {
    if (x <= P[0][0]) return P[0][1]
    if (x >= P[n - 1][0]) return P[n - 1][1]
    let i = 0
    while (x > P[i + 1][0]) i++
    const t = (x - P[i][0]) / h[i], t2 = t * t, t3 = t2 * t
    return clamp01((2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h[i] * m[i + 1])
  }
}

/** the exact per-channel function, or undefined when it is the identity */
export function toneFn(ws?: ClipWheels, cs?: ClipCurves): ((x: number, c: number) => number) | undefined {
  const wOn = !wheelsNeutral(ws)
  const curves = CURVE_CHS.map((k) => (curveNeutral(cs?.[k]) ? null : curveFn(cs![k]!)))
  if (!wOn && curves.every((f) => !f)) return undefined
  const lgg = [0, 1, 2].map((c) => wOn
    ? [0.5 * wheelChannel(ws!.lift, c), Math.pow(2, -wheelChannel(ws!.gamma, c)), Math.pow(2, wheelChannel(ws!.gain, c))]
    : [0, 1, 1])
  const [Y, ...rgb] = curves
  return (x, c) => {
    const [lift, pw, gain] = lgg[c]
    let v = clamp01(x)
    if (wOn) v = Math.pow(clamp01(gain * (v + lift * (1 - v))), pw)
    if (Y) v = Y(v)
    const f = rgb[c]
    return f ? f(v) : v
  }
}

/** straight colour 0…1 → through the wheels and curves, the reference */
export function toneColour(rgb: [number, number, number], ws?: ClipWheels, cs?: ClipCurves): [number, number, number] {
  const f = toneFn(ws, cs)
  return f ? (rgb.map((v, c) => f(v, c)) as [number, number, number]) : rgb
}

const SIZE = 1024
const baked = new Map<string, CubeLut>()
/** the clip's table for the shader (cached by content: the same settings are the
    same object, so the compositor uploads it once); undefined = skip the pass */
export function curveTable(ws?: ClipWheels, cs?: ClipCurves): CubeLut | undefined {
  const f = toneFn(ws, cs)
  if (!f) return undefined
  const key = JSON.stringify([ws ?? null, cs ?? null])
  let t = baked.get(key)
  if (t) return t
  const data = new Float32Array(SIZE * 3)
  for (let i = 0; i < SIZE; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = f(i / (SIZE - 1), c)
  t = { dim: 1, size: SIZE, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data }
  // frameSignature stringifies every layer per motion-blur sub-sample: the key says it all
  Object.defineProperty(t, 'toJSON', { value: () => key })
  // ponytail: whole-cache drop past 64 settings (a drag makes one per step); LRU if it ever shows
  if (baked.size >= 64) baked.clear()
  baked.set(key, t)
  return t
}

/** a project's wheels as written by anyone: complete, clamped, or absent */
export function sanitizeWheels(v: unknown): ClipWheels | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out = {} as ClipWheels
  for (const k of WHEEL_KEYS) {
    const w = (o[k] && typeof o[k] === 'object' ? o[k] : {}) as Record<string, unknown>
    let x = num(w.x), y = num(w.y)
    const r = Math.hypot(x, y)
    if (r > 1) { x /= r; y /= r }
    out[k] = { x, y, level: Math.min(1, Math.max(-1, num(w.level))) }
  }
  return out
}

/** a project's curves: per channel sorted, clamped, one point per x; nothing = absent */
export function sanitizeCurves(v: unknown): ClipCurves | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out: ClipCurves = {}
  for (const k of CURVE_CHS) {
    if (!Array.isArray(o[k])) continue
    const pts = (o[k] as unknown[])
      .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(([x, y]) => [clamp01(x), clamp01(y)] as CurvePoint)
      .sort((a, b) => a[0] - b[0])
    const kept: CurvePoint[] = []
    for (const p of pts) {
      if (kept.length && p[0] - kept[kept.length - 1][0] < 1e-4) kept[kept.length - 1] = p
      else kept.push(p)
    }
    if (kept.length) out[k] = kept
  }
  return Object.keys(out).length ? out : undefined
}

/** the shader side: the baked table, sampled at texel centres per channel */
export const CURVE_GLSL = `
uniform int uCurveOn;
uniform highp sampler2D uCurve;
uniform highp float uCurveSize;
highp vec3 kadrCurve(highp vec3 c) {
  highp vec3 t = (clamp(c, 0.0, 1.0) * (uCurveSize - 1.0) + 0.5) / uCurveSize;
  return vec3(texture(uCurve, vec2(t.r, 0.5)).r, texture(uCurve, vec2(t.g, 0.5)).g, texture(uCurve, vec2(t.b, 0.5)).b);
}
`
