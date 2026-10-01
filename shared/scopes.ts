// J8: the scopes' maths — counted from the RGBA pixels the preview read back
// (a small downscale of the composited frame, `scopeSize`). Rows may come
// bottom-up straight from readPixels: no scope here depends on the row order.
// Full-range BT.709, what the preview shows: luma 0–100 % = 0–255, the
// vectorscope's Cb right and Cr up with full Cb/Cr (±0.5) at 90 % of the radius,
// targets at the 75 % bars, the skin line through the hue of (205, 150, 118).
// Test: node scripts/check-scope-bins.mjs

export type ScopeKind = 'wave' | 'parade' | 'vector' | 'hist'
export const SCOPE_KINDS: ScopeKind[] = ['wave', 'parade', 'vector', 'hist']

/** the readback: 320 px wide at most, the frame's aspect */
export function scopeSize(w: number, h: number): [number, number] {
  const sw = Math.min(320, w)
  return [sw, Math.max(1, Math.round(sw * h / w))]
}

export const luma709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
/** Cb, Cr (−0.5…0.5) of an RGB in 0…1 */
export const cbcr709 = (r: number, g: number, b: number): [number, number] => {
  const y = luma709(r, g, b)
  return [(b - y) / 1.8556, (r - y) / 1.5748]
}

/** the row (0 = top = 255) a 0…255 value lands on */
export const waveRow = (v: number, rows: number) => rows - 1 - Math.min(rows - 1, Math.floor(v / 256 * rows))

/** a waveform: column = the image's x, row = the value; ch 'y' = BT.709 luma */
export function waveGrid(px: Uint8Array, w: number, h: number, ch: 'y' | 'r' | 'g' | 'b', cols: number, rows: number): Uint32Array {
  const g = new Uint32Array(cols * rows)
  const k = ch === 'r' ? 0 : ch === 'g' ? 1 : 2
  for (let x = 0; x < w; x++) {
    const col = Math.floor(x * cols / w)
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      const v = ch === 'y' ? luma709(px[i], px[i + 1], px[i + 2]) : px[i + k]
      g[waveRow(v, rows) * cols + col]++
    }
  }
  return g
}

/** the vectorscope position (cells of an n×n grid) of a Cb/Cr */
export const vectorAt = (cb: number, cr: number, n: number): [number, number] => [n / 2 + cb * 0.9 * n, n / 2 - cr * 0.9 * n]

export const VECTOR_TARGETS = ([['R', [0.75, 0, 0]], ['Yl', [0.75, 0.75, 0]], ['G', [0, 0.75, 0]], ['Cy', [0, 0.75, 0.75]], ['B', [0, 0, 0.75]], ['Mg', [0.75, 0, 0.75]]] as const)
  .map(([name, c]) => { const [x, y] = vectorAt(...cbcr709(c[0], c[1], c[2]), 100); return { name, x, y } })
/** the skin-tone line's angle (radians, Cb right / Cr up) */
export const SKIN_ANGLE = (() => { const [cb, cr] = cbcr709(205 / 255, 150 / 255, 118 / 255); return Math.atan2(cr, cb) })()

export function vectorGrid(px: Uint8Array, w: number, h: number, n: number): Uint32Array {
  const g = new Uint32Array(n * n)
  for (let p = 0; p < w * h; p++) {
    const [cb, cr] = cbcr709(px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255)
    const [fx, fy] = vectorAt(cb, cr, n)
    const x = Math.floor(fx), y = Math.floor(fy)
    if (x >= 0 && x < n && y >= 0 && y < n) g[y * n + x]++
  }
  return g
}

export function histogram(px: Uint8Array, w: number, h: number): { r: Uint32Array; g: Uint32Array; b: Uint32Array } {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256)
  for (let p = 0; p < w * h * 4; p += 4) { r[px[p]]++; g[px[p + 1]]++; b[px[p + 2]]++ }
  return { r, g, b }
}
