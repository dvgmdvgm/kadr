// Node-side check of the store's `updateProjectSettings`: a change to the
// project's name, size or fps is ONE undo step per field edit, however many
// keystrokes it took, and an edit that changes nothing leaves no step.
//
// Cost of getting it wrong: an accidental fps change cannot be reverted, or
// typing "1080" takes four Ctrl+Z to get back.
// The store is bundled with esbuild (zustand from node_modules, @shared
// aliased), with a localStorage stub for the settings it reads at load.
// Run: node scripts/check-project-settings-undo.mjs
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
const fresh = () => {
  const p = newProject()
  p.fps = 30; p.width = 1920; p.height = 1080; p.name = 'Фильм'
  s().setProject(p)
}

check('the store has updateProjectSettings', typeof s().updateProjectSettings === 'function')
if (typeof s().updateProjectSettings !== 'function') process.exit(1)

// fps 30 → 25, Ctrl+Z → 30
fresh()
s().updateProjectSettings({ fps: 25 }, 1)
check('fps changes', s().project.fps === 25)
s().undo()
check('a project-settings edit is one undo step (fps 25 → undo → 30)', s().project.fps === 30,
  `fps ${s().project.fps}`)

// typing "1080" into W in one focus session: 1, 10, 108, 1080
fresh()
for (const w of [1, 10, 108, 1080]) s().updateProjectSettings({ width: w }, 2)
check('typing "1080" is one undo entry', s().past.length === 1, `${s().past.length} entries`)
check('the entry is labelled projectSettings', s().past[0]?.label === 'projectSettings')
s().undo()
check('one Ctrl+Z restores the width typed over', s().project.width === 1920)

// a new focus session is a new step
fresh()
s().updateProjectSettings({ name: 'A' }, 3)
s().updateProjectSettings({ name: 'AB' }, 3)
s().updateProjectSettings({ height: 720 }, 4)
check('two focus sessions are two steps', s().past.length === 2, `${s().past.length} entries`)
s().undo()
check('the second undo step is the height alone', s().project.height === 1080 && s().project.name === 'AB')
s().undo()
check('the first is the name', s().project.name === 'Фильм')

// a caller without a session (a script, a preset) gets one step per call
fresh()
s().updateProjectSettings({ fps: 24 })
s().updateProjectSettings({ fps: 60 })
check('calls without a session are one step each', s().past.length === 2)

// an edit that changes nothing leaves no step and keeps redo
fresh()
s().updateProjectSettings({ fps: 25 }, 5)
s().undo()
s().updateProjectSettings({ fps: 30 }, 6)
check('a no-op edit pushes nothing', s().past.length === 0)
check('a no-op edit keeps redo', s().future.length === 1)

// another edit between two changes of the same session starts a new step
fresh()
s().updateProjectSettings({ fps: 25 }, 7)
s().pushHistory('hEdit')
s().updateProjectSettings({ fps: 24 }, 7)
check('an edit in between splits the session', s().past.length === 3, `${s().past.length} entries`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
