// L1: markers carry a note and a colour, list together with clip markers, and
// the playhead jumps between them. A clip marker is stored in SOURCE seconds,
// so it stays on the same picture whatever the clip goes through — moved,
// trimmed, slipped, re-sped, split. The cost of getting that wrong is a note
// pointing at the wrong frame.
// The store is bundled with esbuild like check-ripple-trim.
// Run: node scripts/check-markers.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error',
    mainFields: ['module', 'main'],
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const { useEditor, newProject, sanitizeProject } = await load(`export { useEditor, newProject, sanitizeProject } from './src/state/store'`)
let M = {}
try { M = await load(`export * from './shared/markers'`) } catch { /* red: no module yet */ }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-6
const clipOf = (id) => s().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const has = (name) => typeof s()[name] === 'function'
const mk = (id, start, duration, extra = {}) =>
  ({ id, kind: 'media', assetId: 'a1', start, duration, inPoint: 10, label: id, speed: 1, ...extra })

function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [{ id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: false, width: 1920, height: 1080 }]
  p.tracks = [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [mk('c', 2, 4), mk('d', 8, 2)] }]
  p.markers = []
  s().setProject(p)
  s().setPlayhead(0)
}
/** where the clip's only marker is on the timeline now (null = hidden) */
const at = () => {
  const c = clipOf('c')
  return M.clipMarkerTime ? M.clipMarkerTime(c, c.markers?.[0]?.source ?? NaN) : null
}

check('shared/markers exports clipMarkerTime, markerRows, nextMarkerTime',
  ['clipMarkerTime', 'markerRows', 'nextMarkerTime'].every((k) => typeof M[k] === 'function'))
for (const f of ['addClipMarker', 'updateMarker', 'goToMarker']) check(`store has ${f}`, has(f))

if (fails === 0) {
  // ---- clip markers stay at the same source moment through move and trim
  fresh()
  const id = s().addClipMarker('c', 3)  // clip c: start 2, inPoint 10 → source 11
  check('a clip marker is stored at the source second under the playhead', near(clipOf('c').markers?.[0]?.source, 11) && typeof id === 'string')
  check('…and drawn where it was placed', near(at(), 3))

  s().moveClip('c', 'V1', 4.5)
  check('clip markers stay at the same source moment through move and trim: move', near(at(), 5.5), String(at()))
  s().trimClip('c', 'in', 5)            // head trimmed by 0.5 s: start 5, inPoint 10.5
  check('clip markers stay at the same source moment through move and trim: trim in', near(at(), 5.5) && near(clipOf('c').start, 5), String(at()))
  s().trimClip('c', 'out', 6)
  check('clip markers stay at the same source moment through move and trim: trim out', near(at(), 5.5), String(at()))
  s().trimClip('c', 'in', 5.8)          // trimmed past it: hidden, not moved
  check('a marker trimmed off the clip is hidden', at() === null, String(at()))
  s().trimClip('c', 'in', 5)
  check('…and back where it was when the trim is undone by dragging', near(at(), 5.5), String(at()))
  s().slip('c', 0.3)                    // the source slides under the clip: the marker rides the source
  check('a slip carries the marker with the source', near(at(), 5.2), String(at()))
  s().slip('c', -0.3)

  fresh()
  s().addClipMarker('c', 3)
  s().setClipSpeed('c', 2, 2)           // twice as fast: source 11 is 0.5 s into the clip
  check('a speed change keeps the marker on its source moment', near(at(), 2.5), String(at()))

  fresh()
  s().addClipMarker('c', 4.5)
  s().splitAt(3)
  const halves = s().project.tracks[0].clips.filter((c) => c.assetId === 'a1' && c.start < 8)
  const shown = halves.map((c) => M.clipMarkerTime(c, c.markers?.[0]?.source ?? NaN)).filter((x) => x !== null)
  check('after a split exactly one half shows the marker, at the same place', shown.length === 1 && near(shown[0], 4.5), JSON.stringify(shown))

  // ---- notes, colours, one undo per edit
  fresh()
  const tm = s().addMarker(1)
  const depth = s().past.length
  s().updateMarker({ id: tm }, { label: 'Intro', note: 'cut the cough', color: 3 })
  const m = s().project.markers.find((x) => x.id === tm)
  check('a timeline marker takes a name, a note and a colour in one undo step',
    m.label === 'Intro' && m.note === 'cut the cough' && m.color === 3 && s().past.length === depth + 1, JSON.stringify(m))
  s().updateMarker({ id: tm }, { color: undefined })
  check('the colour can be taken off', !('color' in s().project.markers.find((x) => x.id === tm)))
  const cm = s().addClipMarker('c', 3)
  s().updateMarker({ id: cm, clipId: 'c' }, { note: 'flash frame', color: 5 })
  check('a clip marker takes a note and a colour', clipOf('c').markers[0].note === 'flash frame' && clipOf('c').markers[0].color === 5)
  s().undo()
  check('one undo takes the clip marker\'s edit back', !clipOf('c').markers[0].note)
  s().removeMarker(cm, 'c')
  check('a clip marker is removed by its clip', (clipOf('c').markers ?? []).length === 0)

  // ---- the list and the keys
  fresh()
  s().addMarker(1)
  s().addMarker(7, { kind: 'beat' })    // beats are not in the list and not jumped to
  s().addClipMarker('c', 3)
  s().addClipMarker('d', 9)
  const rows = M.markerRows(s().project)
  check('the list holds the user\'s markers and the clips\' markers, in time order',
    JSON.stringify(rows.map((r) => [r.time, r.clipId ?? null])) === JSON.stringify([[1, null], [3, 'c'], [9, 'd']]), JSON.stringify(rows))
  s().setPlayhead(0)
  const seen = []
  for (let i = 0; i < 4; i++) { s().goToMarker(1); seen.push(s().playhead) }
  check('next marker walks 1 → 3 → 9 and stops', JSON.stringify(seen) === '[1,3,9,9]', JSON.stringify(seen))
  s().goToMarker(-1)
  check('previous marker goes back', near(s().playhead, 3))

  // ---- a file with junk in it heals
  const p = newProject()
  p.markers = [{ id: 'x', time: 1, label: 'a', note: 5, color: 99 }]
  p.tracks = [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1,
    clips: [mk('c', 0, 2, { markers: [{ id: 'y', source: 'no', label: 'b' }, { id: 'z', source: 11, label: '', color: 2, note: 'ok' }] })] }]
  sanitizeProject(p)
  const hm = p.markers[0], hc = p.tracks[0].clips[0].markers
  check('junk notes and colours are dropped on load, clip markers without a source too',
    !('note' in hm) && !('color' in hm) && hc.length === 1 && hc[0].id === 'z' && hc[0].color === 2 && hc[0].note === 'ok' && hc[0].label,
    JSON.stringify([hm, hc]))
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall marker checks passed')
process.exit(fails ? 1 : 0)
