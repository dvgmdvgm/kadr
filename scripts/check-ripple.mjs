// Node-side check of the ripple family (card E2): ripple delete, extract a
// range, close gaps — all through one primitive, `shiftAfter` («shift every
// clip whose start is at or right of t on these tracks»), which the voice-over
// splice now uses too.
//
// Cost of getting it wrong: A/V out of sync after a cut (a twin left behind),
// a locked track dragged along, or a regenerated voice-over that lands its
// neighbours somewhere else than it used to.
// The store is bundled with esbuild like check-frame-quant.
// Run: node scripts/check-ripple.mjs
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
const starts = () => Object.fromEntries(s().project.tracks.flatMap((t) => t.clips).map((c) => [c.id, +c.start.toFixed(9)]))
const has = (name) => typeof s()[name] === 'function'

const mk = (id, start, duration, extra = {}) =>
  ({ id, kind: 'media', assetId: 'a1', start, duration, inPoint: 0, label: id, speed: 1, ...extra })
const tr = (id, kind, clips, locked = false) =>
  ({ id, kind, name: id, muted: false, locked, gain: 1, clips })

/** V1 and A1 carry three A/V pairs (1–3), V2 a title over clip 3, A2 a locked
    music bed that starts after the cut. 30 fps, every edge on a frame. */
function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [{ id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080 }]
  p.tracks = [
    tr('V2', 'video', [mk('t3', 7, 2, { kind: 'text' })]),
    tr('V1', 'video', [mk('v1', 0, 3, { linkId: 'L1' }), mk('v2', 3, 2, { linkId: 'L2' }), mk('v3', 6, 4, { linkId: 'L3' })]),
    tr('A1', 'audio', [mk('a1c', 0, 3, { linkId: 'L1' }), mk('a2c', 3, 2, { linkId: 'L2' }), mk('a3c', 6, 4, { linkId: 'L3' })]),
    tr('A2', 'audio', [mk('m', 8, 5)], true)
  ]
  p.markers = [{ id: 'mk1', time: 1, label: '1' }, { id: 'mk2', time: 4, label: '2' }, { id: 'mk3', time: 8, label: '3' }]
  s().setProject(p)
  s().select([])
  s().setRange(null)
}

// ---- ripple delete -----------------------------------------------------------
fresh()
if (!has('rippleDelete')) check('rippleDelete exists', false)
else {
  const before = JSON.stringify(s().project)
  s().select(['v2']) // the twin comes with it
  s().rippleDelete()
  const st = starts()
  check('ripple delete closes the gap on the clip\'s tracks and its linked twin\'s',
    !clipOf('v2') && !clipOf('a2c') && near(st.v3, 4) && near(st.a3c, 4) && near(st.v1, 0) && near(st.a1c, 0),
    JSON.stringify(st))
  check('ripple delete leaves other tracks alone (V2 title, markers)',
    near(st.t3, 7) && s().project.markers.map((m) => m.time).join() === '1,4,8', JSON.stringify(st))
  check('locked tracks never move (ripple delete)', near(st.m, 8))
  s().undo()
  check('one Ctrl+Z restores a ripple delete', JSON.stringify(s().project) === before)

  // only the span the deleted clip leaves EMPTY closes: a clip that still
  // covers part of it (an overlap, i.e. a crossfade) keeps its place
  const p = newProject(); p.fps = 30; p.assets = []
  p.tracks = [tr('V1', 'video', [mk('x', 0, 4), mk('y', 3, 3), mk('z', 8, 2)])]
  s().setProject(p); s().select(['y']); s().rippleDelete()
  check('ripple delete closes only what the clip left empty, never an older gap',
    near(clipOf('z').start, 6) && near(clipOf('x').start, 0), JSON.stringify(starts()))
}

// ---- extract a range -----------------------------------------------------------
fresh()
if (!has('extractRange')) check('extractRange exists', false)
else {
  const before = JSON.stringify(s().project)
  s().setRange({ start: 2, end: 4 })
  s().extractRange()
  const clips = s().project.tracks.map((t) => [t.id, t.clips.map((c) => [+c.start.toFixed(9), +(c.start + c.duration).toFixed(9)])])
  const want = [
    ['V2', [[5, 7]]],
    ['V1', [[0, 2], [2, 3], [4, 8]]],
    ['A1', [[0, 2], [2, 3], [4, 8]]],
    ['A2', [[8, 13]]]
  ]
  check('a range extract across V and A tracks closes the gap everywhere',
    JSON.stringify(clips) === JSON.stringify(want), JSON.stringify(clips))
  check('locked tracks never move (extract)', near(clipOf('m').start, 8))
  check('markers right of an extract ripple with it; inside it they land on its start',
    s().project.markers.map((m) => m.time).join() === '1,2,6', s().project.markers.map((m) => m.time).join())
  s().undo()
  check('one Ctrl+Z restores an extract', JSON.stringify(s().project) === before)
}

// ---- close gaps -----------------------------------------------------------------
{
  const p = newProject(); p.fps = 30; p.assets = []
  p.tracks = [
    tr('V1', 'video', [mk('a', 1, 2), mk('b', 4, 1), mk('c', 7, 1)]),
    tr('A1', 'audio', [mk('d', 0, 1), mk('e', 3, 1)]),
    tr('A2', 'audio', [mk('f', 0, 1), mk('g', 5, 1)], true)
  ]
  s().setProject(p)
  if (!has('closeGaps')) check('closeGaps exists', false)
  else {
    s().closeGaps(['V1'])
    const st = starts()
    check('closeGaps closes every gap on the named track only (the lead-in stays)',
      near(st.a, 1) && near(st.b, 3) && near(st.c, 4) && near(st.e, 3), JSON.stringify(st))
    s().undo()
    s().closeGaps('all')
    const st2 = starts()
    check('closeGaps(\'all\') closes every unlocked track, never a locked one',
      near(st2.c, 4) && near(st2.e, 1) && near(st2.g, 5), JSON.stringify(st2))
    const depth = s().past.length
    s().closeGaps('all')
    check('closeGaps with nothing to close adds no undo step', s().past.length === depth)
  }
}

// ---- the voice-over splice shifts exactly as before -----------------------------
// Expected numbers are the pre-E2 formula: a clip moves by the sum of every
// splice event (end of a voice clip, its length change) at or left of its
// start; a clip that straddles an event does not move at all; the voice clips
// themselves move by the events left of their own start.
function voiceFixture() {
  const p = newProject(); p.fps = 30
  p.assets = [{ id: 'vo', kind: 'audio', name: 'vo', path: '/x/vo.flac', duration: 20, hasAudio: true }]
  const vo = (id, start, duration, inPoint) => mk(id, start, duration, { assetId: 'vo', inPoint })
  p.tracks = [
    tr('V1', 'video', [mk('p0', 0, 3), mk('span', 5.5, 1.5), mk('p8', 8, 1), mk('p11', 11, 1)]),
    tr('V2', 'video', [mk('lockedClip', 8, 1)], true),
    tr('A1', 'audio', [vo('vo1', 2, 4, 0), vo('vo2', 7, 3, 5), mk('after', 12, 1)])
  ]
  s().setProject(p)
}
const splice = (ripple, rippleAllTracks) => s().applyVoiceSplice({
  runId: 'r', oldAssetId: 'vo',
  newAsset: { id: 'vo2asset', kind: 'audio', name: 'vo', path: '/x/vo2.flac', duration: 19.25, hasAudio: true },
  // vo1 (source 0–4) grows by 0.5; vo2 (source 5–8) shrinks by 0.75
  units: [{ cut0: 1, cut1: 2, patchDur: 1.5, ids: [] }, { cut0: 6, cut1: 7, patchDur: 0.25, ids: [] }],
  newDuration: 19.25, ripple, rippleAllTracks
})
{
  voiceFixture(); const r = splice(true, true)
  const st = starts()
  const want = { p0: 0, span: 5.5, p8: 8.5, p11: 10.75, lockedClip: 8, vo1: 2, vo2: 7.5, after: 11.75 }
  check('the voice-over splice still shifts exactly as before (all tracks)',
    Object.entries(want).every(([k, v]) => near(st[k], v)) && near(clipOf('vo1').duration, 4.5) && near(clipOf('vo2').duration, 2.25) &&
    r.warnings.some((w) => w.includes('накрывает')),
    JSON.stringify(st))
  voiceFixture(); splice(true, false)
  const st2 = starts()
  const want2 = { p0: 0, span: 5.5, p8: 8, p11: 11, lockedClip: 8, vo1: 2, vo2: 7.5, after: 11.75 }
  check('the voice-over splice still shifts exactly as before (its own track)',
    Object.entries(want2).every(([k, v]) => near(st2[k], v)), JSON.stringify(st2))
  voiceFixture(); splice(false, true)
  const st3 = starts()
  check('the voice-over splice with ripple off moves nothing',
    near(st3.vo2, 7) && near(st3.p8, 8) && near(st3.after, 12), JSON.stringify(st3))
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
