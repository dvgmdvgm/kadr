// Auto-ducking (card I7): music under a voice gets gain keyframes that dip
// during speech and recover in the gaps, as ONE undo step, multiplied into the
// gain the music already had. Speech spans come from the voice track's
// loudness envelope — here main's own computeEnvelope over a real ffmpeg
// mixdown — plus transcript words.
//  1. duckCurve: attack before each span, release after, spans whose recovery
//     would be shorter than MIN_UP merged (no pumping).
//  2. autoDuck on a generated voice + music pair: the keys follow the speech
//     spans; one undo step, undone exactly; an existing gain is multiplied.
//  3. the export: the music's per-window loudness dips 12 ± 1 dB in speech
//     and is back within 1 dB in the gaps.
//  4. a 10-minute bed ducked every 4 s mixes in reasonable time (the gain
//     expression is a binary tree of `if`s, not a flat sum).
//  5. kadr_duck refuses bad input before the page.
// Cost of getting it wrong: music drowning the voice, or pumping.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-duck.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stubElectron = {
  name: 'stub-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const ipcMain = {}', loader: 'js' }))
  }
}
const out = (await build({
  stdin: {
    contents: `export * from './src/engine/duck'
      export * as agentEdit from './src/engine/agentEdits'
      export { useEditor, newProject } from './src/state/store'
      export { evalAnim } from './src/engine/anim'
      export { collectRangeAudio } from './src/engine/subtitles'
      export { computeEnvelope } from './electron/envelope'
      export { mixdownWav, FFMPEG } from './electron/ffmpeg'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error', plugins: [stubElectron],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
})).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
globalThis.window = globalThis.window ?? {}
const M = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))
const { useEditor, newProject, agentEdit, evalAnim, collectRangeAudio, mixdownWav, FFMPEG } = M
window.kadr = { audioEnvelope: (req) => M.computeEnvelope(req) }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e
const G = Math.pow(10, -12 / 20)

// ── 1. the curve
{
  const c = M.duckCurve([[8, 10], [2, 5]], { depthDb: -12, attack: 0.3, release: 0.5 })
  const want = [[1.7, 1], [2, G], [5, G], [5.5, 1], [7.7, 1], [8, G], [10, G], [10.5, 1]]
  check('ducking keys follow speech spans with attack and release',
    c.length === want.length && c.every((p, i) => near(p.t, want[i][0], 1e-9) && near(p.v, want[i][1], 1e-9)),
    JSON.stringify(c.map((p) => [p.t, +p.v.toFixed(3)])))
  const m = M.duckCurve([[2, 5], [5.9, 7]], { attack: 0.3, release: 0.5 })
  check('a recovery shorter than MIN_UP stays down (no pumping)', m.length === 4 && near(m[2].t, 7, 1e-9), JSON.stringify(m.map((p) => p.t)))
  check('no speech → no curve', M.duckCurve([], {}).length === 0)
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-duck-'))
try {
  // ── generated pair: speech in 1–4 and 7–10 s, pink-noise music
  const voice = join(dir, 'voice.wav'), music = join(dir, 'music.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*4*t))*(between(t,1,4)+between(t,7,10))':d=12:s=48000", '-ac', '2', voice])
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:a=0.2:seed=3', '-ac', '2', '-ar', '48000', music])
  const tf = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
  const clip = (id, assetId, gain) => ({ id, kind: 'media', assetId, start: 0, duration: 12, inPoint: 0, speed: 1, transform: tf, gain })
  const load = (musicGain) => {
    const p = newProject()
    p.fps = 30
    p.assets = [{ id: 'av', kind: 'audio', name: 'voice', path: voice, duration: 12, hasAudio: true },
      { id: 'am', kind: 'audio', name: 'music', path: music, duration: 12, hasAudio: true }]
    p.tracks = [{ id: 'A1', name: 'A1', kind: 'audio', gain: 1, clips: [clip('v', 'av', { value: 1 })] },
      { id: 'A2', name: 'A2', kind: 'audio', gain: 1, clips: [clip('m', 'am', musicGain)] }]
    useEditor.setState({ project: p, past: [], future: [], selection: [] })
  }
  const gainOf = () => s().project.tracks[1].clips[0].gain

  // ── 2. keys on the music
  load({ value: 1 })
  const before = JSON.stringify(s().project)
  const r = await M.autoDuck({ musicClipIds: ['m'] })
  const g = gainOf()
  check('speech found on the other track', r.speech.length === 2 && near(r.speech[0][0], 1) && near(r.speech[0][1], 4) && near(r.speech[1][0], 7) && near(r.speech[1][1], 10),
    JSON.stringify(r.speech))
  check('music is at −12 dB in speech', [1.1, 2.5, 3.9, 7.5, 9.9].every((t) => near(evalAnim(g, t), G, 0.01)))
  check('music is back at 1 in the gaps', [0.5, 5, 6.5, 11].every((t) => near(evalAnim(g, t), 1, 0.01)))
  check('attack ramps before speech, release after', near(evalAnim(g, 0.85), (1 + G) / 2, 0.03) && near(evalAnim(g, 4.25), (1 + G) / 2, 0.03),
    `${evalAnim(g, 0.85).toFixed(3)} ${evalAnim(g, 4.25).toFixed(3)}`)
  check('one undo step', s().past.length === 1 && s().past[0].label === 'hDuck', s().past.map((e) => e.label).join())
  s().undo()
  check('undo restores the project exactly', JSON.stringify(s().project) === before)

  // an existing gain is multiplied, not overwritten
  load({ value: 0.5 })
  await M.autoDuck({ musicClipIds: ['m'] })
  check('a static gain is multiplied', near(evalAnim(gainOf(), 2.5), 0.5 * G, 0.005) && near(evalAnim(gainOf(), 5.5), 0.5, 0.005))
  load({ value: 1, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 12, value: 1, easing: 'linear' }] })
  await M.autoDuck({ musicClipIds: ['m'] })
  check('a keyframed gain is multiplied', near(evalAnim(gainOf(), 2.5), (2.5 / 12) * G, 0.005) && near(evalAnim(gainOf(), 5.5), 5.5 / 12, 0.005),
    `${evalAnim(gainOf(), 2.5).toFixed(4)} ${evalAnim(gainOf(), 5.5).toFixed(4)}`)

  // nothing to duck under: an error, and no undo step
  load({ value: 1 })
  s().updateClip('v', { muted: true })
  let err = ''
  try { await M.autoDuck({ musicClipIds: ['m'] }) } catch (e) { err = e.message }
  check('no speech → an error and no undo step', /speech/.test(err) && s().past.length === 0, err)

  // ── 3. the export: per-window loudness of the music alone
  load({ value: 1 })
  const pcmOf = (file) => {
    const buf = readFileSync(file)
    const at = buf.indexOf('data') + 8
    return new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
  }
  const rms = (pcm, a, b) => {
    let q = 0, n = 0
    for (let i = Math.round(a * 48000) * 2; i < Math.round(b * 48000) * 2 && i < pcm.length; i++, n++) q += (pcm[i] / 32768) ** 2
    return Math.sqrt(q / Math.max(1, n))
  }
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9))
  const mix = async (name) => {
    const f = join(dir, name)
    await mixdownWav(collectRangeAudio(s().project, 0, 12, { clipIds: ['m'] }), 12, f)
    return pcmOf(f)
  }
  const ref = await mix('ref.wav')
  await M.autoDuck({ musicClipIds: ['m'] })
  const got = await mix('ducked.wav')
  const dips = [[1.2, 1.7], [2, 2.5], [3, 3.5], [7.2, 7.7], [8.5, 9], [9.4, 9.9]].map(([a, b]) => db(rms(got, a, b)) - db(rms(ref, a, b)))
  const ups = [[0, 0.5], [4.8, 5.3], [5.8, 6.3], [11, 11.5]].map(([a, b]) => db(rms(got, a, b)) - db(rms(ref, a, b)))
  check('exported music dips 12 ± 1 dB during speech', dips.every((d) => Math.abs(d + 12) <= 1), dips.map((d) => d.toFixed(2)).join(' '))
  check('exported music recovers within 1 dB in the gaps', ups.every((d) => Math.abs(d) <= 1), ups.map((d) => d.toFixed(2)).join(' '))

  // ── 4. a 10-minute bed ducked every 4 s
  {
    const LEN = 600
    const bed = join(dir, 'bed.wav')
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=${LEN}:c=pink:a=0.2`, '-ac', '2', '-ar', '48000', bed])
    const spans = []
    for (let t = 1; t < LEN - 3; t += 4) spans.push([t, t + 2.5])
    const curve = M.duckCurve(spans, {})
    const p = { assets: [{ id: 'b', kind: 'audio', path: bed, duration: LEN, hasAudio: true }],
      tracks: [{ id: 't', kind: 'audio', gain: 1, clips: [{ id: 'c', kind: 'media', assetId: 'b', start: 0, duration: LEN, inPoint: 0, speed: 1, gain: M.duckGain({ value: 1 }, 0, LEN, curve) }] }] }
    const t0 = Date.now()
    await mixdownWav(collectRangeAudio(p, 0, LEN), LEN, join(dir, 'bedmix.wav'))
    const sec = (Date.now() - t0) / 1000
    check(`a 10-minute bed with ${curve.length} keys mixes in under 3 s`, sec < 3, `${sec.toFixed(1)} s`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── 5. kadr_duck input
{
  const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron/mcp-edit-tools.cjs'))
  const tool = TOOLS.find((x) => x.name === 'kadr_duck')
  check('kadr_duck is registered as a long helper', !!tool && tool.helper === true && tool.ms >= 60_000)
  if (tool) {
    let reached = 0
    const ev = async () => { reached++; return {} }
    for (const bad of [{}, { musicClipIds: [] }, { musicClipIds: ['m'], depthDb: 3 }, { musicClipIds: ['m'], attack: -1 },
      { musicClipIds: ['m'], speechTrackIds: ['A1'], speechClipIds: ['v'] }, { musicClipIds: ['m'], foo: 1 }]) {
      try { await runTool(tool, bad, ev) } catch { /* refused */ }
    }
    check('kadr_duck refuses bad input before the page', reached === 0, `${reached} reached`)
    await runTool(tool, { musicClipIds: ['m'], speechTrackIds: ['A1'] }, ev)
    check('kadr_duck passes good input', reached === 1)
  }
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
