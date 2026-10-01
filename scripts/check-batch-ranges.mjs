// Long → shorts (card I11): the agent proposes kind "short" ranges
// (kadr_propose), the user confirms, and «Экспортировать выбранные» in the
// export dialog renders each confirmed range to its own file named from the
// reason — one export at a time (CLAUDE.md: ONE EXPORT AT A TIME), never
// overwriting a file already there or another short of the same batch.
// A short is never CUT: «Удалить подтверждённые» and kadr_propose apply leave it.
// No app, no tokens: the export itself is a stand-in that records the calls.
// Cost of getting it wrong: overwritten files, or parallel exports colliding.
// Run: node scripts/check-batch-ranges.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/silences'
      export * from './src/engine/shorts'
      export * as agentEdit from './src/engine/agentEdits'
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
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const tf = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
const mk = (id, assetId, start, duration) => ({
  id, kind: 'media', assetId, start, duration, inPoint: 0, label: id, speed: 1, muted: false,
  gain: { value: 1 }, fadeIn: 0, fadeOut: 0, effects: [], transform: tf
})
function fresh() {
  const p = newProject()
  p.fps = 30
  p.assets = [{ id: 'vv', kind: 'video', name: 'talk', path: 'talk.mp4', duration: 120, hasAudio: false, width: 1920, height: 1080 }]
  p.tracks = [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [mk('talk', 'vv', 0, 120)] }]
  useEditor.setState({ project: p, past: [], future: [], selection: [], range: null })
  M.clearSilences()
}
const items = () => M.useSilences.getState().items
const dur = () => Math.max(...s().project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)))

const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron', 'mcp-edit-tools.cjs'))
globalThis.window.kadrEditor = { agentEdit, useEditor }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
let pageCalls = 0
const editorEval = async (code) => { pageCalls++; return new AsyncFunction(code)() }
const tool = TOOLS.find((t) => t.name === 'kadr_propose')

// the agent proposes four shorts; the user confirms three of them
fresh()
const SHORTS = [
  { start: 60, end: 75, reason: 'Почему «кадр»: история названия' },
  { start: 10, end: 40, reason: 'Главная мысль / 30 секунд' },
  { start: 80, end: 90, reason: 'лишнее' },
  { start: 95, end: 115.5, reason: 'Главная мысль / 30 секунд' }
]
await runTool(tool, { kind: 'short', ranges: SHORTS }, editorEval)
check('kadr_propose kind "short": four flags, no undo step', items().length === 4 && items().every((x) => x.kind === 'short') && s().past.length === 0)
for (const x of items()) if (x.reason !== 'лишнее') M.setSilenceState(x.id, 'confirmed')

// a file of that name is already in the folder
const onDisk = new Set(['D:\\out\\Почему «кадр»_ история названия.mp4'])
const stat = async (paths) => paths.map((p) => (onDisk.has(p) ? 1 : null))
const jobs = await M.shortJobs('D:\\out', 'mp4', stat)
check('each confirmed short becomes one job, in timeline order', jobs.length === 3 && jobs.map((j) => j.start).join() === '10,60,95', JSON.stringify(jobs.map((j) => j.start)))
check('…its range is the proposal\'s (the file\'s length)', jobs.map((j) => j.end - j.start).join() === '30,15,20.5', jobs.map((j) => j.end - j.start).join())
const paths = jobs.map((j) => j.path)
check('…named from the reason, unsafe characters replaced', paths[0] === 'D:\\out\\Главная мысль _ 30 секунд.mp4', paths[0])
check('two shorts with one reason get two names', paths[2] === 'D:\\out\\Главная мысль _ 30 секунд (2).mp4', paths[2])
check('a file already in the folder is not overwritten', paths[1] === 'D:\\out\\Почему «кадр»_ история названия (2).mp4', paths[1])
check('every path in the batch is distinct', new Set(paths.map((p) => p.toLowerCase())).size === paths.length)
check('the unconfirmed short is not exported', !jobs.some((j) => j.start === 80))
{
  const long = await M.shortJobs('/tmp/x', 'mov', async (p) => p.map(() => null))
  check('a forward-slash folder joins with /', long[0].path === '/tmp/x/Главная мысль _ 30 секунд.mov', long[0].path)
}

// the queue: one export at a time, each range once
{
  let running = 0, most = 0
  const calls = []
  const start = (range, path) => {
    calls.push({ ...range, path })
    running++; most = Math.max(most, running)
    return { cancel() {}, done: new Promise((r) => setTimeout(() => { running--; r() }, 20)) }
  }
  const seen = []
  await M.exportShorts(jobs, start, (i) => seen.push(i)).done
  check('each confirmed range exports once with its own path', calls.length === 3 && calls.every((c, i) => c.path === jobs[i].path && c.start === jobs[i].start && c.end === jobs[i].end), JSON.stringify(calls))
  check('the export queue runs them one at a time', most === 1, `at most ${most} at once`)
  check('…progress names each item in turn', seen.join() === '0,1,2')
}
{
  // a failure stops the batch: nothing after it starts
  const calls = []
  const start = (range, path) => {
    calls.push(path)
    return { cancel() {}, done: calls.length === 2 ? Promise.reject(new Error('encoder died')) : Promise.resolve() }
  }
  let err
  try { await M.exportShorts(jobs, start).done } catch (e) { err = e }
  check('a failed export stops the batch and says so', calls.length === 2 && /encoder died/.test(err?.message), `${calls.length} ${err?.message}`)
}
{
  // cancel reaches the running export and nothing after it starts
  const calls = []
  let cancelled = 0
  let h
  const start = (range, path) => {
    calls.push(path)
    let rej
    const done = new Promise((_, r) => { rej = r })
    if (calls.length === 1) setTimeout(() => h.cancel(), 10)
    return { cancel() { cancelled++; rej(new Error('cancelled')) }, done }
  }
  h = M.exportShorts(jobs, start)
  let err
  try { await h.done } catch (e) { err = e }
  check('cancel stops the running export and the rest of the batch', calls.length === 1 && cancelled === 1 && /cancelled/.test(err?.message), `${calls.length} ${cancelled}`)
}

// a short is exported, never cut
{
  M.useSilences.setState((u) => ({ items: [...u.items, { id: 'retake1', kind: 'retake', reason: 'дубль', start: 50, end: 52, state: 'confirmed' }] }))
  check('«Удалить подтверждённые» counts no shorts', M.cuttable().length === 1 && M.cuttable()[0].id === 'retake1', JSON.stringify(M.cuttable().map((x) => x.id)))
  pageCalls = 0
  let err
  try { await runTool(tool, { apply: 'confirmed', kind: 'short' }, editorEval) } catch (e) { err = e }
  check('kadr_propose apply kind "short" is refused before the page', !!err && pageCalls === 0, err?.message)
  M.applySilences('confirmed')
  check('applying confirmed proposals cuts the retake only, never a short', near(120 - dur(), 2) && s().past.length === 1, `${120 - dur()}`)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
