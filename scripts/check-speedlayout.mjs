// Node-side check of src/engine/speedLayout.ts — how a group of clips is laid
// out when its speed changes (Alt/Ctrl edge drag, the speed dial).
// Run: node scripts/check-speedlayout.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src', 'engine', 'speedLayout.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { layoutSpeeds } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b) => Math.abs(a - b) < 1e-9
const byId = (out) => Object.fromEntries(out.map((e) => [e.id, e]))

// back-to-back pair with a 1 s gap before the third clip, one track
const row = [
  { id: 'b', trackId: 'v', start: 4, duration: 4, speed: 1 },
  { id: 'a', trackId: 'v', start: 0, duration: 4, speed: 1 },
  { id: 'c', trackId: 'v', start: 9, duration: 2, speed: 2 }
]
let r = byId(layoutSpeeds(row, (it) => it.speed / 2, 'start'))
check('half speed doubles every duration', near(r.a.duration, 8) && near(r.b.duration, 8) && near(r.c.duration, 4))
check('speed is the function’s answer', near(r.a.speed, 0.5) && near(r.c.speed, 1))
check('first clip keeps its start', near(r.a.start, 0))
check('neighbours stay back to back', near(r.b.start, 8))
check('a gap keeps its length', near(r.c.start, 17), `c.start=${r.c.start}`)

const late = row.map((it) => ({ ...it, start: it.start + 20 }))
r = byId(layoutSpeeds(late, (it) => it.speed / 2, 'end'))
check('end anchor: last clip keeps its end', near(r.c.start + r.c.duration, 31))
check('end anchor: chain runs backwards', near(r.b.start + r.b.duration, r.c.start - 1) && near(r.a.start + r.a.duration, r.b.start))

// an overlap (a transition) keeps its length
const ov = [
  { id: 'a', trackId: 'v', start: 0, duration: 4, speed: 1 },
  { id: 'b', trackId: 'v', start: 3, duration: 4, speed: 1 }
]
r = byId(layoutSpeeds(ov, () => 2, 'start'))
check('overlap keeps its length', near(r.a.start + r.a.duration - r.b.start, 1), `b.start=${r.b.start}`)

// tracks are laid out independently
r = byId(layoutSpeeds([
  { id: 'v1', trackId: 'v', start: 2, duration: 2, speed: 1 },
  { id: 'a1', trackId: 'a', start: 5, duration: 2, speed: 1 }
], () => 0.5, 'start'))
check('each track anchors on its own first clip', near(r.v1.start, 2) && near(r.a1.start, 5))

// clamping and the left wall
r = byId(layoutSpeeds([{ id: 'x', trackId: 'v', start: 0, duration: 1, speed: 1 }], () => 1000, 'start'))
check('speed clamps to the max', near(r.x.speed, 100) && near(r.x.duration, 0.01))
r = byId(layoutSpeeds([{ id: 'x', trackId: 'v', start: 1, duration: 2, speed: 1 }], () => 0.5, 'end'))
check('start never goes below zero', r.x.start >= 0)

if (fails) {
  console.log(`\n${fails} FAILED`)
  process.exit(1)
}
console.log('\nall passed')
