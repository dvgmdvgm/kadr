// Node-side check of the trim modes (card E4): roll, slip, slide and Q/W.
// Roll moves a cut between two butted clips, slip changes what part of the
// source a clip shows, slide moves a clip between its neighbours, and Q/W trim
// the clip under the playhead to it with a ripple.
//
// Cost of getting it wrong: cut points that drift — a roll that loses a frame
// on one side, a slip that nudges the clip, a slide that moves an outer edge.
// The store is bundled with esbuild like check-ripple.
// Run: node scripts/check-trim-modes.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  entryPoints: [join(root, 'src', 'state', 'store.ts')],
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
const { useEditor, newProject } = await import(
  'data:text/javascript;base64,' + Buffer.from(out).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const near = (a, b) => Math.abs(a - b) < 1e-9
const clipOf = (id) => s().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const layout = () => Object.fromEntries(s().project.tracks.map((t) => [t.id,
  [...t.clips].sort((a, b) => a.start - b.start).map((c) => [+c.start.toFixed(9), +(c.start + c.duration).toFixed(9)])]))
const has = (name) => typeof s()[name] === 'function'
const need = (...names) => {
  const miss = names.filter((n) => !has(n))
  if (miss.length) check(`${miss.join(', ')} exist`, false)
  return !miss.length
}

const mk = (id, start, duration, inPoint, extra = {}) =>
  ({ id, kind: 'media', assetId: 'a1', start, duration, inPoint, label: id, speed: 1, ...extra })
const tr = (id, kind, clips, locked = false) =>
  ({ id, kind, name: id, muted: false, locked, gain: 1, clips })

/** V1/A1: three butted A/V pairs 0-3, 3-5, 5-9 (source in 10, 20, 30);
    V2 an image 0-2; A3 a locked bed. 30 fps. */
function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [
    { id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080 },
    { id: 'img', kind: 'image', name: 'still', path: '/x/s.png', duration: 0, hasAudio: false, width: 1920, height: 1080 }
  ]
  p.tracks = [
    tr('V2', 'video', [mk('i1', 0, 2, 0, { assetId: 'img' })]),
    tr('V1', 'video', [mk('v1', 0, 3, 10, { linkId: 'L1' }), mk('v2', 3, 2, 20, { linkId: 'L2' }), mk('v3', 5, 4, 30, { linkId: 'L3' })]),
    tr('A1', 'audio', [mk('a1c', 0, 3, 10, { linkId: 'L1' }), mk('a2c', 3, 2, 20, { linkId: 'L2' }), mk('a3c', 5, 4, 30, { linkId: 'L3' })]),
    tr('A3', 'audio', [mk('m', 0, 12, 0)], true)
  ]
  s().setProject(p)
  s().select([])
  s().setRange(null)
  s().setPlayhead(0)
}
const same = (l, v, a = v) => JSON.stringify(l.V1) === v && JSON.stringify(l.A1) === a
const undoRestores = (name, before) => {
  s().undo()
  check(`${name}: one Ctrl+Z restores`, JSON.stringify(layout()) === before, JSON.stringify(layout()))
}

// ---- roll ----------------------------------------------------------------------
fresh()
if (need('rollEdit')) {
  const before = JSON.stringify(layout())
  s().pushHistory('hTrim') // the gesture pushes once
  s().rollEdit('v1', 'v2', 2.5)
  const l = layout()
  check('roll keeps the sum of both durations and moves the cut on the pair\'s both tracks',
    same(l, '[[0,2.5],[2.5,5],[5,9]]') && near(clipOf('v2').inPoint, 19.5) && near(clipOf('a2c').inPoint, 19.5)
      && near(clipOf('v1').inPoint, 10), JSON.stringify(l))
  undoRestores('roll', before)

  fresh()
  s().rollEdit('v1', 'v2', 3.51)
  check('roll lands the cut on a frame', near(clipOf('v1').duration, 105 / 30) && near(clipOf('v2').start, 105 / 30))

  fresh()
  s().rollEdit('v2', 'v3', 5 + 100) // the right clip cannot shrink below a frame
  const v2 = clipOf('v2'), v3 = clipOf('v3')
  check('roll stops at a limit on both sides at once (the cut stays shared)',
    near(v2.start + v2.duration, v3.start) && near(v3.start + v3.duration, 9) && v3.duration > 0, JSON.stringify(layout()))

  fresh()
  clipOf('v2').inPoint = 0.5; clipOf('a2c').inPoint = 0.5
  s().rollEdit('v1', 'v2', 1) // the right clip cannot reveal before its source start
  check('roll clamps at the source start and keeps the cut shared',
    near(clipOf('v1').start + clipOf('v1').duration, clipOf('v2').start) && near(clipOf('v2').start, 2.5)
      && near(clipOf('v2').inPoint, 0), JSON.stringify(layout()))
}

// ---- slip ----------------------------------------------------------------------
fresh()
if (need('slip')) {
  const before = JSON.stringify(layout())
  s().pushHistory('hSlip')
  s().slip('v2', 1)
  const l = layout()
  check('slip keeps start and duration; the source moves on the pair',
    JSON.stringify(l) === before && near(clipOf('v2').inPoint, 21) && near(clipOf('a2c').inPoint, 21), JSON.stringify(l))
  undoRestores('slip', before)

  fresh()
  s().slip('v2', -100)
  check('slip never reveals before the source start', near(clipOf('v2').inPoint, 0))
  fresh()
  s().slip('v2', 100)
  check('slip never reveals past the source end', near(clipOf('v2').inPoint, 58))
  fresh()
  s().slip('i1', 1)
  check('slip on a still is a no-op', near(clipOf('i1').inPoint, 0) && near(clipOf('i1').start, 0))
}

// ---- slide ---------------------------------------------------------------------
fresh()
if (need('slide')) {
  const before = JSON.stringify(layout())
  s().pushHistory('hSlide')
  s().slide('v2', 0.5)
  const l = layout()
  check('slide keeps the neighbours\' outer edges; the clip keeps its source',
    same(l, '[[0,3.5],[3.5,5.5],[5.5,9]]') && near(clipOf('v2').inPoint, 20) && near(clipOf('v3').inPoint, 30.5)
      && near(clipOf('a3c').inPoint, 30.5), JSON.stringify(l))
  undoRestores('slide', before)

  fresh()
  s().slide('v2', -100)
  const l2 = layout()
  const v = l2.V1
  check('slide stops at a limit and every cut stays shared',
    v[0][0] === 0 && v[2][1] === 9 && v[0][1] === v[1][0] && v[1][1] === v[2][0] && v[0][1] > 0
      && JSON.stringify(l2.A1) === JSON.stringify(v) && near(clipOf('v2').duration, 2), JSON.stringify(l2))

  fresh()
  s().slide('v2', 0.51)
  check('slide lands on frames', near(clipOf('v2').start, 105 / 30))
}

// ---- Q / W ---------------------------------------------------------------------
fresh()
if (need('trimToPlayhead')) {
  const before = JSON.stringify(layout())
  s().setPlayhead(4)
  s().trimToPlayhead('out') // W
  const l = layout()
  check('W trims the tail to the playhead and ripples the pair',
    same(l, '[[0,3],[3,4],[4,8]]') && JSON.stringify(l.A3) === '[[0,12]]' && JSON.stringify(l.V2) === '[[0,2]]', JSON.stringify(l))
  undoRestores('W', before)

  fresh()
  s().setPlayhead(4)
  s().trimToPlayhead('in') // Q
  const l2 = layout()
  check('Q trims the head to the playhead, the clip keeps its place, what follows closes up',
    same(l2, '[[0,3],[3,4],[4,8]]') && near(clipOf('v2').inPoint, 21) && near(clipOf('a2c').inPoint, 21)
      && near(s().playhead, 3), JSON.stringify(l2))
  undoRestores('Q', before)

  fresh()
  s().setPlayhead(1)
  s().select(['v1', 'a1c'])
  s().trimToPlayhead('out')
  check('Q/W take the selected clip under the playhead over the top track\'s',
    JSON.stringify(layout().V2) === '[[0,2]]' && near(clipOf('v1').duration, 1), JSON.stringify(layout()))

  fresh()
  s().setPlayhead(1)
  s().trimToPlayhead('out')
  check('Q/W with no selection take the top track\'s clip (the still) — nothing else moves',
    JSON.stringify(layout().V2) === '[[0,1]]' && JSON.stringify(layout().V1) === '[[0,3],[3,5],[5,9]]', JSON.stringify(layout()))
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
