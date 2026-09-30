// J4: chroma and luma key — `shared/key.ts` holds the reference maths and the
// GLSL the clip shader runs. A generated green screen (noisy backing, a
// foreground with soft edges contaminated by the green) goes through the REAL
// Compositor in a hidden Electron window, drawn over black and over white so
// both the colour and the alpha are read back, and every pixel is compared
// with the reference. Cost of a regression: a fringe or a hole in the export
// that the preview did not show, or a key that ignores the masks, the grade
// order or an alpha-packed source's matte.
// Needs the installed electron (Windows / a display on Linux). No app, no network.
// Run: node scripts/check-key.mjs
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

// the test picture, shared by both halves: a green backing with noise, a disc of
// foreground colours whose 6 px edge is mixed with the backing (the fringe)
const PICTURE = `
const W = 256, H = 64
const picture = () => {
  const px = new Uint8ClampedArray(W * H * 4), fg = new Float32Array(W * H); let s = 777
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) % 13) - 6
  const cols = [[224, 172, 140], [200, 40, 40], [40, 60, 200], [240, 240, 240], [90, 90, 90], [180, 200, 60]]
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const g = [20 + rnd(), 190 + rnd(), 60 + rnd()]
    const d = Math.hypot((x % 64) - 31.5, y - 31.5), m = Math.min(1, Math.max(0, (24 - d) / 6))
    const c = cols[(x >> 6) + (y > 40 ? 2 : 0)] || cols[5]
    const i = (y * W + x) * 4
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(g[k] + (c[k] - g[k]) * m)
    px[i + 3] = 255; fg[y * W + x] = m
  }
  return { px, fg }
}
`
const KEY = { mode: 1, rgb: [20 / 255, 190 / 255, 60 / 255], tolerance: 0.08, softness: 0.1, spill: 0 }
const CASES = [
  ['no key (untouched)', null],
  ['chroma, spill 0', { key: KEY }],
  ['chroma, spill 1', { key: { ...KEY, spill: 1 } }],
  ['chroma, spill 0.5, softness 0.3', { key: { ...KEY, spill: 0.5, softness: 0.3 } }],
  ['chroma then the grade (exposure +0.6, saturation +0.4)', { key: { ...KEY, spill: 1 }, grade: { exposure: 0.6, saturation: 0.4 } }],
  ['luma (black, tolerance 0.2)', { key: { mode: 2, rgb: [0, 0, 0], tolerance: 0.2, softness: 0.25, spill: 0 } }],
  ['chroma × a rect mask', { key: { ...KEY, spill: 1 }, mask: true }],
  ['chroma × an alpha-packed matte', { key: { ...KEY, spill: 1 }, packed: true }]
]

// ---- pure: the reference ------------------------------------------------------
const K = await import('data:text/javascript;base64,' + Buffer.from(await bundle(
  `export * from './shared/key'; export { evalAnim } from './src/engine/anim'`, 'node')).toString('base64'))
const { px, fg } = new Function(PICTURE + 'return picture()')()
const at = (i) => [px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255]
const toward = (rgb, key) => { // chroma pointing at the key's hue, 0…1 units
  const y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const cc = (c) => [(c[2] - y(c)) / 1.8556, (c[0] - y(c)) / 1.5748]
  const p = cc(rgb), q = cc(key), n = Math.hypot(q[0], q[1])
  return (p[0] * q[0] + p[1] * q[1]) / n
}
const n = fg.length, bg = [], edge = []
for (let i = 0; i < n; i++) (fg[i] === 0 ? bg : fg[i] < 1 ? edge : []).push(i)
const r0 = (i) => K.keyPixel(at(i), KEY), r1 = (i) => K.keyPixel(at(i), { ...KEY, spill: 1 })
check('the backing keys to alpha 0 (reference)', bg.every((i) => r0(i).alpha === 0), `${bg.length} px`)
check('the foreground stays opaque (reference)', fg.every((m, i) => m < 1 || r0(i).alpha === 1))
const soft = edge.filter((i) => r0(i).alpha > 0 && r0(i).alpha < 1).length
check('the edge is soft: partial alpha on the fringe (reference)', soft > 50, `${soft} of ${edge.length} edge px`)
const fringe0 = edge.filter((i) => r0(i).alpha > 0.02 && toward(r0(i).rgb, KEY.rgb) > 0.02).length
const fringe1 = Math.max(...edge.filter((i) => r1(i).alpha > 0).map((i) => toward(r1(i).rgb, KEY.rgb)))
check('spill 0 leaves a green fringe (the test has teeth)', fringe0 > 20, `${fringe0} px`)
check('spill 1 leaves no green in any kept pixel (reference)', fringe1 < 1e-9, `max ${fringe1.toExponential(2)}`)
check('keyAt: absent, bad colour or bad mode = no key; values clamped; spill 0 for luma',
  K.keyAt(undefined, 0, K.evalAnim) === undefined &&
  K.keyAt({ mode: 'chroma', colour: 'green', tolerance: { value: 0.1 }, softness: { value: 0 }, spill: { value: 0 } }, 0, K.evalAnim) === undefined &&
  K.keyAt({ mode: 'x', colour: '#00ff00', tolerance: { value: 0.1 }, softness: { value: 0 }, spill: { value: 0 } }, 0, K.evalAnim) === undefined &&
  JSON.stringify(K.keyAt({ mode: 'luma', colour: '#ffffff', tolerance: { value: 9 }, softness: { value: -1 }, spill: { value: 1 } }, 0, K.evalAnim)) ===
    JSON.stringify({ mode: 2, rgb: [1, 1, 1], tolerance: 1, softness: 0, spill: 0 }))
const kf = { mode: 'chroma', colour: '#14be3c', tolerance: { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: 0.4, easing: 'linear' }] }, softness: { value: 0.1 }, spill: { value: 0 } }
check('keyframable: tolerance 0→0.4 over 2 s is 0.2 at 1 s', Math.abs(K.keyAt(kf, 1, K.evalAnim).tolerance - 0.2) < 1e-12)

// ---- real: the shader through the Compositor ---------------------------------
const page = await bundle(`
import { Compositor } from './src/gl/compositor'
import { keyPixel } from './shared/key'
import { gradeColour, gradeUniform, GRADE_KEYS } from './shared/colour'
import { PACK_GAP, packHeight } from './shared/streamColour'
${PICTURE}
const CASES = ${JSON.stringify(CASES)}
const { px } = picture()
const src = document.createElement('canvas'); src.width = W; src.height = H
src.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0)
// packed: colour, gaps, matte (a left-to-right ramp) — how alpha video reaches the fast decode
const PH = packHeight(H), matte = (x) => Math.round(x * 255 / (W - 1))
const pk = document.createElement('canvas'); pk.width = W; pk.height = PH
const pd = new Uint8ClampedArray(W * PH * 4)
for (let y = 0; y < PH; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 4
  if (y < H + PACK_GAP) pd.set(px.subarray((Math.min(y, H - 1) * W + x) * 4, (Math.min(y, H - 1) * W + x) * 4 + 4), o)
  else { const m = matte(x); pd.set([m, m, m, 255], o) }
}
pk.getContext('2d').putImageData(new ImageData(pd, W, PH), 0, 0)
const comp = new Compositor(document.createElement('canvas'))
const out = new Uint8Array(W * H * 4), res = []
for (const [name, c] of CASES) {
  let max = 0, atp = ''
  for (const bgv of [0, 1]) {
    const g = c?.grade && { ...Object.fromEntries(GRADE_KEYS.map((k) => [k, 0])), ...c.grade }
    comp.setSize(W, H); comp.begin(bgv ? '#ffffff' : '#000000')
    comp.drawLayer({ source: c?.packed ? pk : src, cacheKey: c?.packed ? 'pk' : 'gs', dynamic: false, alphaPacked: !!c?.packed,
      srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      key: c?.key, grade: g ? gradeUniform(g) : undefined,
      shapes: c?.mask ? [{ type: 1, cx: 0.25, cy: 0.5, halfW: 0.25, halfH: 1, featherIn: 0, featherOut: 0, invert: false }] : undefined })
    comp.readPixels(out)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, o = ((H - 1 - y) * W + x) * 4
      const inp = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]
      let rgb = inp, a = 1
      if (c?.key) { const k = keyPixel(inp, c.key); rgb = k.rgb; a = k.alpha }
      if (g) rgb = gradeColour(rgb, g)
      if (c?.mask) a *= x < W / 2 ? 1 : 0
      if (c?.packed) a *= matte(x) / 255
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(out[o + k] - Math.round((rgb[k] * a + bgv * (1 - a)) * 255))
        if (d > max) { max = d; atp = x + ',' + y + (bgv ? ' over white' : ' over black') }
      }
    }
  }
  res.push({ name, max, at: atp })
}
console.log('RESULT ' + JSON.stringify(res))
`, 'browser')

const dir = mkdtempSync(join(tmpdir(), 'kadr-key-'))
try {
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
  const r = spawnSync(exe, [join(dir, 'main.cjs')], { encoding: 'utf8', env, timeout: 60000 })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '))
  if (!line) {
    check('the shader ran in Electron', false, `exit ${r.status}: ${(r.stderr || '').slice(-600)}`)
  } else {
    for (const { name, max, at: p } of JSON.parse(line.slice(7))) {
      const exact = name.startsWith('no key')
      check(`the key reference matches the shader on a generated green screen: ${name}${exact ? ' (exact)' : ' (within 1/255)'}`,
        exact ? max === 0 : max <= 1, `max ${max}${max ? ' at ' + p : ''}`)
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
