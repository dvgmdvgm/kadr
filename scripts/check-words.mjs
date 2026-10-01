// Transcript words kept in the project (card I4). No app, no whisper, no tokens.
//  1. docWords: whisper segments → TextDoc.words (continuation tokens glued,
//     the doc's own time base, ms precision).
//  2. placeWords: words map to timeline seconds through clip trim and speed,
//     like defects — every clip showing that part of the file, none for a
//     trimmed-away word, one per linked A/V pair.
//  3. transcribeFlow stores the words on the doc; they survive a save/load.
//  4. kadr_state exposes them by slice (fields:["words"], range, tracks) and
//     keeps them out of `texts`.
// Cost of getting it wrong: text-based edits cutting the wrong place.
// Run: node scripts/check-words.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/words'
      export { placeDefects } from './src/engine/voiceDefects'
      export { sliceState } from './src/engine/agentState'
      export { transcribeFlow } from './src/engine/subtitles'
      export { sanitizeProject, useEditor } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const files = new Map()
globalThis.window = globalThis.window ?? {}
const M = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const near = (a, b) => Math.abs(a - b) < 1e-9

// ── 1. segments → words
const segs = [
  { start: 1, end: 3, text: ' Привет мини-программами', words: [
    { start: 1.0004, end: 1.4, word: ' Привет', probability: 0.9 },
    { start: 1.5, end: 2.0, word: ' мини', probability: 0.8 },
    { start: 2.0, end: 2.6, word: '-программами', probability: 0.6 }
  ] },
  { start: 4, end: 5, text: ' ok', words: [{ start: 4, end: 4.5, word: ' ok', probability: 0.99 }] },
  { start: 6, end: 7, text: ' no words' }
]
const w = M.docWords(segs, 10)
check('docWords: continuation tokens glued, offset applied, ms precision, min probability',
  eq(w, [
    { t0: 11, t1: 11.4, w: 'Привет', p: 0.9 },
    { t0: 11.5, t1: 12.6, w: 'мини-программами', p: 0.6 },
    { t0: 14, t1: 14.5, w: 'ok', p: 0.99 }
  ]), JSON.stringify(w))

// ── 2. placement through trim and speed, like defects
const A = (n) => ({ value: n })
const clip = (id, o) => ({
  id, kind: 'media', assetId: 'voice', muted: false, gain: A(1), fadeIn: 0, fadeOut: 0, effects: [],
  transform: { x: A(0), y: A(0), scale: A(1), rotation: A(0), opacity: A(1) }, ...o
})
const project = {
  id: 'p', name: 'w', width: 1280, height: 720, fps: 30, background: '#000',
  assets: [{ id: 'voice', name: 'voice.wav', path: '/tmp/voice.wav', kind: 'audio', duration: 20, hasAudio: true }],
  tracks: [
    { id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [] },
    { id: 'A1', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [
      // source 2..8 at 2× → project 10..13
      clip('c1', { start: 10, duration: 3, inPoint: 2, speed: 2 }),
      // a second use of the file, source 0..5 at 1× → project 20..25
      clip('c2', { start: 20, duration: 5, inPoint: 0, speed: 1 })
    ] }
  ],
  markers: [],
  texts: [
    { id: 'd1', name: 'voice.srt', path: '/tmp/voice.srt', format: 'srt', assetId: 'voice',
      words: [
        { t0: 1.0, t1: 1.5, w: 'trimmed', p: 0.9 }, // before c1's in-point; inside c2
        { t0: 4.0, t1: 4.5, w: 'both', p: 0.9 },    // in c1 and c2
        { t0: 7.8, t1: 8.4, w: 'edge', p: 0.9 },    // crosses c1's out-point; past c2
        { t0: 15, t1: 15.5, w: 'gone', p: 0.9 }     // in no clip
      ] },
    { id: 'd2', name: 'range.srt', path: '/tmp/range.srt', format: 'srt', offset: 30,
      words: [{ t0: 1, t1: 1.25, w: 'rel', p: 1 }] }
  ]
}
const placed = M.placeWords(project)
const at = (word, clipId) => placed.find((x) => x.w === word && x.clipId === clipId)
check('a word maps through inPoint and speed (source 4.0–4.5 on c1 → 11.0–11.25)',
  at('both', 'c1') && near(at('both', 'c1').t0, 11) && near(at('both', 'c1').t1, 11.25))
check('the same word shows on every clip using that part (c2 → 24.0–24.5)',
  at('both', 'c2') && near(at('both', 'c2').t0, 24) && near(at('both', 'c2').t1, 24.5))
check('a word trimmed away from a clip is not on it', !at('trimmed', 'c1') && !!at('trimmed', 'c2'))
check('a word crossing the out-point is clipped to the clip (source 7.8–8 → 12.9–13.0)',
  at('edge', 'c1') && near(at('edge', 'c1').t0, 12.9) && near(at('edge', 'c1').t1, 13) && !at('edge', 'c2'))
check('a word in no clip is not placed', !placed.some((x) => x.w === 'gone'))
check('a range doc maps by its offset (30 + 1)',
  placed.some((x) => x.w === 'rel' && x.docId === 'd2' && near(x.t0, 31) && near(x.t1, 31.25) && x.clipId === undefined))
// the same numbers placeDefects gives for a defect over the same source span
const asDefects = project.texts[0].words.map((x, i) => ({
  id: 'x' + i, assetId: 'voice', src: [x.t0, x.t1], phrase: { t0: x.t0, t1: x.t1 }, status: 'proposed'
}))
const dp = M.placeDefects(project, asDefects)
const same = dp.every((d) => {
  const x = placed.find((p) => p.clipId === d.clipId && p.w === project.texts[0].words[+d.defect.id.slice(1)].w)
  return x && near(x.t0, d.src.start) && near(x.t1, d.src.end)
}) && dp.length === placed.filter((p) => p.docId === 'd1').length
check('words land exactly where defects over the same source spans land', same, `${dp.length} placements`)
// linked A/V pair of one file: one set of words, not two
const twin = structuredClone(project)
twin.tracks[0].clips.push(clip('v1', { start: 10, duration: 3, inPoint: 2, speed: 2, linkId: 'L' }))
twin.tracks[1].clips[0].linkId = 'L'
const tw = M.placeWords(twin).filter((x) => x.w === 'both')
check('a linked video+audio pair places each word once', tw.length === 2, tw.map((x) => x.clipId).join(','))
// sorted by time
check('placed words come in timeline order', placed.every((x, i) => i === 0 || placed[i - 1].t0 <= x.t0))

// ── 3. transcribeFlow keeps the words; save/load keeps them
M.useEditor.setState({ project: structuredClone({ ...project, texts: [] }) })
globalThis.window.kadr = {
  transcribe: async () => ({ language: 'ru', segments: segs }),
  writeTextFile: async (p, t) => { files.set(p, t) },
  statFile: async (p) => (files.has(p) ? { size: 1 } : null)
}
const r = await M.transcribeFlow({ target: { kind: 'asset', assetId: 'voice' }, model: 'base' })
const docs = M.useEditor.getState().project.texts
const srt = docs.find((d) => d.format === 'srt')
check('after transcription the project holds the words (on the SRT doc)',
  srt && eq(srt.words, M.docWords(segs, 0)) && srt.assetId === 'voice', JSON.stringify(srt?.words?.slice(0, 1)))
check('the TXT twin does not carry a second copy', !docs.find((d) => d.format === 'txt').words)
check('the SRT file is unchanged by the words (cues as before)', files.get(r.srtPath).includes('Привет'))
const range = await M.transcribeFlow({ target: { kind: 'range', start: 10, end: 13 }, model: 'base', timecodes: 'relative' })
check('a relative range doc keeps words in its own cue time', eq(range.doc.words, M.docWords(segs, 0)) && range.doc.offset === 10)
const reloaded = M.sanitizeProject(JSON.parse(JSON.stringify(M.useEditor.getState().project)))
check('words survive save and load', eq(reloaded.texts.find((d) => d.id === srt.id).words, srt.words))

// ── 4. kadr_state by slice
const src = { project, projectPath: null, selection: [], playhead: 0, range: null, exportPresets: [], voiceDefects: [] }
const sum = M.sliceState(src)
check('summary counts the words', sum.counts.words === 5, JSON.stringify(sum.counts))
const tx = M.sliceState(src, { fields: ['texts'] })
check('texts carries a word count, not the words',
  tx.texts.every((d) => !('words' in d)) && tx.texts[0].wordCount === 4, JSON.stringify(tx.texts[0]))
const ws = M.sliceState(src, { fields: ['words'], range: { start: 11, end: 13 } })
check('fields:["words"] + range → the words overlapping it, in project seconds',
  eq(ws.words.map((x) => x.w), ['both', 'edge']) && near(ws.words[0].t0, 11), JSON.stringify(ws.words))
const rel = M.sliceState(src, { fields: ['words'], range: { start: 30, end: 32 } })
check("a range doc's words show in a range slice", eq(rel.words.map((x) => x.w), ['rel']), JSON.stringify(rel.words))
const all = M.sliceState(src, { fields: ['words'] })
check('fields:["words"] alone → every placed word', all.words.length === placed.length)
const onA1 = M.sliceState(src, { tracks: ['A1'], fields: ['words'] })
check('with tracks, only words on those tracks\' clips', onA1.words.length > 0 && onA1.words.every((x) => x.clipId))
const onV1 = M.sliceState(src, { tracks: ['V1'], fields: ['words'] })
check('a track with no clip of the file has no words', onV1.words.length === 0)

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
