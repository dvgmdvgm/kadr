// Node-side check of «Выделение — в запрос агенту» (card I2): the line the
// panel types into claude's prompt. No app, no claude, no tokens.
//
// Cost of getting it wrong: an accidental send (a newline or a bracketed-paste
// end inside the line submits it) or a wrong target (times the agent's tools
// read differently, a clip it cannot name).
// Run: node scripts/check-context-line.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/contextLine'; export { useEditor, useSettings, newProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
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
const { contextLine, setContextTarget, sendContext, contextTargetOpen, useSettings, newProject } = await import(
  'data:text/javascript;base64,' + Buffer.from(out).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const base = newProject()
const clip = (id, start, duration, extra = {}) => ({
  id, kind: 'media', start, duration, inPoint: 40, speed: 2, gain: { value: 1 }, muted: false,
  transform: {}, effects: [], ...extra
})
const project = {
  ...base,
  assets: [{ id: 'a1', path: '/m/a.mp4', name: 'a.mp4', kind: 'video' }, { id: 'a2', path: '/m/b.wav', name: 'b.wav', kind: 'audio' }],
  tracks: [
    { ...base.tracks[0], clips: [clip('c2', 3, 5, { assetId: 'a1' }), clip('t9', 20, 2, { kind: 'text', label: 'Text', text: 'Hi\r\nthere\x1b[201~ go' })] },
    { ...(base.tracks[1] ?? base.tracks[0]), id: 'trk-b', clips: [clip('c1', 1.5, 2.25, { assetId: 'a2', label: 'Voice\nover' })] }
  ]
}
const st = (sel, extra = {}) => ({ project, selection: sel, playhead: 12.4, range: { start: 10, end: 15 }, ...extra })
const clean = (s) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s)

for (const lang of ['ru', 'en']) {
  useSettings.setState({ lang })
  const line = contextLine(st(['c2', 'c1']))
  console.log(`      ${lang}: ${JSON.stringify(line)}`)
  check(`${lang}: starts with [kadr] and ends with a space, not a newline`, line.startsWith('[kadr] ') && line.endsWith(' '))
  check(`${lang}: no newline or control character anywhere`, clean(line))
  check(`${lang}: names both clips with their ids`, /a\.mp4 #c2/.test(line) && /Voice over #c1/.test(line), line)
  check(`${lang}: clip times are TIMELINE seconds (start–end), not source`, line.includes('3.00–8.00s') && line.includes('1.50–3.75s'))
  check(`${lang}: clips in timeline order`, line.indexOf('#c1') < line.indexOf('#c2'))
  check(`${lang}: the playhead in seconds`, line.includes('12.40s'))
  check(`${lang}: the range in seconds`, line.includes('10.00–15.00s'))
  check(`${lang}: the count agrees in number`, line.includes(lang === 'ru' ? '2 клипа' : '2 clips'))
}
useSettings.setState({ lang: 'ru' })
const text = contextLine(st(['t9']))
check('a text clip is named by its text (not the stock «Text» label), control characters gone', clean(text) && text.includes('Hi there [201~ go #t9'), JSON.stringify(text))
check('one clip: singular', text.includes('1 клип '))
const bare = contextLine(st([], { range: null }))
check('nothing selected and no range: only the playhead', bare === '[kadr] плейхед 12.40s ', JSON.stringify(bare))
const gone = contextLine(st(['nope']))
check('a stale selection id is skipped, not printed', !gone.includes('nope') && !gone.includes('клип'), JSON.stringify(gone))
const many = { ...project, tracks: [{ ...project.tracks[0], clips: Array.from({ length: 9 }, (_, i) => clip('m' + i, i, 1, { assetId: 'a1' })) }] }
const capped = contextLine({ project: many, selection: many.tracks[0].clips.map((c) => c.id), playhead: 0, range: null })
check('many clips: the first 6 named, the rest counted', capped.includes('9 клипов') && capped.includes('#m5') && !capped.includes('#m6') && capped.includes('+3'), JSON.stringify(capped))
const long = contextLine(st(['c1'], { project: { ...project, tracks: [{ ...project.tracks[1], clips: [clip('c1', 0, 1, { label: 'x'.repeat(200) })] }] } }))
check('a long name is shortened to 40 characters', long.includes('x'.repeat(39) + '…') && !long.includes('x'.repeat(40)), long)

// the panel's paste path: nothing without a panel, exactly the line with one
check('no panel: no target', !contextTargetOpen() && sendContext() === false)
const typed = []
const off = setContextTarget((s) => typed.push(s))
check('panel: sendContext types the line once', sendContext() === true && typed.length === 1 && typed[0].startsWith('[kadr] ') && clean(typed[0]))
off()
check('a closed panel stops being the target', !contextTargetOpen())
const offA = setContextTarget(() => {})
const offB = setContextTarget((s) => typed.push(s))
offA() // StrictMode: the first mount's cleanup runs after the second mount
check('an old panel\'s cleanup does not unhook the live one', contextTargetOpen() && sendContext() === true && typed.length === 2)
offB()

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
