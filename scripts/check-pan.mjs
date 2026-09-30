// K4: pan and the master fader. `shared/pan.ts` holds the pan law — the Web
// Audio StereoPannerNode's own stereo algorithm (an equal-power balance) — and
// the ffmpeg filters that replay it in the mix. This runs the REAL
// StereoPannerNode (OfflineAudioContext in a hidden Electron window, set up
// with the preview's PANNER_OPTIONS) and the REAL export chain (ExportMuxer)
// on the same stereo noise, and compares both with the law sample for sample:
// a static pan, a keyframed one, a mono source (upmixed first, then panned),
// hard left leaving R silent; then the master fader: −6 dB lowers the export
// by 6 ± 0.1 dB. Cost of a regression: a stereo image that moves on export.
// Needs ffmpeg (PATH or KADR_FFMPEG) and the installed electron.
// Run: node scripts/check-pan.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const alias = { '@shared': join(root, 'shared'), '@': join(root, 'src') }
const bundle = (contents, platform) => buildSync({
  stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform,
  format: platform === 'node' ? 'esm' : 'iife', write: false, logLevel: 'error', alias
}).outputFiles[0].text
const load = (contents) => import('data:text/javascript;base64,' + Buffer.from(bundle(contents, 'node')).toString('base64'))
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const P = await load(`export * from './shared/pan'`)
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
const { panAt } = await load(`export { panAt } from './src/engine/player'`)
const { ExportMuxer, FFMPEG } = await load(`export { ExportMuxer, FFMPEG } from './electron/ffmpeg'`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))
const SR = 48000
/** interleaved stereo f32 of a WAV ffmpeg wrote (pcm_f32le) */
const f32Of = (file) => {
  const buf = readFileSync(file)
  const at = buf.indexOf('data') + 8
  const n = Math.floor((buf.length - at) / 4)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(at + i * 4)
  return out
}
const chRms = (pcm, ch, a = 0, b = Infinity) => {
  let s = 0, n = 0
  for (let i = a * 2 + ch; i < Math.min(pcm.length, b * 2); i += 2, n++) s += pcm[i] ** 2
  return Math.sqrt(s / Math.max(1, n))
}
/** the law applied to an input frame: [outL, outR] */
const law = (p, l, r) => { const [ll, rl, lr, rr] = P.panMatrix(p); return [ll * l + rl * r, lr * l + rr * r] }

// ---- pure: the law and the model ------------------------------------------------
{
  const eq = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12)
  check('centre passes stereo through untouched', eq(P.panMatrix(0), [1, 0, 0, 1]))
  check('hard left: everything in L, R silent', eq(P.panMatrix(-1), [1, 1, 0, 0]))
  check('hard right: everything in R, L silent', eq(P.panMatrix(1), [0, 0, 1, 1]))
  check('out of range and junk clamp / centre', eq(P.panMatrix(-7), P.panMatrix(-1)) && eq(P.panMatrix(NaN), P.panMatrix(0)))
  // equal power: a centred mono signal (L = R) panned keeps L² + R² at every position between the edges
  let worst = 0
  for (let p = -1; p <= 1; p += 0.05) { const [L, R] = law(p, 1, 0); worst = Math.max(worst, Math.abs(L * L + R * R - 1)) }
  check('equal power: one channel\'s energy is kept wherever it is panned', worst < 1e-9, `worst ${worst.toExponential(1)}`)

  const assets = [{ id: 'A', kind: 'audio', path: 'a.wav', duration: 10, hasAudio: true }]
  const clip = (extra) => ({ id: 'c', kind: 'media', assetId: 'A', start: 2, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false, ...extra })
  const proj = (c, tr = {}) => ({ assets, tracks: [{ id: 't', kind: 'audio', gain: 1, muted: false, clips: [c], ...tr }] })
  const [s0] = collectRangeAudio(proj(clip({})), 0, 10)
  check('no pan anywhere: the segment carries none (the mix is what it was)', s0 && s0.pan === undefined && s0.panKeys === undefined, JSON.stringify(s0))
  const [s1] = collectRangeAudio(proj(clip({ pan: { value: 0.5 } }), { pan: { value: 0.75 } }), 0, 10)
  check('clip pan + track pan, clamped to hard right', s1.pan === 1, String(s1.pan))
  const [s2] = collectRangeAudio(proj(clip({ pan: { value: -0.25 } }), { pan: { value: -0.25 } }), 0, 10)
  check('clip pan + track pan add up', s2.pan === -0.5 && !s2.panKeys, String(s2.pan))
  // keys: the clip's are clip-local, the track's in project time
  const ck = clip({ pan: { value: 0, keyframes: [{ time: 0, value: -1, easing: 'linear' }, { time: 4, value: 1, easing: 'linear' }] } })
  const [s3] = collectRangeAudio(proj(ck), 0, 10)
  const at = (keys, t) => { for (let i = 0; i < keys.length - 1; i++) if (t <= keys[i + 1].t) return keys[i].v + (keys[i + 1].v - keys[i].v) * (t - keys[i].t) / Math.max(1e-12, keys[i + 1].t - keys[i].t); return keys[keys.length - 1].v }
  check('a keyframed clip pan becomes keys at segment-local times', !!s3.panKeys && Math.abs(at(s3.panKeys, 1) + 0.5) < 1e-9 && Math.abs(at(s3.panKeys, 3) - 0.5) < 1e-9, JSON.stringify(s3.panKeys))
  const tk = { pan: { value: 0, keyframes: [{ time: 2, value: 0, easing: 'linear' }, { time: 6, value: 1, easing: 'linear' }] } }
  const [s4] = collectRangeAudio(proj(clip({ pan: { value: -0.5 } }), tk), 0, 10)
  check('a keyframed track pan is read in project time and added', !!s4.panKeys && Math.abs(at(s4.panKeys, 0) + 0.5) < 1e-9 && Math.abs(at(s4.panKeys, 4) - 0.5) < 1e-9, JSON.stringify(s4.panKeys))
  check('the preview reads the same sum (panAt)', Math.abs(panAt(clip({ pan: { value: -0.5 } }), { ...tk }, 4) - 0) < 1e-9 && panAt(clip({ pan: { value: 0.8 } }), { pan: { value: 0.8 } }, 3) === 1)
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-pan-'))
try {
  // stereo noise with uncorrelated channels, and a mono tone, as float WAVs
  const noise = join(dir, 'noise.wav'), mono = join(dir, 'mono.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=3:c=white:a=0.25:seed=5:r=48000', '-f', 'lavfi', '-i', 'anoisesrc=d=3:c=white:a=0.25:seed=9:r=48000',
    '-filter_complex', '[0][1]join=inputs=2:channel_layout=stereo', '-c:a', 'pcm_f32le', noise])
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=3:r=48000,volume=0.5', '-ac', '1', '-c:a', 'pcm_f32le', mono])
  const src = f32Of(noise), srcMono = f32Of(mono)

  const mix = async (segs, dur, name, job = {}) => {
    const out = join(dir, name)
    await new ExportMuxer().run({
      projectName: 'pan', outputPath: out, width: 0, height: 0, fps: 0, duration: dur, audioSegments: segs, master: false,
      preset: { id: 'wav', name: 'wav', container: 'mp4', codec: '', ffmpegVideo: '', width: 0, height: 0, fps: 0, videoBitrate: 0,
        audioCodec: 'pcm_f32le', audioBitrate: '256k', audioOnly: true },
      ...job
    }, '', () => {})
    return f32Of(out)
  }
  const seg = (extra) => ({ path: noise, inPoint: 0, duration: 2, start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0, ...extra })
    /** `upmix`: a mono input, and the level each side upmixes it to stereo at */
  const worstVsLaw = (pcm, input, pOf, upmix = 0) => {
    let worst = 0
    for (let i = 0; i < 2 * SR - 1; i++) {
      const l = upmix ? input[i] * upmix : input[i * 2], r = upmix ? input[i] * upmix : input[i * 2 + 1]
      const [L, R] = law(pOf(i / SR), l, r)
      worst = Math.max(worst, Math.abs(pcm[i * 2] - L), Math.abs(pcm[i * 2 + 1] - R))
    }
    return worst
  }

  // ---- the export: every pan position, a keyframed sweep, a mono source ------------
  const PANS = [-1, -0.5, 0.3, 1]
  const exp = {}
  for (const p of PANS) {
    const pcm = await mix([seg({ pan: p })], 2, `p${p}.wav`)
    exp[p] = pcm
    const w = worstVsLaw(pcm, src, () => p)
    check(`the export follows the pan law — pan ${p}`, w < 1e-5, `worst ${w.toExponential(1)}`)
  }
  check('hard left in the export: the signal in L only, −∞ in R', chRms(exp[-1], 1) === 0 && chRms(exp[-1], 0) > 0.1, `R ${db(chRms(exp[-1], 1)).toFixed(1)} dB, L ${db(chRms(exp[-1], 0)).toFixed(1)} dB`)
  const sweep = [{ t: 0, v: -1 }, { t: 2, v: 1 }]
  {
    const pcm = await mix([seg({ panKeys: sweep })], 2, 'sweep.wav')
    const w = worstVsLaw(pcm, src, (t) => -1 + t)
    check('the export follows a keyframed pan sample by sample (−1 → +1 over 2 s)', w < 1e-5, `worst ${w.toExponential(1)}`)
  }
  {
    const pcm = await mix([seg({ path: mono, pan: -0.5 })], 2, 'pmono.wav')
    const w = worstVsLaw(pcm, srcMono, () => -0.5, P.MONO_UPMIX)
    check('a mono source is upmixed first (ffmpeg: −3 dB a side), then panned', w < 1e-5, `worst ${w.toExponential(1)}`)
  }

  // ---- the preview: the real StereoPannerNode, set up as src/engine/audio.ts does ----
  const page = bundle(`
import { PANNER_OPTIONS } from './shared/pan'
const N = ${2 * SR}
const run = async (chans, pan, keys) => {
  const ctx = new OfflineAudioContext(2, N, ${SR})
  const buf = ctx.createBuffer(chans.length, N, ${SR})
  chans.forEach((c, i) => buf.copyToChannel(Float32Array.from(c), i))
  const s = new AudioBufferSourceNode(ctx, { buffer: buf })
  const p = new StereoPannerNode(ctx, PANNER_OPTIONS)
  if (keys) { p.pan.setValueAtTime(keys[0].v, 0); p.pan.linearRampToValueAtTime(keys[1].v, keys[1].t) } else p.pan.value = pan
  s.connect(p).connect(ctx.destination); s.start()
  const r = await ctx.startRendering()
  return [Array.from(r.getChannelData(0)), Array.from(r.getChannelData(1))]
}
;(async () => {
  const { L, R, M, PANS, sweep } = window.INPUT
  const res = {}
  for (const p of PANS) res[p] = await run([L, R], p)
  res.sweep = await run([L, R], 0, sweep)
  res.mono = await run([M], -0.5)
  console.log('RESULT ' + JSON.stringify(res))
})()
`, 'browser')
  const L = [], R = [], M = []
  for (let i = 0; i < 2 * SR; i++) { L.push(src[i * 2]); R.push(src[i * 2 + 1]); M.push(srcMono[i]) }
  writeFileSync(join(dir, 'input.js'), 'window.INPUT = ' + JSON.stringify({ L, R, M, PANS, sweep }))
  writeFileSync(join(dir, 'page.js'), page)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="input.js"></script><script src="page.js"></script>')
  writeFileSync(join(dir, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  const done = (code) => { app.exit(code) }
  w.webContents.on('console-message', (...a) => { const m = typeof a[0] === 'object' && a[0].message !== undefined ? a[0].message : a[2]
    if (String(m).startsWith('RESULT ')) { require('fs').writeFileSync(${JSON.stringify(join(dir, 'result.json'))}, String(m).slice(7)); done(0) } else process.stderr.write('page: ' + m + '\\n') })
  w.webContents.on('render-process-gone', () => done(2))
  w.loadFile(${JSON.stringify(join(dir, 'index.html'))})
  setTimeout(() => { process.stderr.write('timeout\\n'); done(3) }, 60000)
})`)
  const exe = createRequire(import.meta.url)('electron')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(exe, [join(dir, 'main.cjs')], { encoding: 'utf8', env, timeout: 90000 })
  let res = null
  try { res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) } catch { /* reported below */ }
  if (!res) {
    check('the StereoPannerNode ran in Electron', false, `exit ${r.status}: ${(r.stderr || '').slice(-600)}`)
  } else {
    const inter = ([a, b]) => { const o = new Float32Array(a.length * 2); for (let i = 0; i < a.length; i++) { o[i * 2] = a[i]; o[i * 2 + 1] = b[i] } return o }
    const vsExport = (a, b) => { let w = 0; for (let i = 0; i < 2 * SR * 2 - 2; i++) w = Math.max(w, Math.abs(a[i] - b[i])); return w }
    for (const p of PANS) {
      const pv = inter(res[p])
      const w = worstVsLaw(pv, src, () => p)
      check(`preview and export use the same pan law — pan ${p}`, w < 1e-5 && vsExport(pv, exp[p]) < 1e-5, `preview vs law ${w.toExponential(1)}, vs export ${vsExport(pv, exp[p]).toExponential(1)}`)
    }
    const pl = inter(res[-1])
    check('hard left in the preview: −∞ in R', chRms(pl, 1) === 0, `R ${db(chRms(pl, 1)).toFixed(1)} dB`)
    // WebAudio ramps per render quantum at a-rate, so allow the step between two samples of the sweep
    const ws = worstVsLaw(inter(res.sweep), src, (t) => -1 + t)
    check('preview and export use the same pan law — keyframed sweep', ws < 1e-3, `preview vs law ${ws.toExponential(1)}`)
    // the law is the same; the UPMIX is not — WebAudio copies mono at unity where
    // ffmpeg puts it at −3 dB a side. Older than K4 (a mono clip at centre shows it),
    // not fixed here: neither side knows a source's channel count (journal, K4 finding)
    const wm = worstVsLaw(inter(res.mono), srcMono, () => -0.5, 1)
    check('preview and export use the same pan law — a mono source (upmix, then pan)', wm < 1e-5, `preview vs law ${wm.toExponential(1)}; KNOWN: preview upmixes mono 3.01 dB above the export`)
  }

  // ---- the master fader ------------------------------------------------------------
  const quiet = [seg({ gain: 0.25 })] // under the limiter: the master stage is otherwise transparent
  const m0 = await mix(quiet, 2, 'm0.wav', { master: undefined })
  const m6 = await mix(quiet, 2, 'm6.wav', { master: undefined, masterGain: 10 ** (-6 / 20) })
  const d = db(chRms(m6, 0, SR / 2, SR * 3 / 2)) - db(chRms(m0, 0, SR / 2, SR * 3 / 2))
  check('master −6 dB lowers the export by 6 ± 0.1 dB', Math.abs(d + 6) <= 0.1, `${d.toFixed(3)} dB`)
  const ma = await mix(quiet, 2, 'ma.wav', { masterGain: 0.5 })
  check('an analysis mixdown (master: false) ignores the fader', Math.abs(db(chRms(ma, 0)) - db(chRms(await mix(quiet, 2, 'mb.wav'), 0))) < 1e-6)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
