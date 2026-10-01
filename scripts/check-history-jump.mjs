// Node-side check of the undo history list (card L2): clicking an entry in the
// list jumps the history there, and a jump must be EXACTLY that many single
// undos (or redos) — same project, same stacks, same selection. Entries the
// embedded Claude pushed (inside an /eval) carry the turn they belong to, and
// keep it through undo and redo.
//
// Cost of getting it wrong: a jump that lands on a different state than the
// row it was clicked on promised.
// The store is bundled with esbuild like check-project-settings-undo.mjs.
// Run: node scripts/check-history-jump.mjs
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
const view = () => JSON.stringify({
  project: s().project, selection: s().selection,
  past: s().past.map((e) => [e.label, e.turn ?? null, JSON.stringify(e.project)]),
  future: s().future.map((e) => [e.label, e.turn ?? null, JSON.stringify(e.project)])
})
// eight named edits: the project's name walks e1 … e8
// the same base every time: newProject() mints fresh ids
const base = newProject()
base.name = 'e0'
const fresh = () => {
  s().setProject(JSON.parse(JSON.stringify(base)))
  for (let i = 1; i <= 8; i++) {
    s().pushHistory(`h${i}`)
    useEditor.setState((st) => ({ project: { ...st.project, name: `e${i}` } }))
  }
}

check('the store has jumpHistory', typeof s().jumpHistory === 'function')
if (typeof s().jumpHistory !== 'function') { console.log('1 FAIL'); process.exit(1) }

// jumping to an entry equals N single undos
fresh()
for (let i = 0; i < 5; i++) s().undo()
const fiveUndos = view()
fresh()
s().jumpHistory(5)
check('jumping to an entry equals N single undos (5 back)', view() === fiveUndos, `name ${s().project.name}`)
check('five back from e8 is e3, h4…h8 redoable', s().project.name === 'e3' && s().future.map((e) => e.label).join() === 'h4,h5,h6,h7,h8')

// and forward: −3 equals three single redos
s().redo(); s().redo(); s().redo()
const threeRedos = view()
fresh(); s().jumpHistory(5)
s().jumpHistory(-3)
check('jumping forward equals N single redos (3)', view() === threeRedos, `name ${s().project.name}`)

// clamped at both ends, never throws, a zero jump changes nothing
fresh()
s().jumpHistory(99)
check('a jump past the oldest entry stops there', s().project.name === 'e0' && s().past.length === 0)
s().jumpHistory(-99)
check('a jump past the newest entry stops there', s().project.name === 'e8' && s().future.length === 0)
const before = view()
s().jumpHistory(0)
check('a zero jump changes nothing', view() === before)

// agent turns: entries pushed inside an /eval carry the turn's start; the user's do not
const p = newProject(); s().setProject(p)
s().pushHistory('hUser1')
s().agentCheckpoint()
const turnAt = s().agentTurnAt
s().agentEval(1)
s().pushHistory('hAgentA')
s().pushHistory('hAgentB')
s().agentEval(-1)
s().pushHistory('hUser2')
const marks = s().past.map((e) => `${e.label}:${e.turn ? 'T' : '-'}`).join(' ')
check('entries pushed during an agent eval carry its turn', marks === 'hUser1:- hAgentA:T hAgentB:T hUser2:-', marks)
check('the mark is the turn start', s().past[1].turn === turnAt && turnAt > 0)
s().jumpHistory(3)
check('the turn mark survives undo (into the redo list)', s().future.map((e) => e.turn ? 'T' : '-').join('') === 'TT-')
s().jumpHistory(-3)
check('and redo', s().past.map((e) => e.turn ? 'T' : '-').join('') === '-TT-')
// a second turn whose project was unchanged still gets its own mark
s().agentCheckpoint(); s().agentCheckpoint()
check('every turn start moves the mark, checkpoint or not', s().agentTurnAt >= turnAt)
// an eval that throws must not leave the counter up (the wrapper decrements in finally)
s().agentEval(1); s().agentEval(-1); s().agentEval(-1)
s().pushHistory('hUser3')
check('the counter never goes below zero', !s().past.at(-1).turn)

console.log(fails ? `${fails} FAIL` : 'all PASS')
process.exit(fails ? 1 : 0)
