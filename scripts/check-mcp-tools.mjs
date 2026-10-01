// Node-side check of the agent's semantic edit tools (card I1): the tool table
// of electron/mcp-edit-tools.cjs run against the REAL store — its page code is
// evaluated here instead of in the editor, with window.kadrEditor built from the
// bundled src/engine/agentEdits.ts. No app, no claude, no tokens.
//
// Cost of getting it wrong: agent edits that cannot be undone in one step, or a
// malformed call that reaches the project before anyone checked it.
// Run: node scripts/check-mcp-tools.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * as agentEdit from './src/engine/agentEdits'; export { useEditor, newProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
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
const { agentEdit, useEditor, newProject } = await import(
  'data:text/javascript;base64,' + Buffer.from(out).toString('base64')
)
globalThis.window = { kadrEditor: { agentEdit, useEditor } }
const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron', 'mcp-edit-tools.cjs'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
let pageCalls = 0
const editorEval = async (code) => { pageCalls++; return new AsyncFunction(code)() }
const tool = (name) => TOOLS.find((t) => t.name === name)
const call = (name, args) => runTool(tool(name), args, editorEval)
const onFrame = (t, fps = 30) => Math.abs(t * fps - Math.round(t * fps)) < 1e-6

const mk = (id, start, duration, extra = {}) => ({
  id, kind: 'media', assetId: 'a1', start, duration, inPoint: 0, label: id, speed: 1, muted: false,
  gain: { value: 1 }, fadeIn: 0, fadeOut: 0, effects: [],
  transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } },
  ...extra
})
const tr = (id, kind, clips, locked = false) => ({ id, kind, name: id, muted: false, locked, gain: 1, clips })
function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [{ id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080 }]
  p.tracks = [
    tr('V2', 'video', []),
    tr('V1', 'video', [mk('v1', 0, 3, { linkId: 'L1' }), mk('v2', 3, 2, { linkId: 'L2' }), mk('v3', 6, 4, { linkId: 'L3' })]),
    tr('A1', 'audio', [mk('a1c', 0, 3, { linkId: 'L1' }), mk('a2c', 3, 2, { linkId: 'L2' }), mk('a3c', 6, 4, { linkId: 'L3' })]),
    tr('A2', 'audio', [mk('m', 8, 5)], true)
  ]
  p.markers = [{ id: 'mk1', time: 4, label: '1' }]
  s().setProject(p, null)
}
const snap = () => JSON.stringify(s().project)
const clip = (id) => s().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)

// ── the bridge itself parses: a syntax error there leaves the agent with NO tools
// (G2 shipped one — an unescaped apostrophe in a description — and nothing noticed)
{
  const { readFileSync } = await import('fs')
  let err
  try { new Function('require', 'module', 'exports', readFileSync(join(root, 'electron', 'mcp-bridge.cjs'), 'utf8').replace(/^#!.*/, '')) } catch (e) { err = e }
  check('electron/mcp-bridge.cjs parses', !err, err?.message)
}

// ── every edit tool: one undo step, and one kadr_undo(1) restores the project exactly
const valid = {
  kadr_cut: { t: 1.013 },
  kadr_move: { clipId: 'v3', start: 7.51 },
  kadr_trim: { clipId: 'v2', edge: 'out', t: 4.49, ripple: true },
  kadr_ripple_delete: { clipIds: ['v2'] },
  kadr_keyframe: { clipId: 'v1', param: 'opacity', t: 1.5, value: 0.25, easing: 'easeOut' },
  kadr_text_add: { at: 2.2, text: 'Hello', style: { fontSize: 48, color: '#ff0000' } },
  kadr_volume: { clipId: 'a3c', keys: [{ t: 6, value: 1 }, { t: 8, value: 0.3, easing: 'easeIn' }] },
  kadr_marker: { t: 5.5, label: 'drop' },
  kadr_grade: { clipId: 'v1', grade: { exposure: 1, saturation: -0.5 }, blend: 'screen', key: { mode: 'chroma', spill: 0.4 } }
}
const edits = TOOLS.filter((t) => t.name !== 'kadr_undo' && !t.helper) // helpers (kadr_silences) have their own check
check('every edit tool has a sample here', edits.every((t) => valid[t.name]),
  edits.filter((t) => !valid[t.name]).map((t) => t.name).join(', '))
check('every tool\'s page code is one call into kadrEditor.agentEdit',
  TOOLS.every((t) => typeof agentEdit[t.fn] === 'function'))
for (const t of edits) {
  fresh()
  const before = snap()
  const past = s().past.length
  let r, err
  try { r = await call(t.name, valid[t.name]) } catch (e) { err = e }
  check(`${t.name}: edits`, !err && snap() !== before, err?.message)
  check(`${t.name}: exactly one undo step`, s().past.length === past + 1, `${s().past.length - past}`)
  const u = await call('kadr_undo', { steps: 1 })
  check(`${t.name}: kadr_undo(1) restores the project exactly`, snap() === before && u.undone === 1)
  if (t.name === 'kadr_cut') check('kadr_cut lands on a frame, the twin splits too',
    onFrame(r.t) && r.rightHalves.length === 2, JSON.stringify(r))
}

// ── what the edits did, and that they landed on frames (E1)
fresh()
await call('kadr_move', { clipId: 'v3', start: 7.51 })
check('kadr_move: on a frame, the twin moves along', onFrame(clip('v3').start) && clip('a3c').start === clip('v3').start,
  `${clip('v3').start} / ${clip('a3c').start}`)
fresh()
await call('kadr_trim', { clipId: 'v2', edge: 'out', t: 4.49, ripple: true })
check('kadr_trim ripple: the end on a frame, what follows closes up', onFrame(clip('v2').duration) &&
  Math.abs(clip('v3').start - (6 - (5 - (3 + clip('v2').duration)))) < 1e-9 && clip('m').start === 8)
fresh()
await call('kadr_ripple_delete', { start: 1, end: 2 })
check('kadr_ripple_delete range: every unlocked track closes, markers follow, locked stays',
  clip('v2').start === 2 && clip('a2c').start === 2 && clip('m').start === 8 && s().project.markers[0].time === 3)
fresh()
await call('kadr_keyframe', { clipId: 'v3', param: 'scale', t: 7, value: 1.5 })
check('kadr_keyframe: project time → clip-local key', clip('v3').transform.scale.keyframes?.[0]?.time === 1)
fresh()
const txt = await call('kadr_text_add', { at: 2.2, text: 'Hello', style: { fontSize: 48 } })
check('kadr_text_add: text, merged style, on a frame', clip(txt.clipId).text === 'Hello' &&
  clip(txt.clipId).textStyle.fontSize === 48 && clip(txt.clipId).textStyle.align === 'center' && onFrame(txt.start))
fresh()
await call('kadr_volume', { clipId: 'a3c', value: 0.5 })
check('kadr_volume: the twin too', clip('a3c').gain.value === 0.5 && clip('v3').gain.value === 0.5)
fresh()
{
  const g = await call('kadr_grade', { clipId: 'v1', grade: { exposure: 1.5 }, lut: { path: '/l/look.cube', intensity: 0.6 }, key: { mode: 'luma' } })
  check('kadr_grade: a grade with all seven controls, the LUT, a luma key with the sanitizer\'s defaults',
    clip('v1').grade.exposure.value === 1.5 && clip('v1').grade.tint.value === 0 && clip('v1').lut.intensity.value === 0.6 &&
    clip('v1').key.mode === 'luma' && clip('v1').key.colour === '#000000' && g.blend === 'normal')
  await call('kadr_grade', { clipId: 'v1', lut: null, key: { mode: 'off' }, blend: 'normal' })
  check('kadr_grade: null / off / normal remove', clip('v1').lut === undefined && clip('v1').key === undefined && clip('v1').grade.exposure.value === 1.5)
  await call('kadr_grade', { clipId: 'v1', wheels: { gain: { x: 0.3, level: 0.1 } }, curves: { y: [[0.7, 0.8], [0.25, 0.2]] } })
  check('kadr_grade: J7 wheels merge into neutral ones, curves sorted',
    clip('v1').wheels.gain.x === 0.3 && clip('v1').wheels.gain.y === 0 && clip('v1').wheels.lift.level === 0 &&
    JSON.stringify(clip('v1').curves) === '{"y":[[0.25,0.2],[0.7,0.8]]}')
  await call('kadr_grade', { clipId: 'v1', wheels: { gain: { x: 0, level: 0 } }, curves: { y: [] } })
  check('kadr_grade: a neutral wheel set and an empty channel leave nothing', clip('v1').wheels === undefined && clip('v1').curves === undefined)
  let err
  try { await call('kadr_grade', { clipId: 'a1c', grade: { exposure: 1 } }) } catch (e) { err = e }
  check('kadr_grade refuses a clip with no picture', /no picture/.test(err?.message), err?.message)
}
fresh()
await call('kadr_undo', { steps: 1 }).then((r) => check('kadr_undo with nothing to undo says so', r.undone === 0))
fresh()
const before3 = snap()
await call('kadr_cut', { t: 1 }); await call('kadr_marker', { t: 2 }); await call('kadr_volume', { clipId: 'v1', value: 0 })
const u3 = await call('kadr_undo', { steps: 3 })
check('kadr_undo(3) walks back three tool calls', snap() === before3 && u3.undone === 3, u3.labels.join(','))

// ── a no-op leaves no undo step behind and says so
for (const [name, args] of [['kadr_cut', { t: 20 }], ['kadr_move', { clipId: 'v1', start: 0 }]]) {
  fresh()
  const past = s().past.length
  let err
  try { await call(name, args) } catch (e) { err = e }
  check(`${name} that changes nothing: an error, no undo step`, /nothing changed/.test(err?.message) && s().past.length === past, err?.message)
}
fresh()
{
  let err
  try { await call('kadr_trim', { clipId: 'm', edge: 'out', t: 10 }) } catch (e) { err = e }
  check('a clip on a locked track is refused by name', /locked/.test(err?.message) && clip('m').duration === 5)
}

// ── invalid input never reaches the page
const invalid = {
  kadr_cut: [{}, { t: -1 }, { t: 'x' }, { t: 1, trackIds: [] }, { t: 1, extra: 1 }],
  kadr_move: [{ clipId: 'v1' }, { clipId: '', start: 1 }, { clipId: 'v1', start: NaN }],
  kadr_trim: [{ clipId: 'v1', edge: 'mid', t: 1 }, { clipId: 'v1', edge: 'in' }],
  kadr_ripple_delete: [{}, { clipIds: ['v1'], start: 0, end: 1 }, { start: 2, end: 1 }, { start: 1 }, { clipIds: [] }],
  kadr_keyframe: [{ clipId: 'v1', param: 'blur', t: 1, value: 1 }, { clipId: 'v1', param: 'opacity', t: 1, value: 2 },
    { clipId: 'v1', param: 'gain', t: 1, value: 3 }, { clipId: 'v1', param: 'x', t: 1, value: 1, easing: 'bounce' }],
  kadr_text_add: [{ at: 1 }, { at: 1, text: '' }, { at: 1, text: 'a', style: { font: 'x' } }, { at: 1, text: 'a', style: { color: 'red' } }],
  kadr_volume: [{ clipId: 'v1' }, { clipId: 'v1', value: 1, keys: [{ t: 0, value: 1 }] }, { clipId: 'v1', value: 3 }, { clipId: 'v1', keys: [] }],
  kadr_marker: [{}, { t: 1, kind: 'section' }, { t: 1, kind: 'pause', end: 0.5 }, { t: 1, end: 2 }, { t: 1, kind: 'scene', end: 2 }, { t: 1, kind: 'shot' }],
  kadr_undo: [{}, { steps: 0 }, { steps: 1.5 }, { steps: 51 }],
  kadr_silences: [{ start: 1 }, { apply: 'some' }, { thresholdDb: 0 }],
  kadr_propose: [{}, { kind: 'retake', ranges: [] }, { kind: 'silence', ranges: [{ start: 0, end: 1, reason: 'x' }] }, { apply: 'all' }],
  kadr_scenes: [{ start: 1 }, { threshold: 0 }, { clipId: 'x', start: 0, end: 1 }],
  kadr_duck: [{}, { musicClipIds: [] }, { musicClipIds: ['m'], depthDb: 0 }, { musicClipIds: ['m'], speechTrackIds: ['a'], speechClipIds: ['v'] }],
  kadr_grade: [{ clipId: 'v1' }, { clipId: 'v1', grade: {} }, { clipId: 'v1', grade: { exposure: 9 } }, { clipId: 'v1', grade: { gamma: 1 } },
    { clipId: 'v1', blend: 'hue' }, { clipId: 'v1', lut: { path: 'x.png' } }, { clipId: 'v1', key: { mode: 'chroma', colour: 'green' } },
    { clipId: 'v1', wheels: { offset: { x: 1 } } }, { clipId: 'v1', wheels: { lift: { level: 2 } } }, { clipId: 'v1', curves: { y: [[0.5, 1.5]] } }]
}
check('every tool has invalid samples here', TOOLS.every((t) => invalid[t.name]?.length))
fresh()
const untouched = snap()
for (const t of TOOLS) {
  for (const args of invalid[t.name] ?? []) {
    pageCalls = 0
    let err
    try { await call(t.name, args) } catch (e) { err = e }
    check(`${t.name} rejects ${JSON.stringify(args)} before the page`, !!err && pageCalls === 0, err?.message)
  }
}
check('…and the project was never touched', snap() === untouched)

// ── what the tool list costs the agent's context (the card's risk: keep it short)
const chars = TOOLS.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(Object.keys(t.input)).length, 0)
console.log(`info  edit tools: ${TOOLS.length}, ~${Math.round(chars / 4)} tokens of names and descriptions (${chars} chars)`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
