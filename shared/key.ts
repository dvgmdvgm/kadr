// Chroma and luma key (J4): the reference maths and the GLSL the clip shader
// runs — one file, so the two cannot drift apart (`scripts/check-key.mjs`
// renders the GLSL through the real Compositor and compares).
//
// Distance in YCbCr (BT.709, full range, on the encoded straight colour):
// chroma = the CbCr distance to the key colour scaled to 0…1 (ffmpeg
// chromakey's `similarity` scale), luma = |Y − Y(key)|. Alpha ramps from 0 at
// `tolerance` to 1 at `tolerance + softness`. Spill (chroma only) removes up to
// all of a pixel's chroma that points towards the key's hue, luma kept — a
// green fringe goes grey. The key reads the source as decoded (after an
// alpha-packed source is unpacked), before the grade, and its alpha multiplies
// the source's own alpha and the masks'.

import type { Anim } from './types'

export type KeyMode = 'chroma' | 'luma'
export interface ClipKey {
  mode: KeyMode
  /** '#rrggbb' — the colour (chroma) or the brightness (luma) keyed out */
  colour: string
  tolerance: Anim
  softness: Anim
  /** 0…1, chroma only */
  spill: Anim
}
/** one key evaluated at a moment: what the layer draws with */
export interface KeyDraw { mode: 1 | 2; rgb: [number, number, number]; tolerance: number; softness: number; spill: number }

export const KEY_ANIMS = ['tolerance', 'softness', 'spill'] as const

export const hexRgb = (hex: string): [number, number, number] | undefined => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return undefined
  const v = parseInt(m[1], 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** what a clip draws with at clip-local `rel`; undefined = no key */
export function keyAt(key: ClipKey | undefined, rel: number, at: (a: Anim, t: number) => number): KeyDraw | undefined {
  const rgb = key && hexRgb(key.colour)
  if (!key || !rgb || (key.mode !== 'chroma' && key.mode !== 'luma')) return undefined
  const v = (a: Anim | undefined) => clamp01(a ? at(a, rel) : 0)
  return { mode: key.mode === 'chroma' ? 1 : 2, rgb, tolerance: v(key.tolerance), softness: v(key.softness), spill: key.mode === 'chroma' ? v(key.spill) : 0 }
}

const KR = 0.2126, KB = 0.0722, KG = 0.7152
const ycc = (c: number[]) => { const y = KR * c[0] + KG * c[1] + KB * c[2]; return [y, (c[2] - y) / 1.8556, (c[0] - y) / 1.5748] }

/** straight sRGB-encoded 0…1 → keyed colour and the key's alpha, the reference */
export function keyPixel(rgb: [number, number, number], k: KeyDraw): { rgb: [number, number, number]; alpha: number } {
  const p = ycc(rgb), q = ycc(k.rgb)
  const d = k.mode === 1 ? Math.hypot(p[1] - q[1], p[2] - q[2]) / Math.SQRT2 : Math.abs(p[0] - q[0])
  const alpha = clamp01((d - k.tolerance) / Math.max(k.softness, 1e-4))
  const n = Math.hypot(q[1], q[2])
  if (!(k.spill > 0 && n > 1e-6)) return { rgb, alpha }
  const u = [q[1] / n, q[2] / n], s = k.spill * Math.max(0, p[1] * u[0] + p[2] * u[1])
  const cb = p[1] - s * u[0], cr = p[2] - s * u[1]
  const r = p[0] + 1.5748 * cr, b = p[0] + 1.8556 * cb
  return { rgb: [clamp01(r), clamp01((p[0] - KR * r - KB * b) / KG), clamp01(b)], alpha }
}

/** the same maths in GLSL: rgb keyed, a = the key's alpha */
export const KEY_GLSL = `
uniform int uKeyOn;             // 0 none, 1 chroma, 2 luma
uniform highp vec3 uKeyRgb;
uniform highp vec3 uKeyParams;  // tolerance, softness, spill
highp vec3 kYcc(highp vec3 c) { highp float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
highp vec4 kadrKey(highp vec3 rgb) {
  highp vec3 p = kYcc(rgb), q = kYcc(uKeyRgb);
  highp float d = uKeyOn == 1 ? length(p.yz - q.yz) / sqrt(2.0) : abs(p.x - q.x);
  highp float a = clamp((d - uKeyParams.x) / max(uKeyParams.y, 1e-4), 0.0, 1.0);
  highp float n = length(q.yz);
  if (!(uKeyParams.z > 0.0 && n > 1e-6)) return vec4(rgb, a);
  highp vec2 u = q.yz / n;
  highp vec2 cc = p.yz - uKeyParams.z * max(0.0, dot(p.yz, u)) * u;
  highp float r = p.x + 1.5748 * cc.y, b = p.x + 1.8556 * cc.x;
  return vec4(clamp(vec3(r, (p.x - 0.2126 * r - 0.0722 * b) / 0.7152, b), 0.0, 1.0), a);
}
`
