// J1: primary colour correction — `shared/colour.ts` holds the reference maths
// and the GLSL the clip shader runs. This renders test ramps through the REAL
// Compositor (src/gl/compositor.ts) in a hidden Electron window and compares
// every pixel with the reference. Cost of a regression: the preview and the
// export disagree on colour with nothing else to show it, or a clip with no
// grade changes a pixel.
// Needs the installed electron (Windows / a display on Linux). No app, no network.
// Run: node scripts/check-colour-math.mjs
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const alias = { '@shared': join(root, 'shared'), '@': join(root, 'src') }
// the compositor's error strings pull in the store through i18n; the page needs none of it
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

// ---- pure: the reference and the per-frame values ----------------------------
const C = await import('data:text/javascript;base64,' + Buffer.from(await bundle(
  `export * from './shared/colour'; export { evalAnim } from './src/engine/anim'`, 'node')).toString('base64'))
const zero = Object.fromEntries(C.GRADE_KEYS.map((k) => [k, 0]))
const ramp = []
for (let i = 0; i < 256; i++) ramp.push([i / 255, i / 255, i / 255], [i / 255, (255 - i) / 255, (i * 7 % 256) / 255])
check('neutral settings are an exact no-op (reference)',
  ramp.every((c) => { const o = C.gradeColour(c, zero); return o[0] === c[0] && o[1] === c[1] && o[2] === c[2] }))
check('exposure +1 doubles linear light (reference, within 1/255)', ramp.every((c) => {
  const o = C.gradeColour(c, { ...zero, exposure: 1 })
  return c.every((v, i) => Math.abs(o[i] * 255 - C.linearToSrgb(Math.min(1, 2 * C.srgbToLinear(v))) * 255) <= 1)
}))
const g = { exposure: { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 1, value: 2, easing: 'linear' }] } }
check('a keyframed exposure: neutral at its 0 key (the shader skips), 1 stop halfway',
  C.gradeAt(g, 0, C.evalAnim) === undefined && C.gradeAt(g, 0.5, C.evalAnim)?.[0] === 1 &&
  C.gradeAt(undefined, 0.5, C.evalAnim) === undefined)
check('values are clamped to their range', C.gradeAt({ contrast: { value: 9 }, exposure: { value: -99 } }, 0, C.evalAnim)
  .join() === [-8, 1, 0, 0, 0, 0, 0].join())

// ---- real: the shader through the Compositor ---------------------------------
const CASES = [
  ['none', null], ['neutral', { ...zero }], ['exposure +1', { ...zero, exposure: 1 }], ['exposure -2', { ...zero, exposure: -2 }],
  ['contrast +0.6', { ...zero, contrast: 0.6 }], ['contrast -0.8', { ...zero, contrast: -0.8 }],
  ['saturation +0.7', { ...zero, saturation: 0.7 }], ['saturation -1', { ...zero, saturation: -1 }],
  ['temperature +0.8', { ...zero, temperature: 0.8 }], ['tint -0.6', { ...zero, tint: -0.6 }],
  ['highlights -0.9', { ...zero, highlights: -0.9 }], ['shadows +0.9', { ...zero, shadows: 0.9 }],
  ['all at once', { exposure: 0.4, contrast: 0.3, saturation: -0.3, temperature: -0.5, tint: 0.4, highlights: -0.5, shadows: 0.5 }]
]
const page = await bundle(`
import { Compositor } from './src/gl/compositor'
import { gradeColour, gradeUniform, gradeIsNeutral } from './shared/colour'
const W = 256, H = 8, CASES = ${JSON.stringify(CASES)}
const src = document.createElement('canvas'); src.width = W; src.height = H
const img = new ImageData(W, H); let s = 12345
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) % 256
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 4
  const px = y === 0 ? [x, x, x] : y === 1 ? [x, 0, 0] : y === 2 ? [0, x, 0] : y === 3 ? [0, 0, x] : [rnd(), rnd(), rnd()]
  img.data.set([...px, 255], o)
}
src.getContext('2d').putImageData(img, 0, 0)
const comp = new Compositor(document.createElement('canvas'))
const out = new Uint8Array(W * H * 4), res = []
for (const [name, g] of CASES) {
  comp.setSize(W, H); comp.begin('#000000')
  comp.drawLayer({ source: src, cacheKey: 'ramp', dynamic: false, srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
    grade: g && !gradeIsNeutral(g) ? gradeUniform(g) : undefined })
  comp.readPixels(out)
  let max = 0, at = ''
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, o = ((H - 1 - y) * W + x) * 4  // readback rows are bottom-up
    const inp = [0, 1, 2].map((k) => img.data[i + k] / 255)
    const ref = g ? gradeColour(inp, g) : inp
    for (let k = 0; k < 3; k++) { const d = Math.abs(out[o + k] - Math.round(ref[k] * 255)); if (d > max) { max = d; at = x + ',' + y } }
  }
  res.push({ name, max, at })
}
console.log('RESULT ' + JSON.stringify(res))
`, 'browser')

const dir = mkdtempSync(join(tmpdir(), 'kadr-colour-'))
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
    const rows = JSON.parse(line.slice(7))
    for (const { name, max, at } of rows) {
      const exact = name === 'none' || name === 'neutral'
      check(`the shader matches the reference: ${name}${exact ? ' (exact)' : ' (within 1/255)'}`,
        exact ? max === 0 : max <= 1, `max ${max}${max ? ' at ' + at : ''}`)
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
