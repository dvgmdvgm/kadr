// K6: the mixer's strip and the track header are two views of ONE value. The
// fader IS `Track.gain` (not a copy), read through one taper table that the
// strips, the master and the Inspector's gain range share; mute and solo are
// the header's own fields; every gesture — a drag of any length, a click — is
// one undo step. A keyed pan or clip gain takes the edit as a key under the
// playhead instead of writing `.value` that nobody hears (K1 finding 2).
// Cost of getting it wrong: two controls that disagree about one level.
// Run: node scripts/check-mixer-binding.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export * from './shared/fader'
      export * as M from './src/engine/mixer'
      export { useEditor } from './src/state/store'
      export { evalAnim } from './src/engine/anim'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const F = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { M, useEditor, evalAnim } = F

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e

// ---- the taper: one table, position from the bottom (canvas K, RULES 6)
{
  const rows = [[6, 1], [0, 0.8], [-6, 0.65], [-12, 0.5], [-24, 0.3], [-40, 0.14], [-Infinity, 0]]
  check('the taper puts each table row where the canvas draws it',
    rows.every(([db, p]) => near(F.faderPos(db), p)), rows.map(([db]) => F.faderPos(db)))
  check('the taper is linear in dB between rows', near(F.faderPos(-3), 0.725) && near(F.faderPos(-50), 0.07))
  const back = [-59, -45, -40, -20, -6.5, -0.1, 0, 3, 6].every((db) => near(F.posDb(F.faderPos(db)), db, 1e-9))
  check('position → dB inverts the taper', back)
  check('the bottom is silence and the top is +6 dB (gain 2, the header\'s own maximum)',
    F.posDb(0) === -Infinity && near(F.dbToGain(F.posDb(1)), 1.9952623149688795) && F.dbToGain(-Infinity) === 0)
  check('dB reads as the strip prints it', F.dbText(0) === '0.0' && F.dbText(-6.02) === '−6.0' && F.dbText(3) === '+3.0' && F.dbText(-Infinity) === '−∞')
  check('loudness below −70 LUFS (the filter tail, −1800) prints −∞',
    F.lufsText(-1800) === '−∞' && F.lufsText(-70.5) === '−∞' && F.lufsText(-18.6) === '−18.6')
  check('pan reads C / L n / R n', F.panText(0) === 'C' && F.panText(-0.3) === 'L 30' && F.panText(1) === 'R 100')
}

const fresh = () => {
  const st = useEditor.getState()
  st.newProject?.()
  const p = structuredClone(useEditor.getState().project)
  p.tracks = [
    { id: 'v1', kind: 'video', name: 'V1', clips: [], muted: false, locked: false, gain: 1 },
    { id: 'a1', kind: 'audio', name: 'A1', clips: [{ id: 'c1', kind: 'media', assetId: 'x', start: 2, duration: 4, inPoint: 0, outPoint: 4, speed: 1, gain: { value: 1 }, muted: false, transform: {} }], muted: false, locked: false, gain: 1 },
    { id: 'a2', kind: 'audio', name: 'A2', clips: [], muted: false, locked: false, gain: 1 }
  ]
  useEditor.setState({ project: p, past: [], future: [], playhead: 3 })
}
const track = (id) => useEditor.getState().project.tracks.find((t) => t.id === id)
const past = () => useEditor.getState().past.length

// ---- the fader and the header slider are one value
{
  fresh()
  M.beginMixGesture()
  for (const pos of [0.7, 0.6, 0.5]) M.setTrackGain('a1', F.dbToGain(F.posDb(pos)))
  const g = track('a1').gain
  check('the fader and the header slider are one value: a fader move IS Track.gain',
    near(g, F.dbToGain(-12)), g)
  check('a fader drag of any length is one undo step', past() === 1, past())
  // the header writes the same field; the strip reads it back through the taper
  M.beginMixGesture()
  M.setTrackGain('a1', 0.5)
  check('the header\'s write moves the fader: position = taper(dB(gain))',
    near(F.faderPos(F.gainToDb(track('a1').gain)), F.faderPos(20 * Math.log10(0.5))))
  M.setTrackGain('a1', 7)
  check('the gain is held to the header\'s range 0…2', track('a1').gain === 2)
  useEditor.getState().undo()
  check('undo restores the level before the gesture', near(track('a1').gain, F.dbToGain(-12)), track('a1').gain)
}

// ---- master fader
{
  fresh()
  M.beginMixGesture()
  M.setMaster(F.dbToGain(-6))
  M.setMaster(F.dbToGain(-7))
  check('the master fader is project.masterGain, one undo step',
    near(useEditor.getState().project.masterGain, F.dbToGain(-7)) && past() === 1)
  useEditor.getState().undo()
  check('undo takes the master back', useEditor.getState().project.masterGain === undefined)
}

// ---- mute / solo: the header's fields, one undo step each
{
  fresh()
  M.toggleTrack('a1', 'muted')
  check('mute from the strip writes Track.muted and is one undo step', track('a1').muted === true && past() === 1)
  M.toggleTrack('a2', 'solo')
  check('solo from the strip writes Track.solo and is one undo step', track('a2').solo === true && past() === 2)
  useEditor.getState().undo(); useEditor.getState().undo()
  check('undo takes both back', track('a1').muted === false && !track('a2').solo)
}

// ---- pan: static writes the value, keyed writes a key at the playhead
{
  fresh()
  M.beginMixGesture()
  M.setTrackPan('a1', -0.3, 3)
  check('a static track pan takes the value', track('a1').pan?.value === -0.3 && !track('a1').pan.keyframes)
  useEditor.getState().updateTrack('a1', { pan: { value: 0, keyframes: [{ time: 0, value: -1, easing: 'linear' }, { time: 10, value: 1, easing: 'linear' }] } })
  M.setTrackPan('a1', 0.5, 4)
  const a = track('a1').pan
  check('a keyed track pan takes a key at the playhead (project time)', a.keyframes.length === 3 && near(evalAnim(a, 4), 0.5), a.keyframes)
  check('M.trackPanAt reads the keyed value under the playhead', near(M.trackPanAt(track('a1'), 4), 0.5) && near(M.trackPanAt(track('a1'), 7), 0.5 + 0.5 * 3 / 6))
}

// ---- the Inspector's clip gain: keyed → a key at the clip-local playhead
{
  fresh()
  const clip = () => track('a1').clips[0]
  M.setClipAnimAt('c1', 'gain', 0.5, 3)
  check('a static clip gain takes the value', clip().gain.value === 0.5 && !clip().gain.keyframes)
  useEditor.getState().updateClip('c1', { gain: { value: 1, keyframes: [{ time: 0, value: 1, easing: 'linear' }, { time: 4, value: 1, easing: 'linear' }] } })
  M.setClipAnimAt('c1', 'gain', 0.25, 3)
  const g = clip().gain
  check('a keyed clip gain takes a key at the clip-local playhead (3 − 2 = 1 s), never .value',
    g.value === 1 && g.keyframes.length === 3 && near(evalAnim(g, 1), 0.25), g.keyframes)
  check('outside the clip a keyed edit writes nothing', M.setClipAnimAt('c1', 'gain', 0.1, 9) === false && clip().gain.keyframes.length === 3)
  M.setClipAnimAt('c1', 'pan', -1, 3)
  check('clip pan with no Anim yet takes a value', clip().pan?.value === -1)
  M.toggleKeyAt('c1', 'pan', 3)
  check('the diamond adds a key at the playhead', clip().pan.keyframes?.length === 1 && clip().pan.keyframes[0].time === 1)
  M.toggleKeyAt('c1', 'pan', 3)
  check('the diamond on a key removes it, and the last key leaves its value', !clip().pan.keyframes?.length && clip().pan.value === -1)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
