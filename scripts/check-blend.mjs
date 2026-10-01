// J3: blend modes — `shared/blend.ts` holds the W3C formulas and the GLSL of
// the composite pass. This draws a backdrop and a blended layer through the
// REAL Compositor (src/gl/compositor.ts) in a hidden Electron window and
// compares every pixel with the formula applied to the two layers as the
// compositor itself draws them alone. Cost of a regression: overlays that look
// different after export, or a normal clip that is not what it was.
// Needs the installed electron (Windows / a display on Linux). No app, no network.
// Run: node scripts/check-blend.mjs
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

// ---- pure ---------------------------------------------------------------------
const B = await import('data:text/javascript;base64,' + Buffer.from(await bundle(`export * from './shared/blend'`, 'node')).toString('base64'))
check('normal, absent and junk take the untouched path',
  B.blendOf('normal') === undefined && B.blendOf(undefined) === undefined && B.blendOf('bogus') === undefined && B.blendOf('screen') === 'screen')
check('the W3C spot values', B.blendChannel('screen', 0.5, 0.5) === 0.75 && B.blendChannel('multiply', 0.5, 0.5) === 0.25 &&
  B.blendChannel('overlay', 0.25, 0.5) === 0.25 && B.blendChannel('softLight', 0.25, 1) === 0.5 &&
  B.blendChannel('difference', 0.25, 0.75) === 0.5 && B.blendChannel('add', 0.7, 0.7) === 1)

// ---- real: the composite pass through the Compositor --------------------------
const MODES = B.BLEND_MODES.filter((m) => m !== 'normal')
const page = await bundle(`
import { Compositor } from './src/gl/compositor'
import { blendPixel } from './shared/blend'
const W = 256, H = 8, MODES = ${JSON.stringify(MODES)}
let s = 12345
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) % 256
const pattern = (f) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const img = new ImageData(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.data.set([...f(x, y), 255], (y * W + x) * 4)
  c.getContext('2d').putImageData(img, 0, 0); return c
}
// backdrop: grey/red/green/blue ramps + noise; source: reversed ramps across + noise
const back = pattern((x, y) => y === 0 ? [x, x, x] : y === 1 ? [x, 0, 0] : y === 2 ? [0, x, 0] : y === 3 ? [0, 0, x] : [rnd(), rnd(), rnd()])
const src = pattern((x, y) => y === 0 ? [255 - x, 255 - x, 255 - x] : y < 4 ? [x, 255 - x, (x * 5) % 256] : [rnd(), rnd(), rnd()])
const layer = (source, key, opacity, extra = {}) => ({ source, cacheKey: key, dynamic: false, srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity, ...extra })
const read = (comp) => { const o = new Uint8Array(W * H * 4); comp.readPixels(o); return o }
const hash = (a) => { let h = 2166136261; for (const v of a) h = Math.imul(h ^ v, 16777619); return h >>> 0 }
const opaque = new Compositor(document.createElement('canvas'))
const clear = new Compositor(document.createElement('canvas'), { alpha: true })

// what each layer is as the compositor draws it alone (premultiplied readback)
const alone = (comp, bg, draw) => { comp.setSize(W, H); comp.begin(bg); draw(comp); return read(comp) }
const res = []
const CASES = []
for (const m of MODES) {
  CASES.push({ name: m, mode: m, bg: '#000000', comp: opaque, bOp: 1, sOp: 1 })
  CASES.push({ name: m + ' @0.6', mode: m, bg: '#000000', comp: opaque, bOp: 1, sOp: 0.6 })
  CASES.push({ name: m + ' transparent bg, backdrop @0.5', mode: m, bg: 'transparent', comp: clear, bOp: 0.5, sOp: 0.8 })
}
CASES.push({ name: 'screen + blur effect', mode: 'screen', bg: '#000000', comp: opaque, bOp: 1, sOp: 1, blur: 0.4 })
for (const c of CASES) {
  const drawSrc = (comp) => c.blur ? comp.drawLayerFx([layer(src, 'src', c.sOp)], c.blur / H, [], 0) : comp.drawLayer(layer(src, 'src', c.sOp))
  const bPix = alone(c.comp, c.bg, (k) => k.drawLayer(layer(back, 'back', c.bOp)))
  const sPix = alone(clear, 'transparent', drawSrc)
  c.comp.setSize(W, H); c.comp.begin(c.bg)
  c.comp.drawLayer(layer(back, 'back', c.bOp))
  c.comp.drawBlended(c.mode, () => drawSrc(c.comp))
  const out = read(c.comp)
  let max = 0, at = ''
  for (let i = 0; i < W * H * 4; i += 4) {
    const ab = bPix[i + 3] / 255, as = sPix[i + 3] / 255
    const st = (p, a) => [0, 1, 2].map((k) => a > 0 ? Math.min(1, p[i + k] / 255 / a) : 0)
    const [co, ao] = blendPixel(c.mode, st(bPix, ab), ab, st(sPix, as), as)
    // the opaque canvas reads straight colour; the transparent one premultiplied
    const want = c.bg === 'transparent' ? [...co.map((v) => v * ao), ao] : [...co, 1]
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(out[i + k] - Math.round(want[k] * 255))
      if (d > max) { max = d; at = ((i / 4) % W) + ',' + Math.floor(i / 4 / W) + ' ch' + k + ' got ' + out[i + k] + ' want ' + Math.round(want[k] * 255) }
    }
  }
  res.push({ name: c.name, max, at })
}
// normal: the plain draw, and the same draw after a blend pass ran in that compositor (no leaked state)
const normal = () => { opaque.setSize(W, H); opaque.begin('#102030'); opaque.drawLayer(layer(back, 'back', 1)); opaque.drawLayer(layer(src, 'src', 0.6)); return hash(read(opaque)) }
const fresh = new Compositor(document.createElement('canvas'))
fresh.setSize(W, H); fresh.begin('#102030'); fresh.drawLayer(layer(back, 'back', 1)); fresh.drawLayer(layer(src, 'src', 0.6))
res.push({ name: 'normal', h0: hash(read(fresh)), h1: normal() })
console.log('RESULT ' + JSON.stringify(res))
`, 'browser')

const dir = mkdtempSync(join(tmpdir(), 'kadr-blend-'))
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
    check('the composite pass ran in Electron', false, `exit ${r.status}: ${(r.stderr || '').slice(-600)}`)
  } else {
    for (const row of JSON.parse(line.slice(7))) {
      if (row.name === 'normal') check('normal draws bit-identically after a blend pass ran (no leaked GL state)', row.h0 === row.h1, `${row.h0} / ${row.h1}`)
      else check(`each blend mode matches the W3C formula: ${row.name} (within 1/255)`, row.max <= 1, `max ${row.max}${row.max ? ' at ' + row.at : ''}`)
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
