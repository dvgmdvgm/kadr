// Node-side check of trackDeleteAsks in src/engine/discardGuard.ts — the rule
// «Удалить дорожку» consults before it removes a track. No app.
//
// The bug this guards: deleting a track removed it with every clip on it, with
// no question. Cost: a track of work deleted by a misclick (Ctrl+Z brought it
// back, if the user noticed). The dialog itself is walked live.
// Run: node scripts/check-destructive-confirm.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'src', 'engine', 'discardGuard.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('src/engine/discardGuard.ts loads', false, String(err).split('\n')[0])
}
const { trackDeleteAsks } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const full = { id: 't', kind: 'video', clips: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
const empty = { id: 'e', kind: 'audio', clips: [] }

run('deleting a non-empty track requires confirmation; an empty one does not', () => {
  check('deleting a non-empty track requires confirmation; an empty one does not',
    trackDeleteAsks(full, true) === 3 && trackDeleteAsks(empty, true) === 0,
    `full → ${trackDeleteAsks(full, true)}, empty → ${trackDeleteAsks(empty, true)}`)
})
run('the question names how many clips go', () => {
  check('the question names how many clips go', trackDeleteAsks({ ...full, clips: [{ id: 'x' }] }, true) === 1)
})
run('«Подтверждать удаление» off deletes without asking', () => {
  check('«Подтверждать удаление» off deletes without asking', trackDeleteAsks(full, false) === 0)
})

console.log(fails ? `${fails} check(s) failed` : 'all passed')
process.exit(fails ? 1 : 0)
