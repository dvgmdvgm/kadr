// J2: a user LUT on a clip — the .cube parser, the reference sampler and the
// GLSL the clip shader runs, in one file so the three cannot drift apart
// (`scripts/check-lut.mjs` compares the sampler and the shader with ffmpeg's
// lut3d / lut1d on the same pixels).
//
// A LUT acts on the colour the clip already shows (display-referred, 0…1), after
// the primary grade and before opacity, and `intensity` mixes it with that
// colour. A 3D LUT is a TEXTURE_3D with trilinear sampling (the hardware's, at
// texel centres); a 1D LUT is an N×1 texture sampled once per channel. Both are
// half-float — 2^-11 at 1.0, well under a unit of 8-bit output.

export interface CubeLut {
  /** 1 = per-channel curve, 3 = cube */
  dim: 1 | 3
  /** entries per axis */
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** RGB triples; for a cube red changes fastest, then green, then blue (the .cube order) */
  data: Float32Array
}

/** Parse an Adobe/Resolve .cube file. Throws on anything it cannot apply. */
export function parseCube(text: string): CubeLut {
  let dim: 1 | 3 | 0 = 0, size = 0
  let min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [1, 1, 1]
  const vals: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [key, ...rest] = line.split(/\s+/)
    const nums = rest.map(Number)
    if (/^[-+.\d]/.test(key)) {
      const v = [Number(key), ...nums]
      if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`bad LUT row: ${line}`)
      vals.push(...v)
    } else if (key === 'LUT_3D_SIZE' || key === 'LUT_1D_SIZE') {
      // ponytail: Resolve's shaper + cube in one file is refused, not applied
      if (dim) throw new Error('a .cube with both a 1D and a 3D table is not supported')
      dim = key === 'LUT_3D_SIZE' ? 3 : 1
      size = nums[0]
    } else if (key === 'DOMAIN_MIN' && nums.length === 3) min = nums as [number, number, number]
    else if (key === 'DOMAIN_MAX' && nums.length === 3) max = nums as [number, number, number]
    else if ((key === 'LUT_3D_INPUT_RANGE' || key === 'LUT_1D_INPUT_RANGE') && nums.length === 2) {
      min = [nums[0], nums[0], nums[0]]; max = [nums[1], nums[1], nums[1]]
    }
    // TITLE and unknown keywords carry nothing we apply
  }
  if (!dim || !Number.isInteger(size) || size < 2 || size > (dim === 3 ? 256 : 65536)) throw new Error('no LUT_1D_SIZE / LUT_3D_SIZE in the file')
  const want = (dim === 3 ? size ** 3 : size) * 3
  if (vals.length !== want) throw new Error(`the LUT has ${vals.length / 3} rows, its size says ${want / 3}`)
  if ([0, 1, 2].some((i) => !(max[i] > min[i]))) throw new Error('DOMAIN_MAX must exceed DOMAIN_MIN')
  const t: CubeLut = { dim, size, domainMin: min, domainMax: max, data: Float32Array.from(vals) }
  // J14: frameSignature stringifies every layer per motion-blur sub-sample — a
  // 33³ table is 108k numbers each time; a parse is its identity (a re-read is a new one)
  const id = `lut#${++parsed}`
  Object.defineProperty(t, 'toJSON', { value: () => id })
  return t
}
let parsed = 0

/** the input on the LUT's grid: 0…size−1 per channel */
const gridPos = (lut: CubeLut, v: number, i: number) =>
  Math.min(1, Math.max(0, (v - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i]))) * (lut.size - 1)

/** the reference: trilinear (3D) / linear (1D) lookup of an RGB colour, like ffmpeg's lut3d/lut1d */
export function sampleLut(lut: CubeLut, rgb: [number, number, number]): [number, number, number] {
  const n = lut.size, d = lut.data
  const p = rgb.map((v, i) => gridPos(lut, v, i))
  const lo = p.map((x) => Math.min(n - 2, Math.floor(x))), f = p.map((x, i) => x - lo[i])
  if (lut.dim === 1) {
    return [0, 1, 2].map((c) => d[lo[c] * 3 + c] * (1 - f[c]) + d[(lo[c] + 1) * 3 + c] * f[c]) as [number, number, number]
  }
  const at = (r: number, g: number, b: number, c: number) => d[((b * n + g) * n + r) * 3 + c]
  const out: number[] = []
  for (let c = 0; c < 3; c++) {
    let s = 0
    for (let k = 0; k < 8; k++) {
      const dr = k & 1, dg = (k >> 1) & 1, db = k >> 2
      const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2])
      if (w) s += w * at(lo[0] + dr, lo[1] + dg, lo[2] + db, c)
    }
    out.push(s)
  }
  return out as [number, number, number]
}

/** the shader side; `uLutOn`: 0 none, 1 a 1D table (`uLut1`), 3 a cube (`uLut3`) */
export const LUT_GLSL = `
uniform int uLutOn;
uniform highp sampler3D uLut3;
uniform highp sampler2D uLut1;
uniform highp vec3 uLutMin;
uniform highp vec3 uLutScale;   // 1 / (domain max − min)
uniform highp float uLutSize;
uniform highp float uLutMix;
highp vec3 kadrLut(highp vec3 c) {
  highp vec3 t = (clamp((c - uLutMin) * uLutScale, 0.0, 1.0) * (uLutSize - 1.0) + 0.5) / uLutSize;
  highp vec3 o = uLutOn == 3 ? texture(uLut3, t).rgb
    : vec3(texture(uLut1, vec2(t.r, 0.5)).r, texture(uLut1, vec2(t.g, 0.5)).g, texture(uLut1, vec2(t.b, 0.5)).b);
  return mix(c, o, uLutMix);
}
`
