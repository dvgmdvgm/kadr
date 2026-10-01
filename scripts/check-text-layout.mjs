// Node-side check of card F2: the text clip's layout. `layoutText` is what
// getTextLayer draws (preview and export share that canvas), measured here
// with a fake monospace measure so the numbers are exact.
//
// Cost of getting it wrong: titles overflowing the frame.
// Run: node scripts/check-text-layout.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export { layoutText, textInk } from './src/engine/text'
      export { defaultTextStyle, sanitizeProject, newProject } from './src/state/store'
      export { fontFromFileName } from './shared/fontName'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { layoutText, textInk, defaultTextStyle, sanitizeProject, newProject, fontFromFileName } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b) => Math.abs(a - b) < 1e-9
// every character 10 px wide; letter spacing is the canvas's job and is
// already inside what measureText returns
const measure = (s) => s.length * 10

const st = (o = {}) => ({ ...defaultTextStyle(), fontSize: 20, ...o })

{
  const L = layoutText('aaa bbb ccc', st({ wrapWidth: 75, lineHeight: 1.5 }), measure)
  check('wrap width and line height produce the expected line breaks and block height',
    JSON.stringify(L.lines) === '["aaa bbb","ccc"]' && near(L.lineH, 30) && near(L.height, 60) && near(L.width, 70), L)
}
{
  const L = layoutText('aaa bbb ccc', st(), measure)
  check('no wrap width: one line, the old 1.25 line height', L.lines.length === 1 && near(L.lineH, 25) && near(L.width, 110), L)
}
{
  const L = layoutText('one\n\ntwo three', st({ wrapWidth: 50 }), measure)
  check('hard breaks and empty lines survive wrapping', JSON.stringify(L.lines) === '["one","","two","three"]', L.lines)
}
{
  const L = layoutText('a verylongword b', st({ wrapWidth: 50 }), measure)
  check('a word wider than the wrap width keeps a line of its own', JSON.stringify(L.lines) === '["a","verylongword","b"]', L.lines)
}
{
  const L = layoutText('aa  bb', st({ wrapWidth: 1000 }), measure)
  check('wrapping never rewrites a line that fits (spaces kept)', L.lines[0] === 'aa  bb', L.lines)
}
{
  // block 100×50 at (10,20); shadow 4 px right, 6 px down, blur 3
  const plain = textInk([10, 20, 110, 70], st())
  const sh = textInk([10, 20, 110, 70], st({ shadowColor: '#000000', shadowX: 4, shadowY: 6, shadowBlur: 3 }))
  check('the drawn box grows by the shadow, and only when there is one',
    JSON.stringify(plain) === '[10,20,110,70]' && JSON.stringify(sh) === '[10,20,117,79]', { plain, sh })
}
{
  const p = newProject()
  const old = { fontFamily: 'Arial', fontSize: 50, color: '#fff', bold: false, italic: false, align: 'left', outlineColor: '#000', outlineWidth: 0, background: '#123456' }
  p.tracks[0].clips.push({ id: 't', kind: 'text', text: 'x', textStyle: { ...old }, start: 0, duration: 1, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false, transform: {}, effects: [] })
  const s = sanitizeProject(p).tracks[0].clips[0].textStyle
  const d = defaultTextStyle()
  check('an old text style gets the new fields at their defaults and keeps its own',
    s.fontFamily === 'Arial' && s.align === 'left' && s.background === '#123456' &&
    s.lineHeight === 1.25 && s.backgroundPad === 0.4 && s.letterSpacing === 0 && s.wrapWidth === 0 &&
    s.shadowColor === '' && d.lineHeight === 1.25, s)
  const bad = { ...old, lineHeight: 'x', wrapWidth: -5, align: 'middle', shadowBlur: NaN }
  p.tracks[0].clips[0].textStyle = bad
  const b = sanitizeProject(p).tracks[0].clips[0].textStyle
  check('junk in a text style falls back to the defaults', b.lineHeight === 1.25 && b.wrapWidth === 0 && b.align === 'center' && b.shadowBlur === 0, b)
}
{
  const r = [fontFromFileName('Inter.woff2'), fontFromFileName('Inter-700.woff2'), fontFromFileName('Inter-400-italic.ttf')]
  check('font file names map to family and descriptors as the fragment runtime does',
    JSON.stringify(r) === JSON.stringify([['Inter', { weight: '100 900' }], ['Inter', { weight: '700' }], ['Inter', { weight: '400', style: 'italic' }]]), r)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
