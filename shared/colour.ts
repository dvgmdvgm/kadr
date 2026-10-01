// Primary colour correction (J1): the reference maths and the GLSL the clip
// shader runs — one file, so the two cannot drift apart unnoticed
// (`scripts/check-colour-math.mjs` renders the GLSL and compares).
//
// The controls are Lumetri/Lightroom «Basic» controls, done in LINEAR light
// (sRGB curve undone first) so that exposure is photographic: +1 doubles the
// light. Order: white balance → exposure → contrast → shadows/highlights →
// saturation. Every control is 0 at neutral, and a neutral grade is not run
// at all — an exact no-op, not a round trip through the curve.
// Not ASC CDL: its slope/offset/power act on the ENCODED values, so a slope of
// 2 is not a stop, and its controls are not the ones an editor shows. CDL's
// saturation (about Rec.709 luma) is what this one does.

import type { Anim } from './types'

export const GRADE_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'] as const
export type GradeKey = (typeof GRADE_KEYS)[number]
/** the clip's grade: every control animatable, 0 = neutral */
export type ClipGrade = Record<GradeKey, Anim>
/** one grade evaluated at a moment */
export type GradeValues = Record<GradeKey, number>

/** exposure in stops; the others are −1…1 */
export const GRADE_RANGE: Record<GradeKey, [number, number]> = {
  exposure: [-8, 8], contrast: [-1, 1], saturation: [-1, 1], temperature: [-1, 1],
  tint: [-1, 1], highlights: [-1, 1], shadows: [-1, 1]
}

export const clampGrade = (k: GradeKey, v: number) =>
  Number.isFinite(v) ? Math.min(GRADE_RANGE[k][1], Math.max(GRADE_RANGE[k][0], v)) : 0

export const gradeIsNeutral = (g: GradeValues) => GRADE_KEYS.every((k) => g[k] === 0)

/** uniform order of `uGrade[7]` */
export const gradeUniform = (g: GradeValues) => GRADE_KEYS.map((k) => clampGrade(k, g[k]))

/** what a clip draws with at clip-local `rel`: the `uGrade` values, or undefined
    when neutral there (the shader then skips the grade). `at` is the preview's
    evalAnim, handed in like gainKeys does, so preview and export share one path */
export function gradeAt(grade: ClipGrade | undefined, rel: number, at: (a: Anim, t: number) => number): number[] | undefined {
  if (!grade) return undefined
  const g = {} as GradeValues
  for (const k of GRADE_KEYS) g[k] = clampGrade(k, grade[k] ? at(grade[k], rel) : 0)
  return gradeIsNeutral(g) ? undefined : gradeUniform(g)
}

const W = [0.2126, 0.7152, 0.0722] // Rec.709 luma of linear light
const PIVOT = 0.18 // contrast turns about mid grey

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** straight (unpremultiplied) sRGB-encoded colour 0…1 → graded, the reference */
export function gradeColour(rgb: [number, number, number], g: GradeValues): [number, number, number] {
  if (gradeIsNeutral(g)) return rgb
  const [ex, co, sa, te, ti, hi, sh] = gradeUniform(g)
  let c = rgb.map((v) => srgbToLinear(clamp01(v)))
  // white balance: warm = more red, less blue; +tint = magenta (less green); luma kept
  const wb = [Math.pow(2, te / 2), Math.pow(2, -ti / 2), Math.pow(2, -te / 2)]
  const wn = dot(wb, W)
  const gain = Math.pow(2, ex)
  c = c.map((v, i) => (v * wb[i] / wn) * gain)
  // contrast: a slope of 2^contrast in log2 around the pivot, per channel
  const e = Math.pow(2, co)
  c = c.map((v) => PIVOT * Math.pow(Math.max(v, 0) / PIVOT, e))
  // shadows/highlights: up to ±1 stop, weighted by the perceived brightness
  const lp = linearToSrgb(clamp01(dot(c, W)))
  const f = Math.pow(2, sh * (1 - lp) * (1 - lp) + hi * lp * lp)
  c = c.map((v) => v * f)
  // saturation about Rec.709 luma
  const l = dot(c, W)
  c = c.map((v) => Math.max(0, l + (v - l) * (1 + sa)))
  return c.map((v) => linearToSrgb(clamp01(v))) as [number, number, number]
}

/** the same maths in GLSL; `uGrade` in GRADE_KEYS order */
export const GRADE_GLSL = `
uniform int uGradeOn;
uniform highp float uGrade[7];
highp float kSrgbToLin(highp float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
highp float kLinToSrgb(highp float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
highp vec3 kadrGrade(highp vec3 rgb) {
  const highp vec3 W = vec3(0.2126, 0.7152, 0.0722);
  highp vec3 s = clamp(rgb, 0.0, 1.0);
  highp vec3 c = vec3(kSrgbToLin(s.r), kSrgbToLin(s.g), kSrgbToLin(s.b));
  highp vec3 wb = vec3(exp2(uGrade[3] * 0.5), exp2(-uGrade[4] * 0.5), exp2(-uGrade[3] * 0.5));
  c *= wb / dot(wb, W) * exp2(uGrade[0]);
  c = 0.18 * pow(max(c, 0.0) / 0.18, vec3(exp2(uGrade[1])));
  highp float lp = kLinToSrgb(clamp(dot(c, W), 0.0, 1.0));
  c *= exp2(uGrade[6] * (1.0 - lp) * (1.0 - lp) + uGrade[5] * lp * lp);
  highp float l = dot(c, W);
  c = max(vec3(0.0), l + (c - l) * (1.0 + uGrade[2]));
  c = clamp(c, 0.0, 1.0);
  return vec3(kLinToSrgb(c.r), kLinToSrgb(c.g), kLinToSrgb(c.b));
}
`
