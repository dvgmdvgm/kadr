// J8: the scopes' binning (`shared/scopes.ts`) — the luma waveform, the RGB
// parade, the BT.709 vectorscope and the RGB histogram are counted from the
// RGBA pixels the preview read back. Checked on SMPTE-style 75 % colour bars,
// whose every scope is textbook: two histogram spikes per channel at 0 and
// 191 with known counts, one luma level per bar, every bar on its vectorscope
// target and white in the centre.
// Cost of a regression: scopes that lie — a grade judged on a wrong trace.
// No app, no network. Run: node scripts/check-scope-bins.mjs
import { build } from 'esbuild'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (await build({
  stdin: { contents: `export * from './shared/scopes'`, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'
})).outputFiles[0].text
const S = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// 75 % bars, 20 px wide, 10 px high: W Y C G M R B
const V = 191
const BARS = [[V, V, V], [V, V, 0], [0, V, V], [0, V, 0], [V, 0, V], [V, 0, 0], [0, 0, V]]
const BW = 20, W = BARS.length * BW, H = 10
const px = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const c = BARS[Math.floor(x / BW)], i = (y * W + x) * 4
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
}
const N = BW * H // pixels per bar

// "histogram bins of colour bars match the expected counts"
const h = S.histogram(px, W, H)
for (const [ch, k] of [['r', 0], ['g', 1], ['b', 2]]) {
  const on = BARS.filter((c) => c[k] === V).length
  const rest = [...h[ch]].reduce((a, v, i) => a + (i === 0 || i === V ? 0 : v), 0)
  check(`histogram bins of colour bars match the expected counts: ${ch}`,
    h[ch][V] === on * N && h[ch][0] === (BARS.length - on) * N && rest === 0,
    `${ch}[191]=${h[ch][V]} (want ${on * N}), ${ch}[0]=${h[ch][0]} (want ${(BARS.length - on) * N}), elsewhere ${rest}`)
}

// luma waveform: each bar's columns hold all its pixels on the one row of its luma
const COLS = BARS.length, ROWS = 100
const wave = S.waveGrid(px, W, H, 'y', COLS, ROWS)
let waveOk = true, why = ''
BARS.forEach((c, b) => {
  const row = S.waveRow(S.luma709(c[0], c[1], c[2]), ROWS)
  if (wave[row * COLS + b] !== N) { waveOk = false; why += ` bar ${b}: ${wave[row * COLS + b]} at row ${row}` }
})
check('luma waveform: every bar is one level, at its BT.709 luma', waveOk && wave.reduce((a, v) => a + v, 0) === W * H, why)
check('luma waveform: white 75 % sits at 75 % (row 25 of 100 from the top)', S.waveRow(V, 100) === 25, `row ${S.waveRow(V, 100)}`)
check('luma waveform: black at the bottom row, full white at the top', S.waveRow(0, 100) === 99 && S.waveRow(255, 100) === 0)

// parade: the red bar's column in R is at 191, in G and B at 0
const pr = S.waveGrid(px, W, H, 'r', COLS, ROWS), pg = S.waveGrid(px, W, H, 'g', COLS, ROWS)
check('parade: the red bar is 191 in R and 0 in G', pr[S.waveRow(V, ROWS) * COLS + 5] === N && pg[S.waveRow(0, ROWS) * COLS + 5] === N)

// vectorscope: every coloured bar on its 75 % target cell, white in the centre
const n = 100, vg = S.vectorGrid(px, W, H, n)
const cell = (rgb) => { const [x, y] = S.vectorAt(...S.cbcr709(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255), n).map(Math.floor); return y * n + x }
const names = { 1: 'Yl', 2: 'Cy', 3: 'G', 4: 'Mg', 5: 'R', 6: 'B' }
for (const b of [1, 2, 3, 4, 5, 6]) {
  const tgt = S.VECTOR_TARGETS.find((t) => t.name === names[b])
  const c = cell(BARS[b]), cx = c % n, cy = Math.floor(c / n)
  // 191 is 74.9 %: the bar may sit in the cell next to the exact 75 % point
  check(`vectorscope: bar ${names[b]} lands in its 75 % target`, vg[c] === N && Math.abs(cx + 0.5 - tgt.x) < 1 && Math.abs(cy + 0.5 - tgt.y) < 1,
    `count ${vg[c]} at ${cx},${cy}, target ${tgt.x.toFixed(2)},${tgt.y.toFixed(2)}`)
}
check('vectorscope: white is in the centre cell', vg[50 * n + 50] === N, `count ${vg[50 * n + 50]}`)
// full Cb (pure blue) and full Cr (pure red) reach 90 % of the radius on their axes
const red100 = S.vectorAt(...S.cbcr709(1, 0, 0), n), blue100 = S.vectorAt(...S.cbcr709(0, 0, 1), n)
check('vectorscope: 100 % Cb / Cr sit at 90 % of the radius', Math.abs(blue100[0] - 95) < 1e-9 && Math.abs(red100[1] - 5) < 1e-9, `blue x ${blue100[0]}, red y ${red100[1]}`)
check('vectorscope: red is up-left (Cr up, Cb right)', red100[1] < 50 && red100[0] < 50)

// the readback size keeps the aspect and stays small
const [sw, sh] = S.scopeSize(1920, 1080)
check('readback size: 320 wide, aspect kept', sw === 320 && sh === 180, `${sw}×${sh}`)
const [tw, th] = S.scopeSize(100, 50)
check('readback size: never larger than the frame', tw === 100 && th === 50, `${tw}×${th}`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
