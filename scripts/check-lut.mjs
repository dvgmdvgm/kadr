// J2: a LUT on a clip — `shared/lut.ts` parses .cube files and holds the
// reference sampler and the GLSL the clip shader runs. This checks the parser,
// the reference against ffmpeg's own lut3d (trilinear) and lut1d (linear) on
// the same pixels, and then the REAL Compositor (src/gl/compositor.ts) in a
// hidden Electron window against ffmpeg. Cost of a regression: a look that
// exports differently from what the preview showed, or a LUT that is not the
// one the colourist made.
// Needs ffmpeg in PATH and the installed electron. No app, no network.
// Run: node scripts/check-lut.mjs
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

const L = await import('data:text/javascript;base64,' + Buffer.from(await bundle(`export * from './shared/lut'`, 'node')).toString('base64'))

// ---- the tables ----------------------------------------------------------------
const cube3 = (n, f, extra = '') => {
  const rows = [`TITLE "test"`, `# a comment`, `LUT_3D_SIZE ${n}`, extra]
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++)
    rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '))
  return rows.join('\n') + '\n'
}
const cube1 = (n, f) => {
  const rows = [`LUT_1D_SIZE ${n}`]
  for (let i = 0; i < n; i++) rows.push(f(i / (n - 1)).map((v) => v.toFixed(6)).join(' '))
  return rows.join('\r\n') + '\r\n'
}
// a «look»: cross-channel, strongly non-linear, so interpolation errors show
const look = (r, g, b) => [
  Math.min(1, Math.pow(r, 0.8) * 0.9 + b * 0.1),
  Math.min(1, 0.5 - 0.5 * Math.cos(Math.PI * g) * 0.95 + r * 0.03),
  Math.min(1, Math.pow(b, 1.4) * 0.85 + g * 0.12)
]
const FILES = {
  'identity.cube': cube3(33, (r, g, b) => [r, g, b]),
  'look17.cube': cube3(17, look),
  'look65.cube': cube3(65, look),
  'curve1d.cube': cube1(1024, (x) => [Math.pow(x, 0.6), x * x, 1 - Math.pow(1 - x, 2)])
}

// ---- pure: the parser -------------------------------------------------------------
{
  const id = L.parseCube(FILES['identity.cube'])
  check('a 3D .cube parses: size, dim, row order (red fastest)', id.dim === 3 && id.size === 33 &&
    id.data.length === 33 ** 3 * 3 && id.data[3] > 0 && id.data[4] === 0 && id.data[33 * 3 + 1] > 0)
  const c1 = L.parseCube(FILES['curve1d.cube'])
  check('a 1D .cube parses (CRLF line ends)', c1.dim === 1 && c1.size === 1024 && c1.data.length === 3072)
  const dom = L.parseCube('LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 1 1\n')
  check('DOMAIN_MIN/MAX scale the input', Math.abs(L.sampleLut(dom, [1, 0.5, 2])[0] - 0.5) < 1e-6 &&
    Math.abs(L.sampleLut(dom, [1, 0.5, 2])[1] - 0.25) < 1e-6 && L.sampleLut(dom, [1, 0.5, 2])[2] === 1)
  const bad = (t) => { try { L.parseCube(t); return false } catch { return true } }
  check('a broken .cube is refused (no size, short table, two tables)',
    bad('0 0 0\n1 1 1\n') && bad('LUT_3D_SIZE 2\n0 0 0\n') && bad('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n'))
}

// ---- the test picture: every grey, every primary ramp, and pseudo-random colours --
const W = 256, H = 8
const img = new Uint8Array(W * H * 3); { let s = 12345
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) % 256
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = y === 0 ? [x, x, x] : y === 1 ? [x, 0, 0] : y === 2 ? [0, x, 0] : y === 3 ? [0, 0, x] : [rnd(), rnd(), rnd()]
    img.set(px, (y * W + x) * 3)
  }
}
const dir = mkdtempSync(join(tmpdir(), 'kadr-lut-'))
const ffmpegOut = (filter) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-',
    '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { cwd: dir, input: Buffer.from(img), maxBuffer: 1 << 24 })
  if (r.status !== 0 || r.stdout.length !== W * H * 3) throw new Error(`ffmpeg ${filter}: ${r.stderr}`)
  return r.stdout
}
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m }
const refOut = (lut) => {
  const o = new Uint8Array(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    const v = L.sampleLut(lut, [img[i * 3] / 255, img[i * 3 + 1] / 255, img[i * 3 + 2] / 255])
    for (let k = 0; k < 3; k++) o[i * 3 + k] = Math.round(Math.min(1, Math.max(0, v[k])) * 255)
  }
  return o
}

try {
  const ff = {}
  for (const f of Object.keys(FILES)) {
    writeFileSync(join(dir, f), FILES[f])
    ff[f] = f.includes('1d') ? ffmpegOut(`lut1d=file=${f}:interp=linear`) : ffmpegOut(`lut3d=file=${f}:interp=trilinear`)
  }
  // ---- the reference against ffmpeg ------------------------------------------------
  for (const f of Object.keys(FILES)) {
    const m = maxDiff(refOut(L.parseCube(FILES[f])), ff[f])
    check(`a .cube parses and samples like ffmpeg ${f.includes('1d') ? 'lut1d' : 'lut3d'}: ${f} (within 2)`, m <= 2, `max ${m}`)
  }

  // ---- the shader, through the real Compositor -------------------------------------
  const CASES = [
    { name: 'no LUT', file: null, mix: 1 },
    ...Object.keys(FILES).map((file) => ({ name: file, file, mix: 1 })),
    { name: 'look17.cube at intensity 0.5', file: 'look17.cube', mix: 0.5 },
    { name: 'look17.cube at intensity 0', file: 'look17.cube', mix: 0 }
  ]
  const page = await bundle(`
import { Compositor } from './src/gl/compositor'
import { parseCube } from './shared/lut'
const W = ${W}, H = ${H}, CASES = ${JSON.stringify(CASES)}, FILES = ${JSON.stringify(FILES)}
const IMG = ${JSON.stringify(Array.from(img))}
const src = document.createElement('canvas'); src.width = W; src.height = H
const id = new ImageData(W, H)
for (let i = 0; i < W * H; i++) id.data.set([IMG[i * 3], IMG[i * 3 + 1], IMG[i * 3 + 2], 255], i * 4)
src.getContext('2d').putImageData(id, 0, 0)
const comp = new Compositor(document.createElement('canvas'))
const out = new Uint8Array(W * H * 4), res = {}
const tables = {}
for (const c of CASES) {
  const table = c.file ? (tables[c.file] ??= parseCube(FILES[c.file])) : null
  comp.setSize(W, H); comp.begin('#000000')
  comp.drawLayer({ source: src, cacheKey: 'ramp', dynamic: false, srcWidth: W, srcHeight: H, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
    lut: table ? { table, mix: c.mix } : undefined })
  comp.readPixels(out)
  const rgb = new Array(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++)
    rgb[(y * W + x) * 3 + k] = out[((H - 1 - y) * W + x) * 4 + k]   // readback rows are bottom-up
  res[c.name] = rgb
}
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
  if (!line) {
    check('the shader ran in Electron', false, `exit ${r.status}: ${(r.stderr || '').slice(-600)}`)
  } else {
    const got = JSON.parse(line.slice(7))
    check('no LUT: the picture is untouched (exact)', maxDiff(got['no LUT'], img) === 0, `max ${maxDiff(got['no LUT'], img)}`)
    const idm = maxDiff(got['identity.cube'], img)
    check('an identity LUT is a no-op within 1 unit', idm <= 1, `max ${idm}`)
    for (const f of ['look17.cube', 'look65.cube', 'curve1d.cube']) {
      const m = maxDiff(got[f], ff[f])
      check(`the shader matches ffmpeg on the same frame: ${f} (within 2)`, m <= 2, `max ${m}`)
    }
    const half = refOut(L.parseCube(FILES['look17.cube'])).map((v, i) => Math.round((v + img[i]) / 2))
    const hm = maxDiff(got['look17.cube at intensity 0.5'], half)
    check('intensity 0.5 is half way between the picture and the look (within 2)', hm <= 2, `max ${hm}`)
    const zm = maxDiff(got['look17.cube at intensity 0'], img)
    check('intensity 0 leaves the picture within 1 unit', zm <= 1, `max ${zm}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
