// Node-side check of the playback clock (card E5): the anchored clock runs at a
// signed rate, wraps at the loop end, stops at the edge otherwise; and the
// J/K/L, loop and play in→out actions of the store.
//
// Cost of getting it wrong: J/K/L that drifts or skips, a loop that jumps a
// frame at every wrap, play in→out that runs past the out.
// Run: node scripts/check-clock.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = (entry) => buildSync({
  entryPoints: [join(root, ...entry)],
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const load = (text) => import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
const { advanceClock } = await load(bundle(['src', 'engine', 'timelineMath.ts']))
const { useEditor } = await load(bundle(['src', 'state', 'store.ts']))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

// ---------------------------------------------------------------- the clock
{
  const a = { ts: 1000, t: 5, rate: 2 }
  const r = advanceClock(a, 4000, 0, 100, false)
  check('the anchored clock advances rate×wall time and wraps at the loop end: 2x for 3 s = 6 s',
    near(r.t, 11) && !r.stop && !r.wrapped, r)
  const b = advanceClock({ ts: 0, t: 10, rate: -1 }, 2500, 0, 100, false)
  check('reverse 1x for 2.5 s goes back 2.5 s', near(b.t, 7.5) && !b.stop, b)
  const c = advanceClock({ ts: 0, t: 9, rate: 1 }, 2000, 0, 10, false)
  check('forward stops at the end, on it', near(c.t, 10) && c.stop, c)
  const d = advanceClock({ ts: 0, t: 1, rate: -4 }, 1000, 0, 10, false)
  check('reverse stops at the start, on it', near(d.t, 0) && d.stop, d)
  // loop 2–4: 3.9 + 0.25 s → 2.15, not 2 and not 4.15
  const e = advanceClock({ ts: 0, t: 3.9, rate: 1 }, 250, 2, 4, true)
  check('loop wraps seamlessly: the overshoot carries into the start', near(e.t, 2.15) && e.wrapped && !e.stop, e)
  const f = advanceClock({ ts: 0, t: 2.1, rate: -1 }, 250, 2, 4, true)
  check('reverse loop wraps to the end the same way', near(f.t, 3.85) && f.wrapped, f)
  const g = advanceClock({ ts: 0, t: 3, rate: 8 }, 1000, 2, 4, true)
  check('a wrap longer than the span stays inside it', g.t >= 2 && g.t < 4 && near(g.t, 3), g)
  const h = advanceClock({ ts: 0, t: 7, rate: 1 }, 100, 2, 4, true)
  check('a loop started past its out jumps to its in', near(h.t, 2.1, 1e-6) && h.wrapped, h)
  // wall time split into frames lands on the same place as one long step
  let anc = { ts: 0, t: 2, rate: 1 }, t = 0
  for (let i = 0; i <= 300; i++) {
    const ts = (i * 1000) / 60
    const r2 = advanceClock(anc, ts, 2, 4, true)
    t = r2.t
    if (r2.wrapped) anc = { ts, t: r2.t, rate: 1 }
  }
  check('5 s of 60 Hz frames in a 2 s loop end where one step would', near(t, 2 + (5 % 2), 1e-6), t)
}

// ---------------------------------------------------------------- J/K/L
const s = () => useEditor.getState()
{
  s().setPlaying(false)
  check('defaults: rate 1, loop off', s().playRate === 1 && s().loop === false)
  s().shuttle(1)
  check('L plays forward at 1x', s().playing && s().playRate === 1)
  s().shuttle(1)
  check('L,L = 2x', s().playRate === 2)
  s().shuttle(1); s().shuttle(1); s().shuttle(1)
  check('L steps 1, 2, 4, 8 and stays at 8', s().playRate === 8)
  s().shuttle(-1)
  check('J while forward plays backwards at 1x', s().playing && s().playRate === -1)
  s().shuttle(-1)
  check('J,J = -2x', s().playRate === -2)
  s().setPlaying(false)
  check('K (pause) brings the rate back to 1', !s().playing && s().playRate === 1)
  s().shuttle(1); s().shuttle(1); s().setPlaying(false); s().setPlaying(true)
  check('play after a pause is 1x', s().playRate === 1)
  s().setPlaying(false)
}

// ---------------------------------------------------------------- loop, play in→out
{
  s().toggleLoop()
  check('toggleLoop turns it on', s().loop === true)
  s().toggleLoop()
  check('and off', s().loop === false)
  s().setRange({ start: 2, end: 4 })
  s().setPlayhead(10)
  s().playInOut()
  check('play in→out: playhead at the in, 1x, stops at the out', s().playing && near(s().playhead, 2) && s().playRate === 1 && near(s().playEnd, 4),
    { p: s().playhead, e: s().playEnd })
  s().setPlaying(false)
  check('a pause forgets the out', s().playEnd === null)
  s().setRange(null)
}

console.log(fails ? `\n${fails} FAIL` : '\nall passed')
process.exit(fails ? 1 : 0)
