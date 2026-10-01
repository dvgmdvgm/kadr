// Node-side check of the command palette's matching (shared/keymap.ts
// `paletteMatch`) over the REAL registry labels (src/i18n.ts). No app.
//
// The bug this guards: every feature was a button, and nothing found an action
// by name. The palette must find an action by either language's label — an
// English word finds a Russian label — rank word-prefix matches before
// substrings, and every registered action must have a label in both languages.
// Cost: users cannot find features.
// Run: node scripts/check-palette-match.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const load = async (entry) => {
  const out = await build({
    entryPoints: [join(root, entry)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { '@shared': join(root, 'shared') },
    // i18n.ts reads the UI language from the store; the check names the language itself
    plugins: [{
      name: 'no-store',
      setup(b) {
        b.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useSettings = { getState: () => ({ lang: "ru" }) }' }))
      }
    }]
  })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}

let km = {}, i18n = {}
try { km = await load('shared/keymap.ts') } catch (err) { check('shared/keymap.ts loads', false, String(err).split('\n')[0]) }
try { i18n = await load('src/i18n.ts') } catch (err) { check('src/i18n.ts loads', false, String(err).split('\n')[0]) }
const { ACTIONS, paletteMatch } = km
const { trIn } = i18n

check('paletteMatch is exported', typeof paletteMatch === 'function')
check('trIn is exported', typeof trIn === 'function')

if (ACTIONS && typeof trIn === 'function') {
  // › every action has a label in both languages
  const bad = ACTIONS.filter((a) => !trIn('ru', a.labelKey) || !trIn('en', a.labelKey)).map((a) => a.id)
  check('every action has a ru and an en label', bad.length === 0, bad.join(', '))
  check('Ctrl+K opens the palette', ACTIONS.some((a) => a.id === 'app.palette' &&
    a.defaultKeys.length === 1 && a.defaultKeys[0].code === 'KeyK' && a.defaultKeys[0].ctrl))
}

if (ACTIONS && typeof paletteMatch === 'function' && typeof trIn === 'function') {
  const items = (lang) => {
    const other = lang === 'ru' ? 'en' : 'ru'
    return ACTIONS.map((a) => ({ id: a.id, labels: [trIn(lang, a.labelKey), trIn(other, a.labelKey)] }))
  }
  const ids = (q, lang = 'ru') => paletteMatch(items(lang), q).map((m) => m.id)

  // › a query finds actions by either language's label and ranks prefix matches first
  check('«эксп» → Экспорт first', ids('эксп')[0] === 'file.export', ids('эксп').join(','))
  const beats = paletteMatch(items('ru'), 'beats')
  check('«beats» (ru UI) finds «Биты музыки» through its English label',
    beats[0]?.id === 'tools.beats' && beats[0]?.via === 1, JSON.stringify(beats[0]))
  check('«биты» (en UI) finds Music beats through its Russian label', ids('биты', 'en')[0] === 'tools.beats')
  check('the current language wins when both match equally',
    paletteMatch([{ id: 'x', labels: ['Mix down', 'Mix'] }], 'mix')[0]?.via === 0)
  check('a prefix in the other language beats a substring in this one',
    paletteMatch([{ id: 'x', labels: ['Remix', 'Mix'] }], 'mix')[0]?.via === 1)
  const tr = ids('тр')
  check('«тр»: word prefix (Транскрибировать) before substring (Предпросмотр)',
    tr.indexOf('tools.transcribe') >= 0 && tr.indexOf('preview.popout') > tr.indexOf('tools.transcribe'), tr.join(','))
  const m = paletteMatch(items('ru'), 'тр').find((x) => x.id === 'preview.popout')
  check('the match position is reported for highlighting', m?.at === 'Предпросмо'.length && m?.len === 2, JSON.stringify(m))
  check('a word inside a label counts as a prefix («музыки»)', paletteMatch(items('ru'), 'муз')[0]?.rank === 0)
  check('case and ё do not matter', ids('ЭКСП')[0] === 'file.export' && ids('вперед').includes('playhead.nextFrame'))
  check('empty query lists every action in registry order',
    JSON.stringify(ids('')) === JSON.stringify(ACTIONS.map((a) => a.id)))
  check('ties keep registry order', (() => {
    const r = ids('с') // many substring hits
    const order = ACTIONS.map((a) => a.id)
    const ranks = paletteMatch(items('ru'), 'с')
    return ranks.every((x, i) => i === 0 || x.rank > ranks[i - 1].rank || order.indexOf(x.id) > order.indexOf(ranks[i - 1].id)) && r.length > 1
  })())
  check('nothing found → empty', ids('рендер').length === 0)
}

console.log(fails ? `\n${fails} FAIL` : '\nall passed')
process.exit(fails ? 1 : 0)
