// Node-side check of ripple trim and ripple insert (card E3): trimming an edge
// with Shift, a Shift-drop from the bin and Ctrl+Shift+V move what follows
// instead of leaving a gap or piling onto the neighbour. All through E2's
// `shiftAfter`.
//
// Cost of getting it wrong: a desynced timeline after every trim — the video
// moves and its sound stays, or a track nobody touched slides along.
// The store is bundled with esbuild like check-ripple.
// Run: node scripts/check-ripple-trim.mjs
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

const mk = (id, start, duration, extra = {}) =>
  ({ id, kind: 'media', assetId: 'a1', start, duration, inPoint: 10, label: id, speed: 1, ...extra })
const tr = (id, kind, clips, locked = false) =>
  ({ id, kind, name: id, muted: false, locked, gain: 1, clips })

/** V1/A1: three A/V pairs (1–3) with a gap 5–6; V2 a title over clip 3;
    A2 an unlinked sound at 7; A3 a locked bed from 8. 30 fps. */
function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [
    { id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080 },
    { id: 'a2', kind: 'video', name: 'insert', path: '/x/ins.mp4', duration: 2, hasAudio: true, width: 1920, height: 1080 },
    { id: 'img', kind: 'image', name: 'still', path: '/x/s.png', duration: 0, hasAudio: false, width: 1920, height: 1080 }
  ]
  p.tracks = [
    tr('V2', 'video', [mk('t3', 7, 2, { kind: 'text' })]),
    tr('V1', 'video', [mk('v1', 0, 3, { linkId: 'L1' }), mk('v2', 3, 2, { linkId: 'L2' }), mk('v3', 6, 4, { linkId: 'L3' })]),
    tr('A1', 'audio', [mk('a1c', 0, 3, { linkId: 'L1' }), mk('a2c', 3, 2, { linkId: 'L2' }), mk('a3c', 6, 4, { linkId: 'L3' })]),
    tr('A2', 'audio', [mk('sfx', 7, 1)]),
    tr('A3', 'audio', [mk('m', 8, 5)], true)
  ]
  s().setProject(p)
  s().select([])
  s().setRange(null)
  s().setPlayhead(0)
}
const untouched = (l) => JSON.stringify(l.V2) === '[[7,9]]' && JSON.stringify(l.A2) === '[[7,8]]' && JSON.stringify(l.A3) === '[[8,13]]'

// ---- ripple trim -----------------------------------------------------------------
fresh()
if (!has('rippleTrim')) check('rippleTrim exists', false)
else {
  s().rippleTrim('v2', 'out', 4) // out point 1 s left
  const l = layout()
  check('ripple trim moves only what follows, on the clip\'s and its twin\'s tracks',
    JSON.stringify(l.V1) === '[[0,3],[3,4],[5,9]]' && JSON.stringify(l.A1) === '[[0,3],[3,4],[5,9]]' && untouched(l),
    JSON.stringify(l))
  s().rippleTrim('v2', 'out', 5.5) // and back out past where it was: absolute, not cumulative
  const l2 = layout()
  check('ripple trim of the out point is absolute (drag back and forth)',
    JSON.stringify(l2.V1) === '[[0,3],[3,5.5],[6.5,10.5]]' && JSON.stringify(l2.A1) === JSON.stringify(l2.V1) && untouched(l2),
    JSON.stringify(l2))

  fresh()
  s().rippleTrim('v2', 'in', 3.5) // in point 0.5 s right: the clip keeps its start
  const l3 = layout()
  check('ripple trim of the in point keeps the start, takes the head off the source and pulls what follows',
    JSON.stringify(l3.V1) === '[[0,3],[3,4.5],[5.5,9.5]]' && JSON.stringify(l3.A1) === JSON.stringify(l3.V1) &&
    near(clipOf('v2').inPoint, 10.5) && near(clipOf('a2c').inPoint, 10.5) && untouched(l3),
    JSON.stringify(l3))

  fresh()
  s().updateClip('v2', { inPoint: 1 }); s().updateClip('a2c', { inPoint: 1 })
  s().rippleTrim('v2', 'in', 0) // 3 s back asked, 1 s of source there
  check('ripple trim of the in point never reveals before the source start',
    near(clipOf('v2').inPoint, 0) && near(clipOf('v2').start, 3) && near(clipOf('v2').duration, 3) && near(clipOf('v3').start, 7),
    JSON.stringify(layout()))

  fresh()
  s().rippleTrim('v2', 'out', 3.012) // a sub-frame request lands on frames
  const f = (x) => Math.abs(x * 30 - Math.round(x * 30)) < 1e-6
  check('ripple trim lands on frames', f(clipOf('v2').duration) && f(clipOf('v3').start), JSON.stringify(layout()))

  // a crossfade partner starting before the old out point spans it: it is trimmed around, never moved
  fresh()
  s().updateClip('v3', { start: 4.5 }); s().updateClip('a3c', { start: 4.5 })
  s().rippleTrim('v2', 'out', 4)
  check('a clip spanning the old out point (a crossfade) does not move', near(clipOf('v3').start, 4.5), JSON.stringify(layout()))
}

// ---- ripple insert -------------------------------------------------------------------
fresh()
{
  const before = JSON.stringify(s().project)
  s().insertClipsFromAssets(['a2'], 'V1', 3, true) // a 2 s A/V clip dropped at the cut
  const l = layout()
  check('a Shift-drop at a cut moves the right-hand clips right by its length, on its track and its twin\'s',
    JSON.stringify(l.V1) === '[[0,3],[3,5],[5,7],[8,12]]' && JSON.stringify(l.A1) === JSON.stringify(l.V1) && untouched(l),
    JSON.stringify(l))
  s().undo()
  check('one Ctrl+Z restores an insert', JSON.stringify(s().project) === before)

  s().insertClipsFromAssets(['a2'], 'V1', 3)
  check('a plain drop still overlays (nothing moves)', near(clipOf('v2').start, 3) && near(clipOf('v3').start, 6), JSON.stringify(layout()))
}
fresh()
{
  s().insertClipsFromAssets(['a2'], 'V1', 4, true) // mid clip 2 (3–5)
  const l = layout()
  const v1 = s().project.tracks.find((t) => t.id === 'V1').clips
  const a1 = s().project.tracks.find((t) => t.id === 'A1').clips
  const vr = v1.find((c) => near(c.start, 6)), ar = a1.find((c) => near(c.start, 6))
  check('an insert inside a clip splits it and pushes the right half (twins split pairwise)',
    JSON.stringify(l.V1) === '[[0,3],[3,4],[4,6],[6,7],[8,12]]' && JSON.stringify(l.A1) === JSON.stringify(l.V1) &&
    vr && ar && vr.linkId && vr.linkId === ar.linkId && vr.linkId !== 'L2' && near(vr.inPoint, 11),
    JSON.stringify(l))
}
fresh()
{
  s().insertClipsFromAssets(['img'], 'V1', 3, true) // a still: no audio twin of its own
  const l = layout()
  check('an insert on V1 keeps the A1 twins of what it pushes in sync',
    near(clipOf('v2').start, clipOf('a2c').start) && near(clipOf('v3').start, clipOf('a3c').start) && clipOf('v2').start > 3 && untouched(l),
    JSON.stringify(l))
}

// ---- paste as insert -------------------------------------------------------------------
fresh()
if (!has('pasteAtPlayhead')) check('pasteAtPlayhead exists', false)
else {
  s().select(['v1', 'a1c']); s().copySelection()
  s().setPlayhead(3)
  const before = JSON.stringify(s().project)
  s().pasteAtPlayhead(true)
  const l = layout()
  check('Ctrl+Shift+V pastes as an insert: what follows moves right by the pasted length',
    JSON.stringify(l.V1) === '[[0,3],[3,6],[6,8],[9,13]]' && JSON.stringify(l.A1) === JSON.stringify(l.V1) && untouched(l),
    JSON.stringify(l))
  s().undo()
  check('one Ctrl+Z restores a paste-insert', JSON.stringify(s().project) === before)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
