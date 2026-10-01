// Node-side check of shared/template.ts — «Сохранить как шаблон» and the
// «Новый проект» picker (card H3). No app.
//
// Cost when wrong: a template that drags someone's footage into every new
// project — or one that shares a fragment folder with the project it came from.
// Run: node scripts/check-template.mjs
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
  const src = readFileSync(join(root, 'shared', 'template.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/template.ts loads', false, String(err).split('\n')[0])
}
const { templateOf, projectFromTemplate, templateFileName } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const clip = (id, kind, extra = {}) => ({
  id, kind, start: 0, duration: 2, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false,
  transform: {}, effects: [], ...extra
})
const project = () => ({
  version: 1, id: 'p1', name: 'Vertical', width: 1080, height: 1920, fps: 30000 / 1001,
  background: 'transparent',
  tracks: [
    { id: 't1', kind: 'video', name: 'Captions', muted: false, locked: true, gain: 1, color: 3, clips: [
      clip('c1', 'text', { text: 'Title', textStyle: { size: 80 } }),
      clip('c2', 'remotion', { fragmentId: 'frag-1', fragmentMeta: { id: 'frag-1' } })
    ] },
    { id: 't2', kind: 'video', name: 'V1', muted: false, locked: false, gain: 0.8, clips: [
      clip('c3', 'media', { assetId: 'a1', linkId: 'L' })
    ] },
    { id: 't3', kind: 'audio', name: 'A1', muted: true, locked: false, gain: 1.2, clips: [
      clip('c4', 'media', { assetId: 'a1', linkId: 'L' })
    ] }
  ],
  assets: [{ id: 'a1', path: 'D:/footage/someone.mp4', kind: 'video', waveform: [1, 2, 3] }],
  texts: [{ id: 'x1', name: 'someone.srt', path: 'D:/footage/someone.srt', format: 'srt', assetId: 'a1' }],
  markers: [
    { id: 'm1', time: 3, label: '1' },
    { id: 'm2', time: 0.5, label: '', kind: 'beat', strength: 0.4 },
    { id: 'm3', time: 0, end: 8, label: 'A', kind: 'section' }
  ],
  voiceRuns: [{ assetId: 'a1', runDir: 'D:/runs/1' }],
  defects: [{ id: 'd1', assetId: 'a1', start: 1, end: 2 }],
  claudeChats: ['s1'],
  claudeTranscripts: { s1: '{}' }
})

run('a template drops media clips and keeps structure', () => {
  const src = project()
  const before = JSON.stringify(src)
  const t = templateOf(src)
  check('the source project is untouched', JSON.stringify(src) === before)
  check('settings kept', t.width === 1080 && t.height === 1920 && t.fps === 30000 / 1001 && t.background === 'transparent',
    `${t.width}×${t.height} ${t.fps} ${t.background}`)
  check('every track kept, in order, with its settings',
    t.tracks.map((x) => `${x.kind}:${x.name}:${x.gain}:${x.muted}:${x.locked}`).join(',') ===
      'video:Captions:1:false:true,video:V1:0.8:false:false,audio:A1:1.2:true:false',
    t.tracks.map((x) => `${x.kind}:${x.name}:${x.gain}:${x.muted}:${x.locked}`).join(','))
  check('track colour kept', t.tracks[0].color === 3)
  const clips = t.tracks.flatMap((x) => x.clips)
  check('text clips kept', clips.length === 1 && clips[0].kind === 'text' && clips[0].text === 'Title',
    clips.map((c) => c.kind).join(','))
  check('no media clip, no fragment clip', !clips.some((c) => c.kind !== 'text'))
  check('no assets', Array.isArray(t.assets) && t.assets.length === 0)
  check('no footage path anywhere', !JSON.stringify(t).includes('someone'), JSON.stringify(t).slice(0, 120))
  check('user markers kept, analysis markers dropped',
    (t.markers ?? []).map((m) => m.id).join(',') === 'm1', (t.markers ?? []).map((m) => m.id).join(','))
  for (const k of ['texts', 'voiceRuns', 'defects', 'claudeChats', 'claudeTranscripts']) {
    check(`no ${k}`, !(k in t))
  }
})

run('a project from a template is a new project', () => {
  const t = templateOf(project())
  const a = projectFromTemplate(t)
  const b = projectFromTemplate(t)
  check('a fresh project id each time', a.id !== 'p1' && a.id !== b.id && typeof a.id === 'string' && a.id.length > 4,
    `${a.id} ${b.id}`)
  check('named Untitled', a.name === 'Untitled')
  check('fresh track, clip and marker ids',
    a.tracks.every((x, i) => x.id !== t.tracks[i].id) &&
    a.tracks[0].clips[0].id !== 'c1' && a.markers[0].id !== 'm1')
  check('same structure otherwise', a.tracks.length === 3 && a.width === 1080 && a.tracks[0].clips[0].text === 'Title')
  check('the template is not mutated', t.tracks[0].id === 't1' && t.id === 'p1')
})

run('a template name is a safe file name', () => {
  check('plain name kept', templateFileName('Вертикаль 9:16') === 'Вертикаль 9_16', templateFileName('Вертикаль 9:16'))
  check('no path separators', !/[\\/]/.test(templateFileName('../../evil\\x')), templateFileName('../../evil\\x'))
  check('no leading dots', !templateFileName('..').startsWith('.') && templateFileName('..').length > 0, templateFileName('..'))
  check('blank → a name', templateFileName('   ').length > 0)
  check('not a Windows device name', templateFileName('NUL') !== 'NUL' && templateFileName('com1') !== 'com1')
  check('bounded length', templateFileName('x'.repeat(500)).length <= 80)
})

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
