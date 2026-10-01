// Card L5: three-point editing. The pure resolution of the fourth point
// (shared/threePoint.ts) and the store's Insert / Overwrite that land it
// (threePointEdit). Cost of getting it wrong: an edit of the wrong length —
// or an Overwrite that lays the source OVER what is there, which Kadr plays as
// a crossfade, instead of replacing it.
// The store is bundled with esbuild like check-ripple.
// Run: node scripts/check-three-point.mjs
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
const load = async (entry) => import('data:text/javascript;base64,' + Buffer.from(bundle(entry)).toString('base64'))
const { resolveThreePoint } = await load(['shared', 'threePoint.ts'])
const { useEditor, newProject, newClipDefaults } = await load(['src', 'state', 'store.ts'])

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b) => Math.abs(a - b) < 1e-6
const same = (got, want) => near(got.srcIn, want.srcIn) && near(got.at, want.at) && near(got.len, want.len)
const show = (o) => JSON.stringify(o)

// ---- every three-point combination resolves the fourth point
const D = 12
const cases = [
  ['source in+out, playhead', { srcIn: 4.4, srcOut: 7.4, playhead: 4 }, { srcIn: 4.4, at: 4, len: 3 }],
  ['source in+out, timeline in/out (source wins)', { srcIn: 4.4, srcOut: 7.4, playhead: 9, range: { start: 2, end: 10 } }, { srcIn: 4.4, at: 2, len: 3 }],
  ['source in, timeline in/out', { srcIn: 1, playhead: 9, range: { start: 2, end: 4.5 } }, { srcIn: 1, at: 2, len: 2.5 }],
  ['source out, timeline in/out (backtimed)', { srcOut: 8, playhead: 0, range: { start: 2, end: 4.5 } }, { srcIn: 5.5, at: 2, len: 2.5 }],
  ['no source marks, timeline in/out', { playhead: 0, range: { start: 1, end: 3 } }, { srcIn: 0, at: 1, len: 2 }],
  ['source in only, playhead → to the end', { srcIn: 9, playhead: 5 }, { srcIn: 9, at: 5, len: 3 }],
  ['source out only, playhead → from the start', { srcOut: 2.5, playhead: 5 }, { srcIn: 0, at: 5, len: 2.5 }],
  ['no marks at all → the whole file', { playhead: 3 }, { srcIn: 0, at: 3, len: 12 }],
  ['timeline range longer than what the source has left', { srcIn: 10, playhead: 0, range: { start: 1, end: 8 } }, { srcIn: 10, at: 1, len: 2 }],
  ['backtimed past the source start', { srcOut: 1, playhead: 0, range: { start: 0, end: 5 } }, { srcIn: 0, at: 0, len: 1 }],
  ['marks set backwards', { srcIn: 7.4, srcOut: 4.4, playhead: 0 }, { srcIn: 4.4, at: 0, len: 3 }]
]
for (const [name, inp, want] of cases) {
  const got = resolveThreePoint({ srcDur: D, ...inp })
  check(`resolve: ${name}`, same(got, want), `got ${show(got)}, want ${show(want)}`)
}

// ---- the store lands exactly that span
const s = () => useEditor.getState()
const mk = (id, start, duration, extra = {}) =>
  ({ ...newClipDefaults(), id, kind: 'media', assetId: 'scene', start, duration, inPoint: 0, label: id, ...extra })
const tr = (id, kind, clips, locked = false) => ({ id, kind, name: id, muted: false, locked, gain: 1, clips })
/** V1/A1: A 0–4 and B 4–10 (linked pairs), a cut at 4; 25 fps; source interview 12 s */
function fresh({ lockA = false } = {}) {
  const p = newProject()
  p.fps = 25
  p.assets = [
    { id: 'scene', kind: 'video', name: 'scene', path: '/x/scene.mp4', duration: 30, hasAudio: true, width: 1280, height: 720 },
    { id: 'inter', kind: 'video', name: 'interview', path: '/x/interview.mp4', duration: 12, hasAudio: true, width: 1280, height: 720 },
    { id: 'voice', kind: 'audio', name: 'voice', path: '/x/voice.wav', duration: 6, hasAudio: true, width: 0, height: 0 }
  ]
  p.tracks = [
    tr('V1', 'video', [mk('A', 0, 4, { linkId: 'LA', muted: true }), mk('B', 4, 6, { linkId: 'LB', muted: true, inPoint: 4 })]),
    tr('A1', 'audio', [mk('a', 0, 4, { linkId: 'LA' }), mk('b', 4, 6, { linkId: 'LB', inPoint: 4 })], lockA),
    tr('A2', 'audio', [])
  ]
  useEditor.setState({ project: p, past: [], future: [], selection: [], playhead: 4, range: null })
}
const T = () => s().project.tracks
const clips = (tid) => T().find((t) => t.id === tid).clips.slice().sort((a, b) => a.start - b.start)
const byId = (id) => T().flatMap((t) => t.clips).find((c) => c.id === id)
const noOverlap = () => T().every((t) => {
  const cs = t.clips.slice().sort((a, b) => a.start - b.start)
  return cs.every((c, i) => i === 0 || cs[i - 1].start + cs[i - 1].duration <= c.start + 1e-6)
})
const src = { assetId: 'inter', in: 4.4, out: 7.4 }
const both = { video: 'V1', audio: 'A1' }

if (typeof s().threePointEdit !== 'function') {
  check('store: threePointEdit exists', false, 'no store action')
} else {
  // Insert: 3 s at the cut, the rest ripples
  fresh()
  let ids = s().threePointEdit('insert', src, both)
  const nv = byId(ids.find((id) => T()[0].clips.some((c) => c.id === id)))
  check('insert: 3 s at the cut on V1', !!nv && near(nv.start, 4) && near(nv.duration, 3) && near(nv.inPoint, 4.4), show(nv && { start: nv.start, d: nv.duration, in: nv.inPoint }))
  check('insert: B and its sound ripple by exactly 3 s', near(byId('B').start, 7) && near(byId('b').start, 7) && near(byId('B').duration, 6))
  check('insert: picture and sound land as a linked pair', ids.length === 2 && new Set(ids.map((id) => byId(id).linkId)).size === 1 && !!byId(ids[0]).linkId)
  check('insert: one undo step', s().past.length === 1)
  check('insert: nothing overlaps', noOverlap())
  check('insert: the playhead moves to the edit\'s end', near(s().playhead, 7))
  s().undo()
  check('insert: undo restores the cut', clips('V1').length === 2 && near(byId('B').start, 4))

  // Overwrite: exactly 3 s replaced, nothing moves, nothing overlaps
  fresh()
  ids = s().threePointEdit('overwrite', src, both)
  const v1 = clips('V1'), a1 = clips('A1')
  check('overwrite: V1 reads A 0–4, new 4–7, B 7–10', v1.length === 3 && near(v1[1].start, 4) && near(v1[1].duration, 3) && near(v1[2].start, 7) && near(v1[2].duration, 3),
    show(v1.map((c) => [c.id, c.start, c.duration])))
  check('overwrite: B is TRIMMED (source moves on by 3 s), not overlapped', near(byId('B').inPoint, 7))
  check('overwrite: the same on the sound track', a1.length === 3 && near(a1[2].start, 7) && near(a1[2].inPoint, 7))
  check('overwrite: nothing overlaps (no crossfade)', noOverlap())
  check('overwrite: the timeline keeps its length', Math.max(...T().flatMap((t) => t.clips.map((c) => c.start + c.duration))) === 10)
  check('overwrite: one undo step', s().past.length === 1)

  // Overwrite inside a clip splits it around the new part
  fresh()
  useEditor.setState({ playhead: 5 })
  s().threePointEdit('overwrite', { assetId: 'inter', in: 0, out: 2 }, both)
  const v = clips('V1')
  check('overwrite inside B: B 4–5, new 5–7, B 7–10', v.length === 4 && near(v[1].duration, 1) && near(v[2].start, 5) && near(v[3].start, 7) && near(v[3].inPoint, 7),
    show(v.map((c) => [c.id, c.start, c.duration, c.inPoint])))

  // Overwrite with a timeline in/out and a source in: the range's length
  fresh()
  useEditor.setState({ range: { start: 1, end: 3.6 } })
  ids = s().threePointEdit('overwrite', { assetId: 'inter', in: 6 }, both)
  const ov = byId(ids[0])
  check('overwrite with timeline in/out: 2.6 s from source 6', near(ov.start, 1) && near(ov.duration, 2.6) && near(ov.inPoint, 6), show(ov && [ov.start, ov.duration, ov.inPoint]))

  // Patching: picture only / sound only
  fresh()
  ids = s().threePointEdit('insert', src, { video: 'V1', audio: null })
  check('picture only: one video clip, not muted, unlinked', ids.length === 1 && byId(ids[0]).muted !== true && !byId(ids[0]).linkId && clips('A1').length === 2)
  check('picture only: the sound of B still ripples with it', near(byId('b').start, 7))
  fresh()
  ids = s().threePointEdit('overwrite', src, { video: null, audio: 'A2' })
  check('sound only onto A2: one audio clip, V1 untouched', ids.length === 1 && clips('A2').length === 1 && clips('V1').length === 2 && near(byId('B').start, 4))
  fresh()
  ids = s().threePointEdit('insert', { assetId: 'voice' }, { video: 'V1', audio: 'A2' })
  check('a sound file ignores the picture target', ids.length === 1 && near(byId(ids[0]).duration, 6) && clips('A2').length === 1)

  // A new track as the target
  fresh()
  ids = s().threePointEdit('overwrite', src, { video: 'new', audio: 'new' })
  check('new tracks: one video and one audio track appear', T().length === 5 && T()[0].clips.length === 1 && T()[T().length - 1].clips.length === 1 && s().past.length === 1)

  // Refusals: a locked target, nothing taken
  fresh({ lockA: true })
  ids = s().threePointEdit('overwrite', src, both)
  check('locked target: nothing happens, no undo step', ids.length === 0 && s().past.length === 0 && clips('V1').length === 2)
  fresh()
  ids = s().threePointEdit('insert', src, { video: null, audio: null })
  check('nothing taken: nothing happens', ids.length === 0 && s().past.length === 0)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
