// J6: every write of the Inspector's «Цвет» section (and the pipette, the
// palette actions, kadr_grade) goes through here, so «one undo step per
// gesture» is decided in one place (test: node scripts/check-colour-ui.mjs).
//
// Continuous controls (ranges, the native colour picker) call `colourGesture()`
// when a gesture starts (pointerdown, a key, focus) and then write freely: the
// FIRST real write of the gesture pushes history, the rest ride in it, and a
// gesture that wrote nothing leaves no step. Discrete controls (diamond,
// resets, mode, LUT) are one step each, and a reset of nothing is none.
// Keyframes follow the clip's ordinary Anim rules: a parameter with keys takes
// a key at the playhead (clip-local) when moved — the Lumetri behaviour.
import type { Anim, Clip, Project } from '@shared/types'
import { GRADE_KEYS, type ClipGrade, type GradeKey } from '@shared/colour'
import type { BlendMode } from '@shared/blend'
import type { ClipKey } from '@shared/key'
import { WHEEL_KEYS, wheelIsNeutral, type ClipWheels, type CurveCh, type CurvePoint, type Wheel, type WheelKey } from '@shared/curves'
import { useEditor, findClip } from '@/state/store'
import { applyValue, resetValue, upsertKf, KF_EPS } from '@/components/animUtils'
import { evalAnim } from './anim'

export type ColourParam = `grade.${GradeKey}` | 'lut.intensity' | 'key.tolerance' | 'key.softness' | 'key.spill'
export const COLOUR_PARAMS: ColourParam[] = [
  ...GRADE_KEYS.map((k) => `grade.${k}` as ColourParam), 'lut.intensity', 'key.tolerance', 'key.softness', 'key.spill'
]
/** the neutral value a reset returns to (the sanitizer's defaults) */
export const paramDefault = (p: ColourParam) =>
  p === 'lut.intensity' ? 1 : p === 'key.tolerance' || p === 'key.softness' ? 0.1 : 0

export type ColourGroup = 'prim' | 'lut' | 'blend' | 'key' | 'wheels' | 'curves'
const GROUP_FIELD = { prim: 'grade', lut: 'lut', blend: 'blend', key: 'key', wheels: 'wheels', curves: 'curves' } as const

const st = () => useEditor.getState()

export function paramAnim(c: Clip, p: ColourParam): Anim | undefined {
  const [g, k] = p.split('.') as [string, string]
  if (g === 'grade') return c.grade?.[k as GradeKey]
  if (g === 'lut') return c.lut?.intensity
  return c.key?.[k as 'tolerance' | 'softness' | 'spill']
}
export const paramValue = (c: Clip, p: ColourParam, rel: number) => {
  const a = paramAnim(c, p)
  return a ? evalAnim(a, rel) : paramDefault(p)
}
/** the clip-local time a key goes to; null = the playhead is outside the clip */
export function clipRel(c: Clip, playhead = st().playhead): number | null {
  const rel = playhead - c.start
  return rel < -1e-9 || rel > c.duration + 1e-9 ? null : Math.min(c.duration, Math.max(0, rel))
}
export type KfState = 'none' | 'animated' | 'on' | 'outside'
export function kfState(c: Clip, p: ColourParam, rel: number | null): KfState {
  if (rel === null || rel < -1e-9 || rel > c.duration + 1e-9) return 'outside'
  const keys = paramAnim(c, p)?.keyframes
  if (!keys?.length) return 'none'
  return keys.some((k) => Math.abs(k.time - rel) < KF_EPS) ? 'on' : 'animated'
}

/** the patch that puts `a` at parameter `p` (a missing grade/key is created whole) */
function withAnim(c: Clip, p: ColourParam, a: Anim): Partial<Clip> {
  const [g, k] = p.split('.') as [string, string]
  if (g === 'grade') {
    const base = c.grade ?? (Object.fromEntries(GRADE_KEYS.map((x) => [x, { value: 0 }])) as ClipGrade)
    return { grade: { ...base, [k]: a } }
  }
  if (g === 'lut') return c.lut ? { lut: { ...c.lut, intensity: a } } : {}
  return c.key ? { key: { ...c.key, [k]: a } } : {}
}

let armed = false
/** the keyboard run in progress: its parameter and the project it left behind */
let keyRun: { p: string; project: unknown } | null = null
/** a continuous control's gesture starts: its first write will be one undo step */
export const colourGesture = () => { armed = true; keyRun = null; gestures++ }
/** a key on a range: presses on the same control in a row, with nothing else
    edited between them, are one gesture (one step); anything else starts one */
export function colourKey(p: ColourParam | `wheels.${WheelKey}` | `curves.${CurveCh}`) {
  if (keyRun?.p === p && keyRun.project === st().project) return
  armed = true
  keyRun = { p, project: null }
}

function clipOf(id: string): Clip | null {
  const f = findClip(st().project, id)
  return f && !f.track.locked ? f.clip : null
}
function write(id: string, patch: Partial<Clip>) {
  if (!Object.keys(patch).length) return
  const push = armed
  if (armed) { st().pushHistory('hColour'); armed = false }
  st().updateClip(id, patch)
  if (keyRun) keyRun.project = st().project
  if (push) pressed = { id, entry: st().past.at(-1), project: st().project, g: gestures }
  else if (pressed?.id === id && pressed.entry === st().past.at(-1)) pressed.project = st().project
}

/** J14: the step the last press pushed — a double-click right after folds into it */
type Press = { id: string; entry: unknown; project: unknown; g: number }
let pressed: Press | null = null
let fold: Press | null = null
/** pointer gestures begun so far: a double-click's two presses are the last two */
let gestures = 0
/** a double-click arrives: the reset/delete it makes joins the step its FIRST
    press pushed (puck jump, point added) — nothing else edited since — and a net
    no-change leaves no step */
export function colourDouble() {
  const p = pressed
  fold = p && p.g === gestures - 1 && st().past.at(-1) === p.entry && st().project === p.project ? p : null
}
/** a discrete edit: one step, or none when it changes nothing */
function step(id: string, patch: Partial<Clip>): boolean {
  const c = clipOf(id)
  const f = fold?.id === id ? fold : null
  fold = null
  if (!c || Object.entries(patch).every(([k, v]) => JSON.stringify((c as unknown as Record<string, unknown>)[k]) === JSON.stringify(v))) return false
  armed = false
  keyRun = null
  pressed = null
  if (f) {
    st().updateClip(id, patch)
    const before = findClip((f.entry as { project: Project }).project, id)?.clip
    // back where the press started: the step had nothing left to undo
    if (JSON.stringify(before) === JSON.stringify(clipOf(id))) useEditor.setState((s) => ({ past: s.past.slice(0, -1) }))
    return true
  }
  st().pushHistory('hColour')
  // an `undefined` field stays as a key until the next copy; JSON drops it like absent
  st().updateClip(id, patch)
  return true
}

export function setParam(id: string, p: ColourParam, v: number) {
  const c = clipOf(id)
  if (!c || !Number.isFinite(v)) return
  const cur = paramAnim(c, p) ?? { value: paramDefault(p) }
  const rel = clipRel(c) ?? 0
  write(id, withAnim(c, p, applyValue(cur, cur.keyframes?.length ? rel : 0, v, false)))
}

export function setKeyColour(id: string, hex: string) {
  const c = clipOf(id)
  if (!c?.key || !/^#[0-9a-f]{6}$/i.test(hex) || c.key.colour === hex.toLowerCase()) return
  write(id, { key: { ...c.key, colour: hex.toLowerCase() } })
}

/** the diamond: add a key at the playhead (the parameter becomes animated), or remove the one there */
export function toggleKf(id: string, p: ColourParam): boolean {
  const c = clipOf(id)
  if (!c) return false
  const rel = clipRel(c)
  const state = kfState(c, p, rel)
  if (state === 'outside' || rel === null) return false
  const cur = paramAnim(c, p) ?? { value: paramDefault(p) }
  let next: Anim
  if (state === 'on') {
    const left = cur.keyframes!.filter((k) => Math.abs(k.time - rel) >= KF_EPS)
    next = left.length ? { ...cur, keyframes: left } : { value: evalAnim(cur, rel) }
  } else next = upsertKf(cur, rel, evalAnim(cur, rel))
  return step(id, withAnim(c, p, next))
}

/** double-click on a label: back to neutral (a key at the playhead when animated) */
export function resetParam(id: string, p: ColourParam): boolean {
  const c = clipOf(id)
  const a = c && paramAnim(c, p)
  if (!c || !a) return false
  return step(id, withAnim(c, p, resetValue(a, clipRel(c) ?? 0, paramDefault(p))))
}

export const resetGroup = (id: string, g: ColourGroup) => step(id, { [GROUP_FIELD[g]]: undefined })
export const resetColour = (id: string) =>
  step(id, { grade: undefined, lut: undefined, blend: undefined, key: undefined, wheels: undefined, curves: undefined })
export const setBlend = (id: string, mode: BlendMode) => step(id, { blend: mode === 'normal' ? undefined : mode })

export function setKeyMode(id: string, mode: 'off' | 'chroma' | 'luma'): boolean {
  const c = clipOf(id)
  if (!c) return false
  if (mode === 'off') return step(id, { key: undefined })
  const k: ClipKey = c.key
    ? { ...c.key, mode }
    : { mode, colour: mode === 'chroma' ? '#00ff00' : '#000000', tolerance: { value: 0.1 }, softness: { value: 0.1 }, spill: { value: 0 } }
  return step(id, { key: k })
}

export function setLut(id: string, path: string): boolean {
  const c = clipOf(id)
  if (!c || !path) return false
  return step(id, { lut: { path, intensity: c.lut?.intensity ?? { value: 1 } } })
}
export const removeLut = (id: string) => step(id, { lut: undefined })

/** what the clip carries in colour, for the reset buttons */
export const hasColour = (c: Clip) => !!(c.grade || c.lut || c.blend || c.key || c.wheels || c.curves)

/** before/after: the same clip with its colour off */
export function stripColour(c: Clip): Clip {
  const { grade: _g, lut: _l, blend: _b, key: _k, wheels: _w, curves: _c, ...rest } = c
  return rest
}

// ── J7: the wheels and the curves. Not animatable (they bake into one table per
// clip), so no diamonds: a drag is a gesture like a range's, a delete or a reset a step.
const W0: Wheel = { x: 0, y: 0, level: 0 }
/** the clip's wheels with `k` replaced; all three neutral = absent */
function withWheel(c: Clip, k: WheelKey, w: Wheel): Partial<Clip> {
  const ws = { ...(c.wheels ?? { lift: W0, gamma: W0, gain: W0 }), [k]: w } as ClipWheels
  return { wheels: WHEEL_KEYS.every((x) => wheelIsNeutral(ws[x])) ? undefined : ws }
}
/** move wheel `k`: the puck (clamped to the disc) and/or the level (−1…1) */
export function setWheel(id: string, k: WheelKey, v: Partial<Wheel>) {
  const c = clipOf(id)
  if (!c) return
  const w = { ...(c.wheels?.[k] ?? W0), ...v }
  if (![w.x, w.y, w.level].every(Number.isFinite)) return
  const r = Math.hypot(w.x, w.y)
  if (r > 1) { w.x /= r; w.y /= r }
  w.level = Math.min(1, Math.max(-1, w.level))
  const cur = c.wheels?.[k] ?? W0
  if (w.x === cur.x && w.y === cur.y && w.level === cur.level) return
  write(id, withWheel(c, k, w))
}
/** double-click on a disc: that wheel back to neutral, one step */
export function resetWheel(id: string, k: WheelKey): boolean {
  const c = clipOf(id)
  return !!c && step(id, withWheel(c, k, W0))
}

/** the clip's curves with channel `ch` replaced; an empty channel goes, and nothing left = absent */
function withCurve(c: Clip, ch: CurveCh, pts: CurvePoint[]): Partial<Clip> {
  const cs = { ...c.curves, [ch]: pts }
  if (!pts.length) delete cs[ch]
  return { curves: Object.keys(cs).length ? cs : undefined }
}
const MIN_GAP = 0.01
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** a click on the graph: a point at (x, y); returns its index for the drag that follows */
export function addCurvePoint(id: string, ch: CurveCh, x: number, y: number): number {
  const c = clipOf(id)
  if (!c || !Number.isFinite(x) || !Number.isFinite(y)) return -1
  const pts = c.curves?.[ch] ?? []
  x = clamp01(x)
  if (pts.some((p) => Math.abs(p[0] - x) < MIN_GAP)) return -1
  const i = pts.findIndex((p) => p[0] > x)
  const at = i < 0 ? pts.length : i
  write(id, withCurve(c, ch, [...pts.slice(0, at), [x, clamp01(y)], ...pts.slice(at)]))
  return at
}
/** drag point `i`: it stays between its neighbours, so its index never changes */
export function moveCurvePoint(id: string, ch: CurveCh, i: number, x: number, y: number) {
  const c = clipOf(id)
  const pts = c?.curves?.[ch]
  if (!c || !pts?.[i] || !Number.isFinite(x) || !Number.isFinite(y)) return
  const lo = i > 0 ? pts[i - 1][0] + MIN_GAP : 0
  const hi = i < pts.length - 1 ? pts[i + 1][0] - MIN_GAP : 1
  const p: CurvePoint = [Math.min(hi, Math.max(lo, x)), clamp01(y)]
  if (p[0] === pts[i][0] && p[1] === pts[i][1]) return
  write(id, withCurve(c, ch, pts.map((q, j) => (j === i ? p : q))))
}
/** double-click on a point: it goes, one step */
export function removeCurvePoint(id: string, ch: CurveCh, i: number): boolean {
  const c = clipOf(id)
  const pts = c?.curves?.[ch]
  return !!c && !!pts?.[i] && step(id, withCurve(c, ch, pts.filter((_, j) => j !== i)))
}
