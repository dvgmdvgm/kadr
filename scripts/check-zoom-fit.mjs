// Node-side check of the timeline's view actions (card E8): Shift+Z (fit the
// whole timeline) and Alt+Z (fit the selection) pick a zoom and a left edge
// that show exactly the span plus the margin; the playhead follow pages (or
// centres) the view only while it runs off the side it is heading to.
//
// Cost of getting it wrong: a zoom that crops the ends, or a view that jumps
// while the playhead is still on screen.
// Run: node scripts/check-zoom-fit.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  entryPoints: [join(root, 'src', 'engine', 'timelineMath.ts')],
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const { fitZoom, followLeft, FIT_MARGIN, MIN_ZOOM, MAX_ZOOM } =
  await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

// ---------------------------------------------------------------- fit
// the view cannot start before 0, so a span from 0 (Shift+Z) starts at the lanes' edge
for (const [a, b, lanes] of [[0, 60, 1350], [12.5, 14, 1000], [0, 1140, 1350], [300, 3900, 1350], [0.1, 20, 1000]]) {
  const f = fitZoom(a, b, lanes)
  const x0 = (a - f.t0) * f.zoom // px from the lanes' left edge to the span's start
  const x1 = (b - f.t0) * f.zoom
  const head = f.t0 === 0 ? a * f.zoom : FIT_MARGIN
  check(`fit and selection zoom produce a scale that shows exactly the span plus margin: [${a}, ${b}] in ${lanes} px`,
    f.t0 >= 0 && near(x0, head) && x0 <= FIT_MARGIN + 1e-6 && near(x1, lanes - FIT_MARGIN), { zoom: f.zoom, t0: f.t0, x0, x1 })
}
{
  // an hour at 1350 px needs 0.37 px/s — below the old 4 px/s floor
  const f = fitZoom(0, 3600, 1350)
  check('a one-hour timeline fits (the zoom floor is low enough)', f.zoom >= MIN_ZOOM && near(f.zoom, (1350 - FIT_MARGIN) / 3600))
}
{
  // a 1-frame span would ask for more than MAX_ZOOM: clamp and centre it
  const f = fitZoom(10, 10.001, 1000)
  const mid = (10.0005 - f.t0) * f.zoom
  check('a span too short for MAX_ZOOM is centred at MAX_ZOOM', f.zoom === MAX_ZOOM && near(mid, 500, 1), { zoom: f.zoom, mid })
}
check('an empty span fits nothing', fitZoom(5, 5, 1000) === null && fitZoom(0, 10, 0) === null)

// ---------------------------------------------------------------- follow
const L = 1000 // lanes px; view shows [left, left + L)
check('follow off never moves the view', followLeft('off', 5000, 0, L, 1) === null)
check('page: the playhead on screen moves nothing', followLeft('page', 900, 0, L, 1) === null)
{
  const left = followLeft('page', 1000, 0, L, 1)
  check('page: past the right edge the next page starts just before the playhead',
    left !== null && left < 1000 && left > 900, left)
}
{
  const left = followLeft('page', 1990, 1000, L, -1) // reverse, on screen
  check('page in reverse: on screen moves nothing', left === null)
  const back = followLeft('page', 999, 1000, L, -1)
  check('page in reverse: past the left edge the playhead lands near the right edge',
    back !== null && back + L > 999 && back + L - 999 < 100, back)
}
check('page: a playhead scrolled off to the left is brought back', followLeft('page', 100, 5000, L, 1) !== null)
check('smooth: before the centre nothing moves', followLeft('smooth', 400, 0, L, 1) === null)
check('smooth: past the centre the playhead is held there', followLeft('smooth', 700, 0, L, 1) === 200)
check('smooth: never scrolls below 0', followLeft('smooth', 300, 0, L, -1) === null)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
