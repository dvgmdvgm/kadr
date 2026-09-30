// Node-side check of timeline snapping (card E7): the magnet can be switched
// off (N), each target (clip edges, playhead, markers, beats) on its own, and
// the radius is the setting's screen pixels at the current zoom.
//
// Cost of getting it wrong: fighting the magnet on every fine move — or a
// switch that shows «off» while clips still jump.
// The store is bundled with esbuild like check-ripple.
// Run: node scripts/check-snap.mjs
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
const S = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
const { newProject, snapPoints, useSettings } = S

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
if (typeof S.snapTo !== 'function') {
  check('snapTo exists', false)
  process.exit(1)
}
const set = (k, v) => useSettings.getState().set(k, v)
const reset = () => ['editing.snap', 'editing.snapEdges', 'editing.snapPlayhead', 'editing.snapMarkers',
  'editing.snapBeats', 'editing.snapRadius'].forEach((k) => set(k, null))

// V1: a clip 2–5; a user marker at 7, a beat at 9; playhead 11. zoom 100 px/s
const p = newProject()
p.tracks[0].clips = [{ id: 'c', kind: 'media', assetId: 'a', start: 2, duration: 3, inPoint: 0, label: 'c', speed: 1 }]
p.markers = [{ id: 'm', time: 7, label: '1' }, { id: 'b', time: 9, label: '', kind: 'beat' }]
const Z = 100
const pts = () => snapPoints(p, '', 11)
const snap = (t) => S.snapTo(t, pts(), Z)
const near = (a, b) => Math.abs(a - b) < 1e-9

reset()
check('every target attracts by default (edge, playhead, marker, beat)',
  near(snap(5.05), 5) && near(snap(11.05), 11) && near(snap(7.05), 7) && near(snap(9.05), 9))
check('the radius is the setting in screen px: 10 px at 100 px/s = 0.1 s',
  near(snap(5.09), 5) && near(snap(5.11), 5.11))
set('editing.snapRadius', 20)
check('a wider radius from the settings reaches further', near(snap(5.15), 5))
set('editing.snapRadius', null)

// › "no snap when disabled; only the enabled targets attract"
set('editing.snap', false)
check('no snap when disabled', [5.05, 11.05, 7.05, 9.05, 2.01].every((t) => near(snap(t), t)))
set('editing.snap', null)

set('editing.snapEdges', false)
check('edges off: clip edges and 0 do not attract, the rest do',
  near(snap(5.05), 5.05) && near(snap(0.05), 0.05) && near(snap(11.05), 11) && near(snap(7.05), 7))
set('editing.snapEdges', null)
set('editing.snapPlayhead', false)
check('playhead off: only the playhead stops attracting', near(snap(11.05), 11.05) && near(snap(5.05), 5))
set('editing.snapPlayhead', null)
set('editing.snapMarkers', false)
check('markers off: the user marker stops attracting, beats still do',
  near(snap(7.05), 7.05) && near(snap(9.05), 9))
set('editing.snapMarkers', null)
set('editing.snapBeats', false)
check('beats off works as before: beats stop, the user marker stays', near(snap(9.05), 9.05) && near(snap(7.05), 7))
reset()

// an explicit beats flag (the old 4th argument, e2e44) still wins over the setting
check('snapPoints(p, ex, t, false) still drops beats', !snapPoints(p, '', 11, false).includes(9))
check('marker ids in exclude still leave that marker out', !snapPoints(p, 'm', 11).includes(7))

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
