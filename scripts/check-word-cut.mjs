// The transcript panel's word cut (card I10). No app, no ffmpeg, no tokens: the
// envelope IPC is stood in for by the SAME follower main runs
// (shared/envelope.ts) over synthetic speech whose real word edges are known,
// while the "whisper" words carry edges off by tens of ms, as whisper's are.
//  1. a word deletion cuts inside the surrounding silence, never through a
//     phoneme: deleting two words takes out exactly the span between the
//     middles of the silences around them, on frames, where a cut at the
//     whisper edges would have gone through both neighbouring words;
//  2. ONE undo step, and undo restores the project exactly;
//  3. proposals survive the panel's own cut: inside gone, after moved up;
//  4. a first word (no neighbour) still cuts in the silence before it;
//  5. paragraphs, the word under the playhead, search (ё = е), times.
// Cost of getting it wrong: clipped speech.
// Run: node scripts/check-word-cut.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/transcript'
      export { placeWords } from './src/engine/words'
      export { useSilences, clearSilences } from './src/engine/silences'
      export { EnvelopeFollower } from './shared/envelope'
      export { useEditor, newProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
globalThis.window = globalThis.window ?? {}
const M = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
const { useEditor, newProject } = M

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const FPS = 30
const onFrame = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6

// ── the speech: real word edges (source seconds) and whisper's (off by 40–80 ms)
const REAL = [[0.30, 0.80], [1.10, 1.50], [1.62, 2.20], [2.60, 3.10], [3.40, 4.00]]
const WHISPER = [
  { t0: 0.36, t1: 0.74, w: 'Сегодня', p: 0.9 },
  { t0: 1.14, t1: 1.42, w: 'покажу.', p: 0.9 },
  { t0: 1.66, t1: 2.14, w: 'Ёлку', p: 0.9 }, // starts 40 ms INTO the word: a cut at t0 clips it
  { t0: 2.64, t1: 3.02, w: 'вот', p: 0.4 }, // ends 80 ms before the sound does
  { t0: 3.45, t1: 3.95, w: 'здесь.', p: 0.9 }
]
const speaking = (t) => REAL.some(([a, b]) => t >= a && t < b)
const voice = (t) => (speaking(t) ? 0.5 * Math.sin(2 * Math.PI * 180 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 5 * t)) : 0.0005 * Math.sin(2 * Math.PI * 50 * t))
let envCalls = 0
window.kadr = {
  audioEnvelope: async (req) => {
    envCalls++
    const SR = 48000
    const n = Math.round(req.duration * SR)
    const f = new M.EnvelopeFollower(SR, 2, req.fps, Math.max(1, Math.round(req.duration * req.fps)), { attack: req.attack, release: req.release })
    const buf = new Float32Array(2 * 4800)
    for (let i0 = 0; i0 < n; i0 += 4800) {
      const m = Math.min(4800, n - i0)
      for (let j = 0; j < m; j++) {
        const t = (i0 + j) / SR
        let v = 0
        for (const g of req.audioSegments) {
          const local = t - g.start
          if (local < 0 || local >= g.duration / g.speed) continue
          v += g.gain * voice(g.inPoint + local * g.speed)
        }
        buf[2 * j] = v; buf[2 * j + 1] = v
      }
      f.push(buf.subarray(0, 2 * m))
    }
    return f.result()
  }
}

const tf = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
const mk = (id, assetId, start, duration, extra = {}) => ({
  id, kind: 'media', assetId, start, duration, inPoint: 0, label: id, speed: 1, muted: false,
  gain: { value: 1 }, fadeIn: 0, fadeOut: 0, effects: [], transform: tf, ...extra
})
const tr = (id, kind, clips) => ({ id, kind, name: id, muted: false, locked: false, gain: 1, clips })
const AT = 2 // the clip starts at 2 s: project = source + 2
function fresh() {
  const p = newProject()
  p.fps = FPS
  p.assets = [
    { id: 'av', kind: 'audio', name: 'voice', path: 'voice.wav', duration: 4.5, hasAudio: true },
    { id: 'vv', kind: 'video', name: 'cam', path: 'cam.mp4', duration: 4.5, hasAudio: false, width: 1920, height: 1080 }
  ]
  p.tracks = [
    tr('V1', 'video', [mk('intro', 'vv', 0, AT), mk('cam', 'vv', AT, 4.5, { linkId: 'L' })]),
    tr('A1', 'audio', [mk('voice', 'av', AT, 4.5, { linkId: 'L' })])
  ]
  p.texts = [{ id: 'd1', name: 'voice.srt', kind: 'srt', assetId: 'av', cues: [], words: WHISPER }]
  useEditor.setState({ project: p, past: [], future: [], selection: [], range: null })
  M.clearSilences()
  M.useWordCuts.setState({ marks: [] })
}
const dur = () => Math.max(...s().project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)))
const snap = () => JSON.stringify(s().project)

// ── 1–3. delete «Ёлку вот» (words 2..3)
fresh()
{
  const words = M.placeWords(s().project)
  check('placed: five words, once for the linked pair, at source + 2', words.length === 5 && Math.abs(words[2].t0 - (1.66 + AT)) < 1e-9, words.map((w) => w.t0).join(' '))
  // the naive cut — at whisper's own edges — goes through both words
  check('(the trap) a cut at whisper\'s edges would clip both words',
    speaking(words[2].t0 - AT) && speaking(words[3].t1 - AT))
  M.useSilences.setState({
    items: [
      { id: 'p1', kind: 'silence', start: 2.3 + AT, end: 2.5 + AT, state: 'confirmed' }, // inside the cut: gone
      { id: 'p2', kind: 'silence', start: 4.05 + AT, end: 4.3 + AT, state: 'proposed' }, // after: moved up
      { id: 'r1', kind: 'retake', reason: 'повтор', start: 0.3 + AT, end: 0.8 + AT, state: 'rejected' } // before: kept
    ]
  })
  const before = snap()
  const len0 = dur()
  const r = await M.cutWords(words, 2, 3)
  const src = [r.start - AT, r.end - AT]
  check('a word deletion cuts inside the surrounding silence, never through a phoneme',
    !speaking(src[0]) && !speaking(src[1]) && src[0] > REAL[1][1] && src[0] < REAL[2][0] && src[1] > REAL[3][1] && src[1] < REAL[4][0],
    `cut ${src.map((x) => x.toFixed(3)).join('–')} (source s)`)
  check('…at the middle of each silence (within a frame and the 5 ms envelope)',
    Math.abs(src[0] - (REAL[1][1] + REAL[2][0]) / 2) <= 1 / FPS / 2 + 0.03 && Math.abs(src[1] - (REAL[3][1] + REAL[4][0]) / 2) <= 1 / FPS / 2 + 0.03,
    `${src.map((x) => x.toFixed(3)).join(', ')} vs 1.560, 3.250`)
  check('both edges on frames', onFrame(r.start) && onFrame(r.end))
  check('the timeline lost exactly that span', Math.abs(len0 - dur() - (r.end - r.start)) < 1e-9, `${len0} → ${dur()}`)
  const after = M.placeWords(s().project)
  check('the two words are gone, the rest kept in order',
    after.map((w) => w.w).join(' ') === 'Сегодня покажу. здесь.', after.map((w) => w.w).join(' '))
  check('the next word moved up by the cut', Math.abs(after[2].t0 - (words[4].t0 - (r.end - r.start))) < 1e-9)
  check('ONE undo step', s().past.length === 1, `${s().past.length}`)
  const items = M.useSilences.getState().items
  check('proposals survive the cut: inside gone, before kept, after moved up',
    items.length === 2 && items.some((x) => x.id === 'r1' && x.start === 0.3 + AT) &&
    items.some((x) => x.id === 'p2' && Math.abs(x.start - (4.05 + AT - (r.end - r.start))) < 1e-9),
    JSON.stringify(items.map((x) => [x.id, x.start.toFixed(3)])))
  check('the cut is remembered for the scissors mark', M.useWordCuts.getState().marks.length === 1 && M.useWordCuts.getState().marks[0].at === r.start)
  s().undo()
  check('undo restores the project exactly', snap() === before)
  check('…and any other edit forgets the marks', M.useWordCuts.getState().marks.length === 0)
}

// ── 4. the first word: no neighbour before it
fresh()
{
  const words = M.placeWords(s().project)
  const r = await M.cutWords(words, 0, 0)
  const src = [r.start - AT, r.end - AT]
  check('a first word cuts in the silence before it and after it',
    !speaking(src[0]) && !speaking(src[1]) && src[0] < REAL[0][0] && src[1] > REAL[0][1] && src[1] < REAL[1][0],
    src.map((x) => x.toFixed(3)).join('–'))
}

// ── 4b. no audio heard (a muted clip): the cut falls back to the gap's middle, never throws
fresh()
{
  const p = structuredClone(s().project)
  p.tracks[1].clips[0].muted = true
  useEditor.setState({ project: p })
  const words = M.placeWords(s().project)
  const r = await M.wordCutRange(s().project, words, 1, 1)
  check('nothing audible: gap middles, on frames', Math.abs(r.start - M.placeWords(p)[0].t1 - 0.2) < 0.04 && onFrame(r.start), `${r.start}`)
}

// ── 5. the text helpers
{
  const w = (t0, t1, word, docId = 'a') => ({ t0, t1, w: word, docId })
  const ws = [w(0, 0.4, 'Раз,'), w(0.5, 0.9, 'два.'), w(1.5, 1.8, 'Три'), w(3.0, 3.3, 'четыре'), w(3.4, 3.6, 'пять', 'b')]
  const ps = M.paragraphs(ws)
  check('paragraphs: sentence end + 0.5 s, a pause ≥ 1 s, another doc',
    JSON.stringify(ps.map((p) => [p.a, p.b])) === '[[0,1],[2,2],[3,3],[4,4]]', JSON.stringify(ps.map((p) => [p.a, p.b])))
  check('paragraphs: a comma and 0.1 s do not break', ps[0].b === 1)
  check('nowIndex: inside a word, in the gap after it, before everything, after the last',
    M.nowIndex(ws, 0.2) === 0 && M.nowIndex(ws, 0.45) === 0 && M.nowIndex(ws, -1) === -1 && M.nowIndex(ws, 9) === -1)
  const yo = [w(0, 1, 'Ёлка'), w(1, 2, 'елки,'), w(2, 3, '«ёж»'), w(3, 4, 'поёлка')]
  check('search: prefix, any case, ё = е, quotes ignored, not inside a word',
    JSON.stringify(M.searchHits(yo, 'ел')) === '[0,1]' && JSON.stringify(M.searchHits(yo, 'Еж')) === '[2]' && M.searchHits(yo, ' ').length === 0)
  check('times: m:ss.d, h:mm:ss past an hour', M.fmtT(0.44) === '0:00.4' && M.fmtT(65.35) === '1:05.3' && M.fmtT(3723.9) === '1:02:03')
}
check('the envelope was asked for each side of a cut, not the whole timeline', envCalls >= 4, `${envCalls}`)

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
