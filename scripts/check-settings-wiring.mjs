// Static check: every setting in the schema (shared/settings.ts) has a
// consumer and a row on the settings screen. No app.
//
// The bug this guards: a setting that does nothing — a row the user changes
// with no code reading it, or a knob in the file nobody can see. Consumers are
// found by the key's literal ('editing.snapRadius') in src/ or electron/,
// outside the schema and the dialog; the five keys the store maps onto named
// fields (`trackH: v('editing.trackHeight')`) count when that field is read.
// Run: node scripts/check-settings-wiring.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const schema = readFileSync(join(root, 'shared/settings.ts'), 'utf8')
const keys = [...schema.matchAll(/^\s*'([a-zA-Z]+\.[a-zA-Z]+)':\s*\{/gm)].map((m) => m[1])
check('the schema lists its keys', keys.length > 0, `${keys.length} keys`)

const files = []
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx|cjs)$/.test(n)) files.push(p)
  }
}
walk(join(root, 'src'))
walk(join(root, 'electron'))

const DIALOG = join(root, 'src/components/SettingsDialog.tsx')
const STORE = join(root, 'src/state/store.ts')
const dialog = existsSync(DIALOG) ? readFileSync(DIALOG, 'utf8') : ''
check('src/components/SettingsDialog.tsx exists', !!dialog)

// the store's named fields: `trackH: v('editing.trackHeight') …`
const store = readFileSync(STORE, 'utf8')
const fieldOf = Object.fromEntries(
  [...store.matchAll(/^\s*(\w+):\s*v\('([\w.]+)'\)/gm)].map((m) => [m[2], m[1]]))
const storeRest = store.replace(/const settingFields[\s\S]*?\n}\n/, '')

const texts = files
  .filter((f) => f !== DIALOG)
  .map((f) => ({ f, s: f === STORE ? storeRest : readFileSync(f, 'utf8') }))

for (const k of keys) {
  const lit = new RegExp(`['"\`]${k.replace('.', '\\.')}['"\`]`)
  const users = texts.filter(({ s }) => lit.test(s)).map(({ f }) => relative(root, f))
  const field = fieldOf[k]
  if (field) {
    const read = new RegExp(`\\.${field}\\b|\\(s\\) => s\\.${field}\\b|\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*useSettings`)
    users.push(...texts.filter(({ f, s }) => f !== STORE && read.test(s)).map(({ f }) => relative(root, f)))
  }
  check(`${k} has a consumer`, users.length > 0, users.slice(0, 3).join(', '))
  check(`${k} has a row on the settings screen`, lit.test(dialog))
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
