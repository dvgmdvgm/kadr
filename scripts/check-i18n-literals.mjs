// Source scan: no user-visible text is written outside src/i18n.ts, and every
// clickable element and form field has a name. No app, no network.
//
// The bug this guards: the English UI showing Russian, and vice versa — a
// session-log message, a tooltip or an error from main written as a literal
// in one language shows in that language whatever the user picked. And a
// clickable div without a role, or a field without a label, is invisible to a
// screen reader.
//
// Rules (TS AST over src/**/*.ts(x), electron/*.ts, shared/*.ts):
//  1. JSX text, and a literal given to title / aria-label / placeholder / alt,
//     comes from the table — except the proper nouns and codes in ALLOW.
//  2. No Cyrillic in a string or template literal of a component (.tsx). The
//     .ts modules still throw Russian errors: counted against a ceiling that
//     may only fall. Main hands the renderer a key and args (`Said`) instead.
//  3. log*(source, msg) never gets a literal with words (a file name aside):
//     both go through tr().
//  4. The English table carries no Cyrillic.
//  5. An element that is not a control but takes onClick has a role.
//  6. An <input>/<select>/<textarea> sits in a <label> or has aria-label(ledby).
// Run: node scripts/check-i18n-literals.mjs
import { readFileSync, readdirSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, hits) => {
  console.log(`${hits.length ? 'FAIL' : 'PASS'}  ${name}${hits.length ? ` — ${hits.length}` : ''}`)
  for (const h of hits) console.log('      ' + h)
  if (hits.length) fails++
}

// proper nouns, product names, key names, units and codes that read the same in both languages
const ALLOW = new Set([
  'Kadr', 'Claude', 'Claude Code', 'Python', 'BPM', 'Remotion:', 'Ctrl+S', '· Ctrl+S', 'Ctrl+Shift+S', 'Esc', 'OK',
  'Русский', 'English', 'Sans', 'Arial Black', 'Serif', 'Mono', 'large-v3 —', 'medium —', 'base —',
  '~/kadr-fragments', 'claude', 'http://127.0.0.1:1080', 'fps ·', 'RU', 'EN'
])
const DEBT_CEILING = 142
const CYR = /[Ѐ-ӿ]/
const WORD = /[A-Za-zЀ-ӿ]{2,}/
const ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt'])
const CONTROLS = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'option'])
const FIELDS = new Set(['input', 'select', 'textarea'])

const walk = (d, re) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name), re) : re.test(e.name) ? [join(d, e.name)] : [])
const files = [
  ...walk(join(root, 'src'), /\.tsx?$/),
  ...readdirSync(join(root, 'electron')).filter((f) => /\.ts$/.test(f)).map((f) => join(root, 'electron', f)),
  ...walk(join(root, 'shared'), /\.ts$/)
].filter((f) => !/[\\/](i18n|icons)\.tsx?$/.test(f))

const literal = (e) => {
  if (!e) return null
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => s.literal.text).join('')
  if (ts.isConditionalExpression(e)) return literal(e.whenTrue) || literal(e.whenFalse)
  if (ts.isBinaryExpression(e)) return literal(e.left) || literal(e.right)
  if (ts.isParenthesizedExpression(e)) return literal(e.expression)
  return null
}
const allowed = (s) => ALLOW.has(s.trim().replace(/\s+/g, ' '))

const text = [], cyr = [], debt = [], logs = [], roles = [], labels = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const rel = relative(root, file).replace(/\\/g, '/')
  const at = (n, s) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}  ${s.trim().replace(/\s+/g, ' ').slice(0, 80)}`
  const tsx = rel.endsWith('.tsx')
  const tagOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n)
  const inLabel = (n) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === 'label') return true
    return false
  }
  ;(function visit(n) {
    if (ts.isJsxText(n) && WORD.test(n.text) && !allowed(n.text)) text.push(at(n, n.text))
    if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText())) {
      const init = n.initializer
      const lit = init && (ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? literal(init.expression) : null)
      if (lit && WORD.test(lit) && !allowed(lit)) text.push(at(n, `${n.name.getText()}=${lit}`))
    }
    const strs = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? [n.text]
      : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)] : []
    if (strs.some((s) => CYR.test(s)) && !ts.isJsxAttribute(n.parent) && !allowed(strs.join('')) && !ts.isTemplateSpan(n.parent)) {
      (tsx ? cyr : debt).push(at(n, strs.join('…')))
    }
    if (ts.isCallExpression(n) && /^log(Error|Warn|Info)$/.test(n.expression.getText())) {
      for (const a of n.arguments.slice(0, 2)) {
        const lit = literal(a)
        if (lit && WORD.test(lit.replace(/[\w.-]+\.[a-z0-9]{2,4}\b/gi, ''))) logs.push(at(a, lit))
      }
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = tagOf(n)
      const tag = open.tagName.getText()
      const names = open.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText())
      if (/^[a-z]/.test(tag) && !CONTROLS.has(tag) && names.includes('onClick') && !names.includes('role'))
        roles.push(at(n, `<${tag}> with onClick and no role`))
      const type = open.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText() === 'type')?.initializer?.getText()
      if (FIELDS.has(tag) && !/hidden|file/.test(type ?? '') && !names.some((x) => x === 'aria-label' || x === 'aria-labelledby') && !inLabel(n))
        labels.push(at(n, `<${tag}${type ? ' type=' + type : ''}> with no label`))
    }
    ts.forEachChild(n, visit)
  })(sf)
}

// the English table: everything between `const en` and the end of its object literal
const i18n = readFileSync(join(root, 'src/i18n.ts'), 'utf8')
const enAt = i18n.indexOf('const en')
const en = i18n.slice(enAt, i18n.indexOf('\n}\n', enAt))
const enCyr = en.split('\n').map((l, i) => [l, i]).filter(([l]) => CYR.test(l.replace(/\/\/.*$/, '')))
  .map(([l]) => 'src/i18n.ts (en)  ' + l.trim().slice(0, 80))

check('no user-visible literal outside i18n.ts (JSX text, title, aria-label, placeholder, alt)', text)
check('no Cyrillic literal in a component', cyr)
// Known debt, a ratchet: error texts thrown by engine modules and main (checks'
// findings, voice-over, 3D import, …) are still Russian. The number may only fall.
console.log(`      (${debt.length} Cyrillic literals left in .ts modules, ceiling ${DEBT_CEILING})`)
check(`the .ts modules carry no more Cyrillic literals than before (${DEBT_CEILING})`, debt.length > DEBT_CEILING ? debt : [])
check('session-log sources and messages go through tr()', logs)
check('the English table has no Russian', enCyr)
check('every clickable non-control element has a role', roles)
check('every input, select and textarea has a label', labels)
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
