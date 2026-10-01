// Agent-turn checkpoints (card B8): where a turn of the embedded Claude begins,
// and that reverting it brings back the project exactly as it was before.
//
// Cost of getting it wrong: a checkpoint taken in mid-turn, so «Откатить ход
// агента» restores half an edit; or a turn longer than the 50-step undo stack
// that can no longer be taken back at all.
// shared/agentTurn.ts is plain TS (esbuild); the store is bundled like
// check-project-settings-undo does it.
// Run: node scripts/check-agent-turns.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (entry) => {
  const out = buildSync({
    entryPoints: [join(root, entry)],
    bundle: true, format: 'esm', platform: 'neutral', write: false,
    mainFields: ['module', 'main'],
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
}

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// ---- the boundary
let turns
try { turns = await load('shared/agentTurn.ts') } catch (e) { check('shared/agentTurn.ts loads', false, e.message.split('\n')[0]); process.exit(1) }
const { turnTracker, isUserInput, TURN_SILENCE_MS } = turns
check('silence threshold is 20 s', TURN_SILENCE_MS === 20000)

{
  const t = turnTracker()
  const seq = []
  seq.push(t.evalStart(1000)); t.evalEnd(1100)          // first eval of a session: new turn
  seq.push(t.evalStart(1200)); t.evalEnd(1300)          // same turn
  seq.push(t.evalStart(15000)); t.evalEnd(16000)        // 13.7 s of silence: same turn
  t.input('x', 17000)                                   // the user typed
  seq.push(t.evalStart(18000)); t.evalEnd(18100)        // new turn
  seq.push(t.evalStart(18200)); t.evalEnd(18300)        // same turn
  seq.push(t.evalStart(18300 + TURN_SILENCE_MS + 1))    // 20 s of silence: new turn
  check('a keystroke or 20 s of silence opens a new turn; evals inside a turn do not',
    JSON.stringify(seq) === JSON.stringify([true, false, false, true, false, true]), JSON.stringify(seq))
}
{
  // silence counts from the END of the last eval: a 5-minute export is not a gap
  const t = turnTracker()
  t.evalStart(0); t.evalEnd(300000)
  check('a long tool call is not silence', t.evalStart(301000) === false)
}
{
  // the user typed WHILE a long eval ran: the next eval is theirs, a new turn
  const t = turnTracker()
  t.evalStart(0); t.input('stop', 5000); t.evalEnd(60000)
  check('a keystroke during a running eval opens a new turn after it', t.evalStart(60100) === true)
}
{
  // xterm answers the terminal on its own (focus in/out, cursor reports): not the user
  const t = turnTracker()
  t.evalStart(0); t.evalEnd(10)
  for (const r of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[I\x1b[O']) t.input(r, 20)
  check('terminal replies are not keystrokes', t.evalStart(30) === false)
  check('real input is a keystroke: Enter, text, arrows, Esc',
    ['\r', 'сделай', '\x1b[A', '\x1b', '\x03'].every(isUserInput))
}

// ---- the store: checkpoint, a 60-edit turn, revert
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const { useEditor, newProject } = await load('src/state/store.ts')
const s = () => useEditor.getState()
check('the store has agentCheckpoint and revertAgentTurn',
  typeof s().agentCheckpoint === 'function' && typeof s().revertAgentTurn === 'function')
if (fails) process.exit(1)

const p0 = newProject()
p0.name = 'до хода'
s().setProject(p0)
s().addMarker(1)
const before = JSON.stringify(s().project)
s().agentCheckpoint()
for (let i = 0; i < 60; i++) { s().addMarker(2 + i) }   // 60 edits, as kadr_eval would
check('the turn pushed the start out of undo', s().past.length === 50, `${s().past.length} entries`)
// an in-place mutation (off-convention, but reachable from kadr_eval) must not reach the checkpoint
s().project.name = 'mutated'
const restored = s().revertAgentTurn()
check('restore equals the pre-turn project', restored && JSON.stringify(s().project) === before)
check('the revert is one undo entry', s().past.at(-1)?.label === 'hAgentRevert')
s().undo()
check('Ctrl+Z after the revert brings the turn back', s().project.markers.length === 61)

// a second turn gets its own checkpoint
s().setProject(p0)
s().agentCheckpoint()
s().addMarker(5)
const mid = JSON.stringify(s().project)
s().agentCheckpoint()
s().addMarker(6)
s().revertAgentTurn()
check('a second turn gets its own checkpoint', JSON.stringify(s().project) === mid)
s().revertAgentTurn()
check('a second revert walks back the turn before it', s().project.markers.length === 0)
check('with no checkpoint left, revert does nothing', s().revertAgentTurn() === false)

// a turn that changed nothing takes no new checkpoint (a read-only question)
s().agentCheckpoint(); s().agentCheckpoint()
check('an unchanged project is checkpointed once', s().agentCheckpoints.length === 1)

// the ring keeps 10
for (let i = 0; i < 14; i++) { s().addMarker(10 + i); s().agentCheckpoint() }
check('the ring keeps 10 checkpoints', s().agentCheckpoints.length === 10)

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
