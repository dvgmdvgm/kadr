// Silence removal (card I5). No app, no ffmpeg, no tokens: the envelope IPC is
// stood in for by the SAME follower main runs (shared/envelope.ts) over
// synthetic PCM, so the thresholds meet a real envelope shape.
//  1. silenceSpans: quiet runs of the envelope ≥ minSilence, shrunk by pad,
//     transcript words keep their speech.
//  2. findSilences on a speech clip with three 2 s gaps: three proposals at
//     the gaps, on frames; the voice track alone when music plays over it.
//  3. applying them shortens the timeline by 6 − 2·pad·3 as ONE undo step,
//     and that undo restores the project exactly.
//  4. kadr_silences: invalid input never reaches the page; apply is one step.
// Cost of getting it wrong: words clipped at cut points.
// Run: node scripts/check-silences.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: `export * from './src/engine/silences'
      export * as agentEdit from './src/engine/agentEdits'
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
const { useEditor, newProject, agentEdit } = M

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const FPS = 30
const onFrame = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6

// ── synthetic sources, by path: speech with gaps at 2–4, 6–8, 10–12 (source s)
const GAPS = [[2, 4], [6, 8], [10, 12]]
const speaking = (t) => t < 14 && !GAPS.some(([a, b]) => t >= a && t < b)
const SOURCES = {
  'voice.wav': (t) => (speaking(t) ? 0.5 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0.0005 * Math.sin(2 * Math.PI * 50 * t)),
  'music.wav': (t) => 0.3 * Math.sin(2 * Math.PI * 440 * t)
}
let envCalls = []
// the envelope IPC: mix the segments to 48 kHz stereo, run main's follower
window.kadr = {
  audioEnvelope: async (req) => {
    envCalls.push(req)
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
          v += g.gain * SOURCES[g.path](g.inPoint + local * g.speed)
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
function fresh({ music = false, words } = {}) {
  const p = newProject()
  p.fps = FPS
  p.assets = [
    { id: 'av', kind: 'audio', name: 'voice', path: 'voice.wav', duration: 14, hasAudio: true },
    { id: 'am', kind: 'audio', name: 'music', path: 'music.wav', duration: 60, hasAudio: true },
    { id: 'vv', kind: 'video', name: 'cam', path: 'cam.mp4', duration: 14, hasAudio: false, width: 1920, height: 1080 }
  ]
  p.tracks = [
    tr('V1', 'video', [mk('cam', 'vv', 0, 14, { linkId: 'L' })]),
    tr('A1', 'audio', [mk('voice', 'av', 0, 14, { linkId: 'L' })]),
    tr('A2', 'audio', music ? [mk('music', 'am', 0, 14)] : [])
  ]
  if (words) p.texts = [{ id: 'd1', name: 'voice.srt', kind: 'srt', assetId: 'av', cues: [], words }]
  useEditor.setState({ project: p, past: [], future: [], selection: [], range: null })
  M.clearSilences()
}
const dur = () => Math.max(...s().project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)))
const snap = () => JSON.stringify(s().project)
const near = (a, b, tol = 1 / FPS + 1e-9) => Math.abs(a - b) <= tol

// ── 1. the pure span finder
{
  const fps = 100
  const env = Array.from({ length: 1400 }, (_, k) => (speaking(k / fps) ? 1 : 0.001))
  const sp = M.silenceSpans(env, fps, { thresholdDb: -35, minSilence: 0.5, pad: 0.1 })
  check('silenceSpans: three gaps, each shrunk by pad on both sides',
    sp.length === 3 && sp.every(([a, b], i) => near(a, GAPS[i][0] + 0.1, 0.011) && near(b, GAPS[i][1] - 0.1, 0.011)), JSON.stringify(sp))
  const short = M.silenceSpans(env, fps, { thresholdDb: -35, minSilence: 2.5, pad: 0 })
  check('silenceSpans: runs shorter than minSilence stay', short.length === 0, JSON.stringify(short))
  const withWord = M.silenceSpans(env, fps, { thresholdDb: -35, minSilence: 0.5, pad: 0.1 }, [[6.9, 7.1]])
  check('silenceSpans: a transcript word inside a quiet run keeps its speech (two spans around it)',
    withWord.length === 4 && near(withWord[1][1], 6.8, 0.011) && near(withWord[2][0], 7.2, 0.011), JSON.stringify(withWord))
  const flat = M.silenceSpans(new Array(300).fill(0), fps, { thresholdDb: -35, minSilence: 0.5, pad: 0.1 })
  check('silenceSpans: an all-silent range is one span, no NaN', flat.length === 1 && near(flat[0][0], 0.1, 0.011), JSON.stringify(flat))
}

// ── 2. findSilences on the project
fresh()
{
  const found = await M.findSilences({ pad: 0.1 })
  check('findSilences: three proposals at the gaps (within a frame)',
    found.length === 3 && found.every((x, i) => near(x.start, GAPS[i][0] + 0.1) && near(x.end, GAPS[i][1] - 0.1)),
    JSON.stringify(found.map((x) => [x.start, x.end])))
  check('findSilences: every edge on a frame', found.every((x) => onFrame(x.start) && onFrame(x.end)))
  check('findSilences: the proposals are shown (the timeline store holds them)', M.useSilences.getState().items.length === 3)
  check('findSilences: finding is no edit (no undo step)', s().past.length === 0)
}
fresh({ music: true })
{
  const mix = await M.findSilences({ pad: 0.1 })
  check('music under speech hides the silences from the mix', mix.length === 0, `${mix.length}`)
  const voice = await M.findSilences({ pad: 0.1, trackIds: ['A1'] })
  check('…the voice track alone finds all three', voice.length === 3, `${voice.length}`)
  envCalls = []
  const byClip = await M.findSilences({ pad: 0.1, clipId: 'cam' })
  check('clipId: a video clip is heard through its linked audio twin',
    byClip.length === 3 && envCalls[0].audioSegments.length === 1 && envCalls[0].audioSegments[0].path === 'voice.wav',
    `${byClip.length} / ${JSON.stringify(envCalls[0]?.audioSegments.map((g) => g.path))}`)
}
fresh({ words: [{ t0: 6.9, t1: 7.1, w: 'hm', p: 0.9 }] })
{
  const found = await M.findSilences({ pad: 0.1 })
  check('findSilences: a transcript word in a quiet gap is kept', found.length === 4 &&
    found.every((x) => x.end <= 6.9 - 0.1 + 1e-6 || x.start >= 7.1 + 0.1 - 1e-6), JSON.stringify(found.map((x) => [x.start, x.end])))
}

// ── 3. applying: one undo step
fresh()
{
  await M.findSilences({ pad: 0.1 })
  const before = snap()
  const d0 = dur()
  const ids = M.useSilences.getState().items.map((x) => x.id)
  M.setSilenceState(ids[0], 'confirmed')
  M.setSilenceState(ids[2], 'confirmed')
  M.setSilenceState(ids[1], 'rejected')
  check('confirming/rejecting is no edit', s().past.length === 0 && snap() === before)
  M.setSilenceState(ids[1], 'confirmed')
  const r = M.applySilences('confirmed')
  check('applying three removes 6 − 2·pad·3 = 5.4 s', near(d0 - dur(), 5.4, 1e-6), `${d0 - dur()}`)
  check('…as ONE undo step', s().past.length === 1 && r.length === 3, `${s().past.length}`)
  check('…every clip still on a frame, the twins cut alike', s().project.tracks.every((t) => t.clips.every((c) => onFrame(c.start) && onFrame(c.duration))) &&
    JSON.stringify(s().project.tracks[0].clips.map((c) => [c.start, c.duration])) === JSON.stringify(s().project.tracks[1].clips.map((c) => [c.start, c.duration])))
  check('…the proposals are gone', M.useSilences.getState().items.length === 0)
  s().undo()
  check('one undo restores the project exactly', snap() === before)
}
fresh()
{
  await M.findSilences({ pad: 0.1 })
  s().pushHistory('hMove'); s().setClipStarts([{ id: 'voice', start: 1 }])
  check('an edit of the tracks drops stale proposals', M.useSilences.getState().items.length === 0)
}

// ── 4. the MCP tool
const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron', 'mcp-edit-tools.cjs'))
globalThis.window.kadrEditor = { agentEdit, useEditor }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
let pageCalls = 0
const editorEval = async (code) => { pageCalls++; return new AsyncFunction(code)() }
const tool = TOOLS.find((t) => t.name === 'kadr_silences')
check('kadr_silences is in the tool table, page code in agentEdit', !!tool && typeof agentEdit[tool.fn] === 'function')
if (tool) {
  fresh()
  const found = await runTool(tool, { pad: 0.1 }, editorEval)
  check('kadr_silences finds: three proposals with ids, no undo step',
    found.proposals?.length === 3 && found.proposals.every((x) => x.id && onFrame(x.start)) && s().past.length === 0, JSON.stringify(found))
  const before = snap()
  const ap = await runTool(tool, { apply: [found.proposals[0].id, found.proposals[2].id] }, editorEval)
  check('kadr_silences apply by ids: those two, one undo step', ap.removed?.length === 2 && s().past.length === 1 && near(14 - dur(), 3.6, 1e-6), JSON.stringify(ap))
  s().undo()
  check('…undone in one', snap() === before)
  let err
  try { await runTool(tool, { apply: 'confirmed' }, editorEval) } catch (e) { err = e }
  check('kadr_silences apply with nothing confirmed: an error, no step', /nothing/.test(err?.message) && s().past.length === 0, err?.message)
  const bad = [{ thresholdDb: 3 }, { minSilence: 0 }, { pad: -1 }, { start: 5, end: 2 }, { start: 1 }, { clipId: 'x', start: 0, end: 1 },
    { apply: 'some' }, { apply: [] }, { apply: 'all', pad: 0.1 }, { what: 1 }]
  for (const args of bad) {
    pageCalls = 0
    let e2
    try { await runTool(tool, args, editorEval) } catch (e) { e2 = e }
    check(`kadr_silences rejects ${JSON.stringify(args)} before the page`, !!e2 && pageCalls === 0, e2?.message)
  }
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
