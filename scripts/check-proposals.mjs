// Agent proposals (card I8): kadr_propose(kind, ranges[{start,end,reason}]) shows
// ranges as confirm flags (the silence/defect flag UI); only what the USER
// confirmed is cut, all of it in ONE undo step, overlapping ranges merged.
// No app, no tokens: the agent is the tool's own page code over the store.
// Cost of getting it wrong: the agent cutting good takes.
// Run: node scripts/check-proposals.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/silences'
      export * as agentEdit from './src/engine/agentEdits'
      export { placeWords } from './src/engine/words'
      export { useEditor, newProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
globalThis.window = globalThis.window ?? {}
const M = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
const { useEditor, newProject, agentEdit } = M

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const FPS = 30
const onFrame = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol

// a generated transcript with a retake: «раз два три» said twice, then «четыре»
const WORDS = [
  ['раз', 0.5, 0.9], ['два', 1.0, 1.4], ['три', 1.5, 1.9],
  ['раз', 3.0, 3.4], ['два', 3.5, 3.9], ['три', 4.0, 4.4],
  ['четыре', 6.0, 6.6], ['пять', 8.0, 8.5], ['шесть', 10.0, 10.5]
].map(([w, t0, t1]) => ({ w, t0, t1, p: 0.9 }))
const tf = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
const mk = (id, assetId, start, duration, extra = {}) => ({
  id, kind: 'media', assetId, start, duration, inPoint: 0, label: id, speed: 1, muted: false,
  gain: { value: 1 }, fadeIn: 0, fadeOut: 0, effects: [], transform: tf, ...extra
})
const tr = (id, kind, clips) => ({ id, kind, name: id, muted: false, locked: false, gain: 1, clips })
function fresh() {
  const p = newProject()
  p.fps = FPS
  p.assets = [
    { id: 'av', kind: 'audio', name: 'voice', path: 'voice.wav', duration: 12, hasAudio: true },
    { id: 'vv', kind: 'video', name: 'cam', path: 'cam.mp4', duration: 12, hasAudio: false, width: 1920, height: 1080 }
  ]
  p.tracks = [tr('V1', 'video', [mk('cam', 'vv', 0, 12, { linkId: 'L' })]), tr('A1', 'audio', [mk('voice', 'av', 0, 12, { linkId: 'L' })])]
  p.texts = [{ id: 'd1', name: 'voice.srt', kind: 'srt', assetId: 'av', cues: [], words: WORDS }]
  useEditor.setState({ project: p, past: [], future: [], selection: [], range: null })
  M.clearSilences()
}
const dur = () => Math.max(...s().project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)))
const snap = () => JSON.stringify(s().project)
const items = () => M.useSilences.getState().items

const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron', 'mcp-edit-tools.cjs'))
globalThis.window.kadrEditor = { agentEdit, useEditor }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
let pageCalls = 0
const editorEval = async (code) => { pageCalls++; return new AsyncFunction(code)() }
const tool = TOOLS.find((t) => t.name === 'kadr_propose')
const silTool = TOOLS.find((t) => t.name === 'kadr_silences')
check('kadr_propose is in the tool table, page code in agentEdit', !!tool && typeof agentEdit[tool?.fn] === 'function')
if (!tool) { console.log('\n1 FAIL'); process.exit(1) }

// the agent reads the words (placed on the timeline) and proposes three ranges
fresh()
const w = M.placeWords(s().project).filter((x) => x.clipId === 'voice')
check('the generated transcript is placed on the timeline', w.length === WORDS.length, `${w.length}`)
const RANGES = [
  { start: 0.45, end: 2.95, reason: 'дубль: «раз два три» повторено, лучше второе' },
  { start: 4.5, end: 5.9, reason: 'пауза-заминка перед «четыре»' },
  { start: 6.7, end: 7.9, reason: 'тишина' }
]
{
  const r = await runTool(tool, { kind: 'retake', ranges: RANGES }, editorEval)
  check('kadr_propose: three proposals with ids, no undo step', r.proposals?.length === 3 && r.proposals.every((x) => x.id) && s().past.length === 0, JSON.stringify(r))
  const it = items()
  check('…shown as flags (the proposal store), kind and reason kept',
    it.length === 3 && it.every((x, i) => x.kind === 'retake' && x.reason === RANGES[i].reason && x.state === 'proposed'), JSON.stringify(it))
  check('…edges on frames', it.every((x) => onFrame(x.start) && onFrame(x.end)))
}

// nothing is cut without a confirmation
{
  let err
  try { await runTool(tool, { apply: 'confirmed' }, editorEval) } catch (e) { err = e }
  check('apply with nothing confirmed: an error, no step, nothing cut', /nothing/.test(err?.message) && s().past.length === 0 && near(dur(), 12), err?.message)
  pageCalls = 0
  let e2
  try { await runTool(tool, { apply: [items()[0].id] }, editorEval) } catch (e) { e2 = e }
  check('apply by ids is refused (the user confirms, not the agent)', !!e2 && pageCalls === 0, e2?.message)
  let e3
  try { await runTool(silTool, { apply: 'all' }, editorEval) } catch (e) { e3 = e }
  check('kadr_silences apply "all" does not cut unconfirmed retake proposals', near(dur(), 12) && s().past.length === 0 && items().length === 3, e3?.message)
}

// only confirmed ranges are applied, in one undo
{
  const before = snap()
  const [a, , c] = items()
  M.setSilenceState(a.id, 'confirmed')
  M.setSilenceState(c.id, 'confirmed')
  check('confirming is no edit', s().past.length === 0 && snap() === before)
  const r = await runTool(tool, { apply: 'confirmed' }, editorEval)
  const cut = (a.end - a.start) + (c.end - c.start)
  check('only confirmed ranges are applied: exactly those two removed', r.removed?.length === 2 && near(12 - dur(), cut), `${12 - dur()} vs ${cut}`)
  check('…in one undo', s().past.length === 1, `${s().past.length}`)
  check('…the twins cut alike', JSON.stringify(s().project.tracks[0].clips.map((x) => [x.start, x.duration])) === JSON.stringify(s().project.tracks[1].clips.map((x) => [x.start, x.duration])))
  s().undo()
  check('one undo restores the project exactly', snap() === before)
}

// overlapping ranges merge
fresh()
{
  await runTool(tool, { kind: 'retake', ranges: [{ start: 2, end: 4, reason: 'a' }, { start: 3, end: 5, reason: 'b' }, { start: 8, end: 9, reason: 'c' }] }, editorEval)
  for (const x of items()) M.setSilenceState(x.id, 'confirmed')
  M.applySilences('confirmed')
  check('overlapping ranges merge: 2–5 and 8–9 remove 4 s, not 5', near(12 - dur(), 4), `${12 - dur()}`)
  check('…one undo step', s().past.length === 1)
  s().undo()
  s().extractRanges([{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 4, end: 5 }])
  check('store.extractRanges merges overlapping and touching ranges: 1–5 = 4 s', near(12 - dur(), 4), `${12 - dur()}`)
}

// kinds live side by side; a new set of one kind replaces only that kind
fresh()
{
  M.useSilences.setState({ items: [{ id: 's1', kind: 'silence', start: 10.6, end: 11.5, state: 'confirmed' }] })
  await runTool(tool, { kind: 'retake', ranges: RANGES }, editorEval)
  check('proposing keeps the silence proposals', items().length === 4 && items().some((x) => x.id === 's1'))
  await runTool(tool, { kind: 'retake', ranges: [RANGES[1]] }, editorEval)
  check('a new retake set replaces the old retake set only', items().length === 2 && items().filter((x) => x.kind === 'retake').length === 1)
  const ids = new Set(items().map((x) => x.id))
  check('ids are unique across kinds', ids.size === items().length)
  let err
  try { await runTool(tool, { kind: 'retake', ranges: [{ start: 20, end: 21, reason: 'x' }] }, editorEval) } catch (e) { err = e }
  check('a range past the end of the timeline is refused by the page', !!err && items().length === 2, err?.message)
}

// invalid input never reaches the page
const bad = [{}, { kind: 'retake' }, { kind: 'retake', ranges: [] }, { kind: 'Re take', ranges: RANGES },
  { kind: 'retake', ranges: [{ start: 2, end: 1, reason: 'x' }] }, { kind: 'retake', ranges: [{ start: 1, end: 2 }] },
  { kind: 'retake', ranges: [{ start: 1, end: 2, reason: '' }] }, { apply: 'all' }, { apply: 'confirmed', kind: 'retake', ranges: RANGES }]
for (const args of bad) {
  pageCalls = 0
  let e
  try { await runTool(tool, args, editorEval) } catch (x) { e = x }
  check(`kadr_propose rejects ${JSON.stringify(args).slice(0, 80)} before the page`, !!e && pageCalls === 0, e?.message)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
