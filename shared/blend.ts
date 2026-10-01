// Blend modes (J3): the reference maths and the GLSL the compositor runs — one
// file, so the two cannot drift apart (`scripts/check-blend.mjs` renders the
// GLSL through the real Compositor and compares).
//
// W3C Compositing and Blending Level 1, separable modes, on the ENCODED (sRGB)
// straight colour like every editor and the web: the mixed colour is
//   Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)
// and then composited source-over. `add` is not a W3C mode: it is the
// editors' «Add»/«Linear Dodge», B = min(1, Cb + Cs), through the same formula.
// `normal` is not a mode here at all — it draws the old way, byte for byte.

export const BLEND_MODES = ['normal', 'screen', 'multiply', 'add', 'overlay', 'softLight', 'difference'] as const
export type BlendMode = (typeof BLEND_MODES)[number]

export const isBlendMode = (v: unknown): v is BlendMode => BLEND_MODES.includes(v as BlendMode)

/** B(Cb, Cs) for one channel, 0…1 */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply': return cb * cs
    case 'screen': return cb + cs - cb * cs
    case 'add': return Math.min(1, cb + cs)
    case 'overlay': return cb <= 0.5 ? cs * 2 * cb : cs + (2 * cb - 1) - cs * (2 * cb - 1)
    case 'softLight': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb)
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)
      return cb + (2 * cs - 1) * (d - cb)
    }
    case 'difference': return Math.abs(cb - cs)
    default: return cs
  }
}

/** straight source `s` (alpha as) over straight backdrop `b` (alpha ab) → straight result and its alpha */
export function blendPixel(mode: BlendMode, b: number[], ab: number, s: number[], as: number): [number[], number] {
  const ao = as + ab * (1 - as)
  const c = [0, 1, 2].map((i) => {
    const mixed = (1 - ab) * s[i] + ab * blendChannel(mode, b[i], s[i])
    const co = mixed * as + b[i] * ab * (1 - as)
    return ao > 0 ? co / ao : 0
  })
  return [c, ao]
}

/** the mode a clip draws through, or undefined for normal/absent/junk — the untouched path */
export const blendOf = (m: unknown): BlendMode | undefined => (isBlendMode(m) && m !== 'normal' ? m : undefined)

/** uniform `uBlend` value; normal never reaches the shader */
export const blendIndex = (m: BlendMode) => BLEND_MODES.indexOf(m)

/** composite pass: layer (premultiplied, unit 0) over the backdrop copy (premultiplied, unit 1).
    Emits premultiplied colour for blendFunc(ONE, ONE_MINUS_SRC_ALPHA) */
export const BLEND_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uDst;
uniform int uBlend;
out vec4 outColor;
vec3 blendRgb(vec3 b, vec3 s) {
  if (uBlend == 1) return b + s - b * s;
  if (uBlend == 2) return b * s;
  if (uBlend == 3) return min(vec3(1.0), b + s);
  if (uBlend == 4) {
    vec3 b2 = 2.0 * b;
    return mix(s + (b2 - 1.0) - s * (b2 - 1.0), s * b2, vec3(lessThanEqual(b, vec3(0.5))));
  }
  if (uBlend == 5) {
    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, vec3(lessThanEqual(b, vec3(0.25))));
    return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), vec3(lessThanEqual(s, vec3(0.5))));
  }
  if (uBlend == 6) return abs(b - s);
  return s;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  if (s.a <= 0.0) discard;
  vec4 d = texelFetch(uDst, p, 0);
  vec3 cs = min(s.rgb / s.a, vec3(1.0));
  vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 mixed = (1.0 - d.a) * cs + d.a * clamp(blendRgb(cb, cs), 0.0, 1.0);
  outColor = vec4(mixed * s.a, s.a);
}`
