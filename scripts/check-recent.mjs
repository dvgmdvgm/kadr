// Node-side check of shared/recent.ts — the recent-projects list behind the
// «Открыть» dropdown and the empty-project start state (card H1). No app.
//
// Cost when wrong: the wrong project opened — a list out of order, a project
// listed twice, or a store grown without bound.
// Run: node scripts/check-recent.mjs
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
  const src = readFileSync(join(root, 'shared', 'recent.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/recent.ts loads', false, String(err).split('\n')[0])
}
const { normalizeRecent, pushRecent, RECENT_CAP } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }
const paths = (l) => l.map((r) => r.path).join(',')

run('the list is newest first, unique by path, capped at 20', () => {
  let l = []
  for (let i = 0; i < 25; i++) l = pushRecent(l, `/p/${i}.kadr`, 1000 + i)
  check('capped at 20', l.length === 20 && RECENT_CAP === 20, String(l.length))
  check('newest first', l[0].path === '/p/24.kadr' && l[19].path === '/p/5.kadr', paths(l))
  // reopening an old one moves it to the top, once
  l = pushRecent(l, '/p/10.kadr', 2000)
  check('reopened goes to the top', l[0].path === '/p/10.kadr', paths(l))
  check('unique by path', l.filter((r) => r.path === '/p/10.kadr').length === 1 && l.length === 20)
})

run('open A, open B, reopen A', () => {
  let l = pushRecent([], 'A', 1)
  l = pushRecent(l, 'B', 2)
  check('B then A', paths(l) === 'B,A', paths(l))
  l = pushRecent(l, 'A', 3)
  check('A then B', paths(l) === 'A,B', paths(l))
})

run('a store from disk is healed', () => {
  const raw = [
    { path: 'old', at: 1 },
    null,
    { path: 42, at: 5 },
    { path: 'new', at: 9 },
    { path: 'old', at: 7 },     // a duplicate written by an older build: the newest wins
    { path: 'noTime' }
  ]
  const l = normalizeRecent(raw)
  check('sorted, deduped, junk dropped', paths(l) === 'new,old,noTime', paths(l))
  check('the duplicate keeps its newest time', l[1].at === 7, JSON.stringify(l[1]))
  check('not an array → empty', normalizeRecent({}).length === 0 && normalizeRecent(null).length === 0)
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `x${i}`, at: i }))
  check('an oversized store is capped', normalizeRecent(many).length === 20)
})

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
