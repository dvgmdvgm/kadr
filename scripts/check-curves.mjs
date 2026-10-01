// J7: lift/gamma/gain wheels and Y/R/G/B curves — `shared/curves.ts` holds the
// reference maths, the bake (one 1D table per clip, rebuilt only when the
// wheels or curves change) and the GLSL the clip shader samples it with. This
// checks the curve (monotone cubic: through every point, no overshoot), the
// wheels (neutral is the identity, each one acts where it should), the bake
// against the exact function, and then the REAL Compositor in a hidden
// Electron window: no wheels or curves = the picture untouched, and a frame
// with them equals the reference within one unit.
// Cost of a regression: grades that shift on export, or a curve point that
// does not land where the user put it.
// Needs the installed electron. No app, no network.
// Run: node scripts/check-curves.mjs
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const alias = { '@shared': join(root, 'shared'), '@': join(root, 'src') }
const noStore = { name: 'no-store', setup(b) {
  b.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useSettings = Object.assign(() => "en", { getState: () => ({ lang: "en" }) })' }))
} }
const bundle = async (contents, platform) => (await build({
  stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform, format: platform === 'node' ? 'esm' : 'iife',
  write: false, alias, plugins: [noStore], logLevel: 'silent'
})).outputFiles[0].text

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const C = await import('data:text/javascript;base64,' + Buffer.from(await bundle(`export * from './shared/curves'`, 'node')).toString('base64'))
for (const n of ['curveFn', 'toneFn', 'toneColour', 'curveTable', 'sanitizeWheels', 'sanitizeCurves', 'CURVE_GLSL', 'WHEEL_KEYS', 'CURVE_CHS'])
  check(`shared/curves exports ${n}`, n in C)
if (fails) { console.log(`\n${fails} FAILED`); process.exit(1) }

const W0 = { x: 0, y: 0, level: 0 }
const wheels = (o = {}) => ({ lift: { ...W0 }, gamma: { ...W0 }, gain: { ...W0 }, ...o })
const grid = Array.from({ length: 1001 }, (_, i) => i / 1000)

// ---- curve baking passes through its points and neutral is identity ---------------
{
  const pts = [[0.25, 0.2], [0.72, 0.8]]
  const f = C.curveFn(pts)
  check('a curve passes through each of its points', pts.every(([x, y]) => Math.abs(f(x) - y) < 1e-12), pts.map(([x]) => f(x)).join(' '))
  check('the ends stay at (0,0) and (1,1) unless a point sits there', f(0) === 0 && f(1) === 1)
  check('no points: identity', grid.every((x) => Math.abs(C.curveFn([])(x) - x) < 1e-12))
  const lifted = C.curveFn([[0, 0.1], [0.5, 0.5]])
  check('a point at x=0 moves the black point', Math.abs(lifted(0) - 0.1) < 1e-12 && lifted(1) === 1)
  // monotone data → a monotone curve with no overshoot (a natural spline rings here)
  const steep = [[0.1, 0.05], [0.15, 0.9], [0.9, 0.95]]
  const g = C.curveFn(steep)
  const vals = grid.map(g)
  check('monotone points give a monotone curve (no ringing)', vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-12))
  check('…that stays inside 0…1', vals.every((v) => v >= 0 && v <= 1))
  // a peak: the extremum is the point itself, nothing overshoots it
  const peak = C.curveFn([[0.3, 0.2], [0.5, 0.9], [0.7, 0.2]])
  const top = Math.max(...grid.filter((x) => x >= 0.3 && x <= 0.7).map(peak))
  check('a non-monotone curve peaks AT its point, not past it', Math.abs(top - 0.9) < 1e-9, `max ${top}`)
}
{
  check('neutral wheels and no curves bake nothing (the shader skips them)',
    C.curveTable(wheels(), undefined) === undefined && C.curveTable(undefined, {}) === undefined &&
    C.curveTable(wheels(), { y: [[0.5, 0.5]] }) === undefined)
  check('neutral wheels are an exact no-op in the reference', C.toneFn(wheels(), undefined) === undefined)
  const t = C.curveTable(undefined, { y: [[0.25, 0.2], [0.72, 0.8]] })
  const n = t.size, at = (x, c) => { const p = x * (n - 1), i = Math.min(n - 2, Math.floor(p)), w = p - i; return t.data[i * 3 + c] * (1 - w) + t.data[(i + 1) * 3 + c] * w }
  check('the baked table is a 1D LUT of ≥ 1024 entries', t.dim === 1 && n >= 1024 && t.data.length === n * 3)
  check('a curve point moves the matching input level exactly (baked, linear lookup)',
    [[0.25, 0.2], [0.72, 0.8]].every(([x, y]) => [0, 1, 2].every((c) => Math.abs(at(x, c) - y) < 1e-4)))
  const fn = C.toneFn(undefined, { y: [[0.25, 0.2], [0.72, 0.8]] })
  const err = Math.max(...grid.map((x) => Math.abs(at(x, 0) - fn(x, 0))))
  check('the table follows the exact curve within 1/4 unit of 8 bits', err < 0.25 / 255, `max ${(err * 255).toFixed(4)}/255`)
  check('the same wheels and curves bake to the same table object (no re-upload)',
    C.curveTable(undefined, { y: [[0.25, 0.2], [0.72, 0.8]] }) === t)
  check('the table serialises as its key, not as 3000 numbers', JSON.stringify({ t }).length < 400)
}
// ---- the wheels ------------------------------------------------------------------
{
  const f = (w) => C.toneFn(w, undefined)
  const lift = f(wheels({ lift: { x: 0, y: 0, level: 0.4 } }))
  check('lift raises black and leaves white', lift(0, 0) > 0.15 && lift(1, 0) === 1 && lift(0, 0) === lift(0, 2))
  const gain = f(wheels({ gain: { x: 0, y: 0, level: -0.5 } }))
  check('gain scales white and leaves black', gain(0, 1) === 0 && Math.abs(gain(1, 1) - Math.SQRT1_2) < 1e-12)
  const gamma = f(wheels({ gamma: { x: 0, y: 0, level: 0.5 } }))
  check('gamma lifts the mids and pins both ends', gamma(0, 0) === 0 && gamma(1, 0) === 1 && gamma(0.5, 0) > 0.6)
  // the puck toward red (right of the disc): red up, green and blue down by half as much each
  const red = f(wheels({ gain: { x: 1, y: 0, level: 0 } }))
  check('a gain puck toward red warms the highlights: R up, G = B down', red(0.8, 0) > 0.8 && red(0.8, 1) < 0.8 &&
    Math.abs(red(0.8, 1) - red(0.8, 2)) < 1e-12)
  const blue = f(wheels({ lift: { x: Math.cos(4 * Math.PI / 3), y: Math.sin(4 * Math.PI / 3), level: 0 } }))
  check('a lift puck toward blue (240°) tints the shadows blue', blue(0.05, 2) > 0.05 && blue(0.05, 0) <= 0.05)
  const ref = C.toneColour([0.3, 0.5, 0.7], wheels({ lift: { x: 0.2, y: -0.1, level: 0.1 } }), { r: [[0.5, 0.6]] })
  const fn = C.toneFn(wheels({ lift: { x: 0.2, y: -0.1, level: 0.1 } }), { r: [[0.5, 0.6]] })
  check('toneColour is the per-channel function', ref.every((v, i) => v === fn([0.3, 0.5, 0.7][i], i)))
}
// ---- the sanitizers -----------------------------------------------------------------
{
  const w = C.sanitizeWheels({ lift: { x: 3, y: 0, level: 9 }, gamma: 'junk' })
  check('wheels: a puck past the rim comes back onto it, levels clamp, missing wheels are neutral',
    Math.abs(Math.hypot(w.lift.x, w.lift.y) - 1) < 1e-12 && w.lift.level === 1 && w.gamma.level === 0 && w.gain.x === 0)
  check('wheels: junk is dropped', C.sanitizeWheels(null) === undefined && C.sanitizeWheels(7) === undefined)
  const c = C.sanitizeCurves({ y: [[0.7, 2], [0.2, 0.1], ['a', 1], [0.2, 0.3]], r: [], q: [[0.5, 0.5]] })
  check('curves: sorted, clamped, one point per x, empty channels and junk dropped',
    JSON.stringify(c) === JSON.stringify({ y: [[0.2, 0.3], [0.7, 1]] }), JSON.stringify(c))
  check('curves: nothing left = absent', C.sanitizeCurves({ r: [] }) === undefined && C.sanitizeCurves('x') === undefined)
}

// ---- J14: a LUT table in frameSignature is a short identity, not 33³×3 numbers --------
{
  const L = await import('data:text/javascript;base64,' + Buffer.from(await bundle(`export * from './shared/lut'`, 'node')).toString('base64'))
  const cube = (n) => `LUT_3D_SIZE ${n}\n` + Array.from({ length: n ** 3 }, (_, i) =>
    [i % n, ((i / n) | 0) % n, (i / n / n) | 0].map((v) => (v / (n - 1)).toFixed(4)).join(' ')).join('\n')
  const small = L.parseCube(cube(2)), big = L.parseCube(cube(33)), again = L.parseCube(cube(33))
  const len = (t) => JSON.stringify({ lut: { table: t, mix: 1 } }).length
  check('a LUT layer serialises the same length whatever the table size', Math.abs(len(big) - len(small)) <= 2 && len(big) < 80, `${len(small)} / ${len(big)}`)
  check('a re-read table is another identity (a reload is a new signature)', JSON.stringify(big) !== JSON.stringify(again))
}

// ---- the shader, through the real Compositor -----------------------------------------
const W = 256, H = 8
const img = new Uint8Array(W * H * 3); { let s = 4321
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) % 256
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    img.set(y === 0 ? [x, x, x] : y === 1 ? [x, 0, 0] : y === 2 ? [0, x, 0] : y === 3 ? [0, 0, x] : [rnd(), rnd(), rnd()], (y * W + x) * 3)
}
const CASES = {
  none: [undefined, undefined],
  curve: [undefined, { y: [[0.25, 0.2], [0.72, 0.8]], b: [[0.5, 0.4]] }],
  wheels: [wheels({ lift: { x: -0.3, y: -0.4, level: -0.05 }, gamma: { x: 0, y: 0, level: 0.2 }, gain: { x: 0.35, y: 0.2, level: 0.04 } }), undefined],
  both: [wheels({ gain: { x: 0.5, y: 0, level: -0.1 } }), { y: [[0, 0.05], [0.5, 0.55]], g: [[0.3, 0.25], [0.8, 0.85]] }]
}
const refOut = ([w, c]) => {
  const o = new Uint8Array(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    const v = C.toneColour([img[i * 3] / 255, img[i * 3 + 1] / 255, img[i * 3 + 2] / 255], w, c)
    for (let k = 0; k < 3; k++) o[i * 3 + k] = Math.round(v[k] * 255)
  }
  return o
}
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m }
const dir = mkdtempSync(join(tmpdir(), 'kadr-curves-'))
try {
  const page = await bundle(`
import { Compositor } from './src/gl/compositor'
import { curveTable } from './shared/curves'
const W = ${W}, H = ${H}, CASES = ${JSON.stringify(CASES)}
const IMG = ${JSON.stringify(Array.from(img))}
const src = document.createElement('canvas'); src.width = W; src.height = H
const id = new ImageData(W, H)
for (let i = 0; i < W * H; i++) id.data.set([IMG[i * 3], IMG[i * 3 + 1], IMG[i * 3 + 2], 255], i * 4)
src.getContext('2d').putImageData(id, 0, 0)
const comp = new Compositor(document.createElement('canvas'))
const out = new Uint8Array(W * H * 4), res = {}
for (const [name, [w, c]] of Object.entries(CASES)) {
  comp.setSize(W, H); comp.begin('#000000')
  comp.drawLayer({ source: src, cacheKey: 'ramp', dynamic: false, srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
    curve: curveTable(w ?? undefined, c ?? undefined) })
  comp.readPixels(out)
  const rgb = new Array(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++)
    rgb[(y * W + x) * 3 + k] = out[((H - 1 - y) * W + x) * 4 + k]
  res[name] = rgb
}
// J14: a reloaded LUT and a dragged curve leave ONE texture each, not one per table ever drawn
import { parseCube } from './shared/lut'
const layer = { source: src, cacheKey: 'ramp', dynamic: false, srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
const cube = 'LUT_3D_SIZE 2\\n' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1, (i >> 1) & 1, i >> 2].join(' ')).join('\\n')
for (let r = 0; r < 6; r++) {
  const table = parseCube(cube)
  for (let f = 0; f < 12; f++) { comp.begin('#000000'); comp.drawLayer({ ...layer, lut: { table, mix: 1 } }) }
}
const lutTextures = comp.luts.size
for (let i = 0; i < 20; i++) { comp.begin('#000000'); comp.drawLayer({ ...layer, curve: curveTable(undefined, { y: [[0.5, 0.3 + i * 0.01]] }) }) }
for (let f = 0; f < 12; f++) { comp.begin('#000000'); comp.drawLayer({ ...layer, curve: curveTable(undefined, { y: [[0.5, 0.49]] }) }) }
res.textures = [lutTextures, comp.curveTex.size]
console.log('RESULT ' + JSON.stringify(res))
`, 'browser')
  writeFileSync(join(dir, 'page.js'), page)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="page.js"></script>')
  writeFileSync(join(dir, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  const done = (code) => { app.exit(code) }
  w.webContents.on('console-message', (...a) => { const m = typeof a[0] === 'object' && a[0].message !== undefined ? a[0].message : a[2]
    if (String(m).startsWith('RESULT ')) { process.stdout.write(m + '\\n'); done(0) } else process.stderr.write('page: ' + m + '\\n') })
  w.webContents.on('render-process-gone', () => done(2))
  w.loadFile(${JSON.stringify(join(dir, 'index.html'))})
  setTimeout(() => { process.stderr.write('timeout\\n'); done(3) }, 30000)
})`)
  const exe = createRequire(import.meta.url)('electron')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(exe, [join(dir, 'main.cjs')], { encoding: 'utf8', env, timeout: 60000, maxBuffer: 1 << 26 })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '))
  if (!line) check('the shader ran in Electron', false, `exit ${r.status}: ${(r.stderr || '').slice(-600)}`)
  else {
    const got = JSON.parse(line.slice(7))
    check('no wheels or curves: the picture is untouched (exact)', maxDiff(got.none, img) === 0, `max ${maxDiff(got.none, img)}`)
    for (const k of ['curve', 'wheels', 'both']) {
      const m = maxDiff(got[k], refOut(CASES[k]))
      check(`the shader matches the reference: ${k} (within 1)`, m <= 1, `max ${m}`)
    }
    // the curve's own points on the grey ramp: input 64 → round(0.2·255)… exactly
    const pt = [[64, C.curveFn([[0.25, 0.2], [0.72, 0.8]])(64 / 255)]]
    check('six LUT reloads leave one LUT texture, a 20-step curve drag one curve texture',
      got.textures[0] === 1 && got.textures[1] === 1, JSON.stringify(got.textures))
    check('on the grey ramp a level near a point lands where the curve says (exact)',
      pt.every(([x, y]) => got.curve[x * 3] === Math.round(y * 255)), `${got.curve[64 * 3]} vs ${Math.round(pt[0][1] * 255)}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
