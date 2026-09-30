// Node-side check of card F6's small frictions that carry logic.
//
// Cost of getting it wrong: after Ctrl+Z the clip the user was moving loses its
// selection and its gizmo, so every undo needs a click to go on; the sound
// library shows `impactSoft_medium_000` instead of a name; a video clip whose
// sound lives on its A-track twin says «Без звука», ticked, and looks broken.
// Run: node scripts/check-frictions.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  mod = await load(`
    export { useEditor, newProject } from './src/state/store'
    export { soundTitle } from './shared/sfxTitle'
    export { audioTwin } from './src/engine/timelineSelect'
  `)
} catch (e) {
  check('the modules load', false, String(e.message ?? e).split('\n')[0])
}
const { useEditor, newProject, soundTitle, audioTwin } = mod

const asset = { id: 'a', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 10, fps: 25, hasAudio: true, width: 1920, height: 1080 }
const mk = (id, start, duration, extra = {}) => ({
  id, kind: 'media', assetId: 'a', start, duration, inPoint: 0, speed: 1, label: id,
  gain: { value: 1 }, muted: false, effects: [],
  transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } },
  ...extra
})
const trk = (id, kind, clips) => ({ id, kind, name: id.toUpperCase(), muted: false, locked: false, gain: 1, clips })

// --- undo keeps the selection ---------------------------------------------------
if (useEditor) {
  const st = () => useEditor.getState()
  useEditor.setState({
    project: { ...newProject(), fps: 30, assets: [asset], tracks: [trk('v1', 'video', [mk('c1', 0, 4), mk('c2', 4, 4)])] },
    past: [], future: [], selection: ['c1']
  })
  st().pushHistory('hEdit')
  st().updateClip('c1', { start: 1 })
  st().undo()
  check('undo keeps a selected clip that still exists after it (the gizmo stays up)',
    JSON.stringify(st().selection) === '["c1"]', JSON.stringify(st().selection))
  st().redo()
  check('redo keeps it too', JSON.stringify(st().selection) === '["c1"]', JSON.stringify(st().selection))
  // a clip the undo takes away leaves the selection
  st().pushHistory('hEdit')
  useEditor.setState((s) => ({ project: { ...s.project, tracks: [trk('v1', 'video', [...s.project.tracks[0].clips, mk('c3', 8, 2)])] } }))
  st().select(['c3', 'c1'])
  st().undo()
  check('a clip the undo removes drops out of the selection', JSON.stringify(st().selection) === '["c1"]', JSON.stringify(st().selection))
}

// --- sound names ------------------------------------------------------------------
if (soundTitle) {
  const cases = [
    ['impact/impactSoft_medium_000.ogg', 'Impact soft medium 0'],
    ['impact/footstep_carpet_003.ogg', 'Footstep carpet 3'],
    ['casino/card-fan-1.ogg', 'Card fan 1'],
    ['keyboard/keypress-001.wav', 'Keypress 1'],
    ['ui/click1.ogg', 'Click 1'],
    ['interface/bong_001.ogg', 'Bong 1'],
    ['user:mine/My Boom.mp3', 'My Boom']
  ]
  for (const [id, want] of cases) check(`a sound reads «${want}», not «${id}»`, soundTitle(id) === want, soundTitle(id))
}

// --- the video half of an AV pair ------------------------------------------------
if (audioTwin) {
  const v = mk('v', 0, 4, { linkId: 'L', muted: true })
  const a = mk('au', 0, 4, { linkId: 'L' })
  const p = { tracks: [trk('v1', 'video', [v]), trk('a1', 'audio', [a]), trk('a2', 'audio', [mk('x', 0, 4, { linkId: 'M' })])] }
  const tw = audioTwin(p, v)
  check('a muted video clip finds its sound on the linked audio clip, with the track', tw?.clip.id === 'au' && tw?.track.name === 'A1', JSON.stringify(tw && { c: tw.clip.id, t: tw.track.name }))
  check('an unlinked clip has no twin', audioTwin(p, mk('solo', 0, 1)) === null)
  check('an audio clip is not its own twin', audioTwin(p, a) === null)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
