// K9: audio effects with parity. One DSP (shared/audioFx.ts) runs in the
// preview's AudioWorklet and in main's export path, so:
//   1. the REAL worklet processor (`kadr-fx`, fed 128-frame render quanta) and
//      the export's form (`fxInterleaved`, one buffer) give the same samples
//      within −60 dB — EQ, compressor, de-esser, and a slider moved mid-stream;
//   2. the EQ's RBJ biquads match ffmpeg's own (highpass, lowshelf, equalizer,
//      highshelf in double precision) within −60 dB;
//   3. the compressor sits on its static curve (Giannoulis et al. 2012, soft
//      knee) on a square wave; the de-esser leaves a low tone alone and turns
//      a high one down;
//   4. an export runs the chain where the preview does — clip effects after the
//      element and before its gain, track effects on the track's sum;
//   5. denoise (afftdn) renders a file of the same length with no time shift
//      and less noise, and an export with it plays that file;
//   6. (from K2) a range that starts or ends inside a fade enters it part-way
//      instead of restarting it — level vs the full export at the same time;
//   7. (from K10) a bake over a segment of unknown channel count hashes apart.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-audio-fx.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const safe = async (name, fn) => { try { return await fn() } catch (err) { check(name, false, String(err).split('\n')[0]); return null } }

const FX = await safe('shared/audioFx.ts loads', () => load(`export * from './shared/audioFx'`)) ?? {}
const FF = await safe('electron/ffmpeg.ts loads', () => load(`export * from './electron/ffmpeg'`)) ?? {}
const SUB = await safe('collectRangeAudio loads', () => load(`export { collectRangeAudio } from './src/engine/subtitles'`)) ?? {}
const AR = await safe('bakePlan loads', () => load(`export { bakePlan } from './src/engine/audioReact'`)) ?? {}

// the worklet module, as the AudioWorkletGlobalScope would run it
const procs = {}
globalThis.sampleRate = 48000
globalThis.currentFrame = 0
globalThis.registerProcessor = (name, ctor) => { procs[name] = ctor }
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null } } }
await safe('the worklet module loads', () => load(`import './src/engine/limiter.worklet'`))

const SR = 48000
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 * 2 - 1 }
/** planar stereo test signal: speech-ish — noise bursts, a low tone, sibilant hiss */
function signal(n) {
  const l = new Float32Array(n), r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.15 + 0.6 * (Math.sin(2 * Math.PI * 3 * t) > 0.3 ? 1 : 0.1)
    const hiss = (t % 0.5) < 0.12 ? 0.3 * rnd() : 0
    l[i] = env * (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.2 * rnd()) + hiss
    r[i] = env * (0.5 * Math.sin(2 * Math.PI * 180 * t + 0.4) + 0.2 * rnd()) + 0.8 * hiss
  }
  return [l, r]
}
const interleave = ([l, r]) => { const o = new Float32Array(l.length * 2); for (let i = 0; i < l.length; i++) { o[2 * i] = l[i]; o[2 * i + 1] = r[i] } return o }
/** error of b against a, dB relative to a's RMS */
function relErr(a, b, from = 0) {
  let e = 0, s = 0
  for (let i = from; i < Math.min(a.length, b.length); i++) { e += (a[i] - b[i]) ** 2; s += a[i] ** 2 }
  return db(Math.sqrt(e / Math.max(s, 1e-30)))
}
const fx = (type, params = {}, enabled = true) => ({ id: type + Math.random(), type, enabled, params: { ...(FX.fxDefaults?.(type) ?? {}), ...params } })
const CHAIN = () => [
  fx('eq', { hp: 80, lowGain: -3, midGain: 5, midFreq: 2500, midQ: 1.4, highGain: 4 }),
  fx('comp', { threshold: -20, ratio: 4, knee: 6, attack: 5, release: 120, makeup: 3 }),
  fx('deess', { freq: 6000, threshold: -30, range: 10 })
]

/** the worklet: a fresh processor, `msgs` posted at given frames, 128-frame quanta */
function runWorklet(list, [l, r], msgs = []) {
  const P = procs['kadr-fx']
  if (!P) throw new Error('no kadr-fx processor registered')
  const p = new P()
  p.port.onmessage?.({ data: { fx: list } })
  const n = l.length, ol = new Float32Array(n), or = new Float32Array(n)
  for (let i = 0; i < n; i += 128) {
    for (const m of msgs) if (m.at === i) p.port.onmessage?.({ data: { fx: m.fx } })
    const k = Math.min(128, n - i)
    const out = [new Float32Array(128), new Float32Array(128)]
    p.process([[l.slice(i, i + k), r.slice(i, i + k)]], [out])
    ol.set(out[0].subarray(0, k), i); or.set(out[1].subarray(0, k), i)
  }
  return [ol, or]
}

// ---- 1. the worklet's form and the export's form
await safe('worklet vs premix', async () => {
  const sig = signal(SR * 3)
  const list = CHAIN()
  const w = runWorklet(list, sig)
  const p = interleave(sig)
  FF.fxInterleaved(p, list, SR)
  const pl = new Float32Array(sig[0].length), pr = new Float32Array(sig[0].length)
  for (let i = 0; i < pl.length; i++) { pl[i] = p[2 * i]; pr[i] = p[2 * i + 1] }
  const e = Math.max(relErr(pl, w[0]), relErr(pr, w[1]))
  check('EQ + compressor + de-esser: the worklet (128-frame quanta) and the export form within −60 dB', e <= -60, `${e.toFixed(1)} dB`)
  check('…and the chain does something (not a pass-through)', relErr(sig[0], pl) > -20, `${relErr(sig[0], pl).toFixed(1)} dB from the input`)

  // a slider moved mid-stream: the new chain takes over the running state (no restart click)
  const moved = CHAIN(); moved[0].params.midGain = 6
  const at = 128 * 400
  const w2 = runWorklet(list, sig, [{ at, fx: moved }])
  const fresh = runWorklet(moved, [sig[0].slice(at), sig[1].slice(at)])
  // a restarted chain differs from the carried one right after the switch; a carried one stays near the old output
  const jumpCarried = Math.abs(w2[0][at] - w[0][at]), jumpFresh = Math.abs(fresh[0][0] - w[0][at])
  check('a parameter change keeps the filters\' and detectors\' state (no click)', jumpCarried < 0.05 && jumpCarried <= jumpFresh + 1e-9,
    `step at the switch ${jumpCarried.toFixed(4)} (a restarted chain: ${jumpFresh.toFixed(4)})`)
  const off = CHAIN().map((f) => ({ ...f, enabled: false }))
  const w3 = runWorklet(off, sig)
  check('all effects off: the worklet passes the input through bit for bit', relErr(sig[0], w3[0]) <= -200, `${relErr(sig[0], w3[0]).toFixed(0)} dB`)
})

const dir = mkdtempSync(join(tmpdir(), 'kadr-audiofx-'))
const FFMPEG = FF.FFMPEG ?? 'ffmpeg'
const writeF32 = (file, inter) => writeFileSync(file, Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength))
const readF32 = (file) => { const b = readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4))) }
const pcmOf = (file) => {
  const buf = readFileSync(file)
  const at = buf.indexOf('data') + 8
  const i16 = new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
  return Float32Array.from(i16, (v) => v / 32768)
}
const rmsOf = (pcm, a, b, ch = 2) => {
  let s = 0, n = 0
  for (let i = Math.round(a * SR) * ch; i < Math.round(b * SR) * ch && i < pcm.length; i++, n++) s += pcm[i] ** 2
  return Math.sqrt(s / Math.max(1, n))
}
try {
  // ---- 2. EQ vs ffmpeg's biquads
  await safe('EQ vs ffmpeg', async () => {
    const sig = signal(SR * 2), inter = interleave(sig)
    const raw = join(dir, 'in.f32'), out = join(dir, 'out.f32')
    writeF32(raw, inter)
    const eq = fx('eq', { hp: 80, lowFreq: 150, lowGain: -4, midFreq: 2500, midQ: 1.4, midGain: 5, highFreq: 9000, highGain: 3 })
    const p = eq.params
    const chain = [
      'aformat=sample_fmts=dblp',
      `highpass=f=${p.hp}:poles=2:width_type=q:width=${Math.SQRT1_2}`,
      `lowshelf=f=${p.lowFreq}:width_type=s:width=1:gain=${p.lowGain}`,
      `equalizer=f=${p.midFreq}:width_type=q:width=${p.midQ}:gain=${p.midGain}`,
      `highshelf=f=${p.highFreq}:width_type=s:width=1:gain=${p.highGain}`
    ].join(',')
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', raw, '-af', chain, '-f', 'f32le', '-y', out])
    const ref = readF32(out)
    const mine = interleave(sig)
    FF.fxInterleaved(mine, [eq], SR)
    const e = relErr(ref, mine)
    check('the EQ\'s RBJ biquads match ffmpeg highpass/lowshelf/equalizer/highshelf within −60 dB', e <= -60, `${e.toFixed(1)} dB`)
  })

  // ---- 3. the compressor's static curve, the de-esser's split band
  await safe('compressor curve', async () => {
    const n = SR
    const sq = (a) => { const l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = (Math.floor(i / 24) % 2 ? a : -a); return [l, l.slice()] }
    const level = ([l]) => { let m = 0; for (let i = n - 4800; i < n; i++) m = Math.max(m, Math.abs(l[i])); return db(m) }
    const run = (a, params) => { const s = sq(a); FX.createFxChain([fx('comp', params)], SR).process(s, n); return level(s) }
    const hard = run(0.5, { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, makeup: 0 })
    const want = -20 + (db(0.5) + 20) / 4
    check('compressor: −6 dBFS square, −20 dB threshold, 4:1 → on the static curve', Math.abs(hard - want) < 0.1, `${hard.toFixed(2)} dB (curve ${want.toFixed(2)})`)
    // soft knee: at the threshold itself the curve is (1/R − 1)·W/8 below it
    const kneeAt = run(0.1, { threshold: db(0.1), ratio: 4, knee: 8, attack: 1, release: 50, makeup: 2 })
    const kw = db(0.1) + (1 / 4 - 1) * 8 / 8 + 2
    check('compressor: soft knee at the threshold, plus makeup', Math.abs(kneeAt - kw) < 0.1, `${kneeAt.toFixed(2)} dB (curve ${kw.toFixed(2)})`)
    const below = run(0.01, { threshold: -20, ratio: 4, knee: 6, attack: 1, release: 50, makeup: 0 })
    check('compressor: under the knee the level is untouched', Math.abs(below - db(0.01)) < 0.01, `${below.toFixed(3)} dB`)

    const tone = (f) => { const l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR); return [l, l.slice()] }
    const de = () => FX.createFxChain([fx('deess', { freq: 6000, threshold: -30, range: 10 })], SR)
    const lo = tone(200), loIn = lo[0].slice(); de().process(lo, n)
    check('de-esser: a 200 Hz tone passes untouched', relErr(loIn, lo[0]) <= -60, `${relErr(loIn, lo[0]).toFixed(1)} dB`)
    const hi = tone(8000), hiIn = hi[0].slice(); de().process(hi, n)
    const cut = db(rmsOf(hiIn, 0.5, 1, 1)) - db(rmsOf(hi[0], 0.5, 1, 1))
    check('de-esser: an 8 kHz tone at −6 dBFS is turned down by its range (≈10 dB)', cut >= 6 && cut <= 10.5, `${cut.toFixed(2)} dB`)
  })

  // shared sources
  const src = join(dir, 'voice.wav')
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='(0.15+0.6*gt(sin(2*PI*3*t),0.3))*(0.5*sin(2*PI*180*t)+0.2*(random(0)*2-1))':s=${SR}:d=6`,
    '-ac', '2', '-c:a', 'pcm_f32le', '-y', src])
  const seg = (extra = {}) => ({ path: src, inPoint: 0.5, duration: 4, start: 0.5, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0, channels: 2, ...extra })

  // ---- 4. the export runs the chain where the preview does
  await safe('export clip fx', async () => {
    const comp = [fx('comp', { threshold: -24, ratio: 4, knee: 6, attack: 5, release: 100, makeup: 0 })]
    const a = join(dir, 'a.wav'), b = join(dir, 'b.wav')
    await FF.mixdownWav([seg({ gain: 0.5, fx: comp })], 5, a)
    await FF.mixdownWav([seg()], 5, b)
    const ref = pcmOf(b)
    FF.fxInterleaved(ref, comp, SR, 0.5 * SR)
    for (let i = 0; i < ref.length; i++) ref[i] *= 0.5
    const got = pcmOf(a)
    const e = relErr(ref, got, SR * 2 * 0.5 + 2)
    check('a clip\'s effects run on its sound BEFORE its gain (element → fx → gain, as in the preview)', e <= -50, `${e.toFixed(1)} dB (16-bit mixdown)`)
    const plain = pcmOf(b), e2 = relErr(plain, got)
    check('…and they change the export at all', e2 > -20, `${e2.toFixed(1)} dB from the plain mix`)

    // the premix path (> PREMIX_THRESHOLD segments) gets the same
    const many = Array.from({ length: (FF.PREMIX_THRESHOLD ?? 64) + 1 }, (_, i) => seg({ gain: i ? 0 : 0.5, fx: i ? undefined : comp }))
    const c = join(dir, 'c.wav')
    await FF.mixdownWav(many, 5, c)
    const e3 = relErr(got, pcmOf(c))
    check('…in the premix path too', e3 <= -50, `${e3.toFixed(1)} dB`)
  })

  await safe('export track fx', async () => {
    const comp = [fx('comp', { threshold: -30, ratio: 6, knee: 0, attack: 2, release: 80, makeup: 0 })]
    const bus = { id: 'A1', fx: comp }
    const s1 = seg({ start: 0, inPoint: 0, duration: 3, bus }), s2 = seg({ start: 2, inPoint: 2.5, duration: 3, gain: 0.7, bus })
    const a = join(dir, 'ta.wav'), b = join(dir, 'tb.wav')
    await FF.mixdownWav([s1, s2], 5, a)
    await FF.mixdownWav([{ ...s1, bus: undefined }, { ...s2, bus: undefined }], 5, b)
    const ref = pcmOf(b)
    FF.fxInterleaved(ref, comp, SR)
    const e = relErr(ref, pcmOf(a))
    check('a track\'s effects run on the track\'s SUM (bus → fx, as in the preview)', e <= -50, `${e.toFixed(1)} dB`)
    // the sum, not each clip: compressing the clips one by one is measurably different
    const one = join(dir, 'tc.wav')
    await FF.mixdownWav([{ ...s1, bus: undefined, fx: comp }, { ...s2, bus: undefined, fx: comp }], 5, one)
    check('…which is not the same as compressing each clip', relErr(ref, pcmOf(one)) > -40, `${relErr(ref, pcmOf(one)).toFixed(1)} dB apart`)

    // the risk line: a long track with an effect, premixed in main
    const long = join(dir, 'long.wav')
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=600:c=pink:a=0.2:r=${SR}`, '-ac', '2', '-c:a', 'pcm_s16le', '-y', long])
    const t0 = Date.now(), rss0 = process.memoryUsage().rss
    let peak = rss0
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
    await FF.mixdownWav([{ path: long, inPoint: 0, duration: 600, start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0, channels: 2, bus }], 600, join(dir, 'long-out.wav'))
    clearInterval(iv)
    const ms = Date.now() - t0
    check('a 10-minute track with a compressor mixes in reasonable time and memory', ms < 60000,
      `${(ms / 1000).toFixed(1)} s, peak RSS +${Math.round((peak - rss0) / 1e6)} MB (≈23 MB per minute of track is the floor)`)
  })

  // ---- 5. denoise
  await safe('denoise', async () => {
    const noisy = join(dir, 'noisy.wav')
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*440*t)*between(t,1,3)+0.03*(random(0)*2-1)':s=${SR}:d=4`,
      '-ac', '1', '-c:a', 'pcm_s16le', '-y', noisy])
    const out = join(dir, 'dn.flac')
    await FF.makeDenoised(noisy, out, 20)
    const dec = (f) => execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 })
    const a = new Float32Array(dec(noisy).buffer.slice(0)), b = new Float32Array(dec(out).buffer.slice(0))
    check('denoise: the file is as long as the source (to the sample)', a.length === b.length, `${a.length} vs ${b.length} samples`)
    // no time shift: the tone's cross-correlation peaks at lag 0
    let best = 0, bestLag = 0
    for (let lag = -200; lag <= 200; lag++) {
      let s = 0
      for (let i = SR * 1.5; i < SR * 2.5; i++) s += a[i] * b[i + lag]
      if (s > best) { best = s; bestLag = lag }
    }
    check('denoise: no time shift (cross-correlation peak at lag 0)', Math.abs(bestLag) <= 1, `lag ${bestLag} samples`)
    const nIn = db(rmsOf(a, 0.2, 0.9, 1)), nOut = db(rmsOf(b, 0.2, 0.9, 1))
    const tIn = db(rmsOf(a, 1.5, 2.5, 1)), tOut = db(rmsOf(b, 1.5, 2.5, 1))
    check('denoise: a −35 dBFS hiss between the words drops by ≥ 12 dB, the tone stays within 1 dB', nIn - nOut >= 12 && Math.abs(tIn - tOut) < 1,
      `noise ${nIn.toFixed(1)} → ${nOut.toFixed(1)} dB, tone ${tIn.toFixed(2)} → ${tOut.toFixed(2)} dB`)
    // a quiet room: the floor is measured per file, not assumed
    const quiet = join(dir, 'quiet.wav'), qout = join(dir, 'qdn.flac')
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*440*t)*between(t,1,3)+0.005*(random(0)*2-1)':s=${SR}:d=4`,
      '-ac', '1', '-c:a', 'pcm_s24le', '-y', quiet])
    await FF.makeDenoised(quiet, qout, 20)
    const qa = new Float32Array(dec(quiet).buffer.slice(0)), qb = new Float32Array(dec(qout).buffer.slice(0))
    const qIn = db(rmsOf(qa, 0.2, 0.9, 1)), qOut = db(rmsOf(qb, 0.2, 0.9, 1))
    check('denoise: a −51 dBFS hiss drops by ≥ 12 dB too', qIn - qOut >= 12, `${qIn.toFixed(1)} → ${qOut.toFixed(1)} dB`)

    // an export with denoise plays the cached file (the hook main installs)
    FF.configureDenoiser(async (path, nr) => (path === noisy && nr === 20 ? out : path))
    const x = join(dir, 'dx.wav'), y = join(dir, 'dy.wav')
    const base = { inPoint: 0.5, duration: 3, start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0, channels: 1 }
    await FF.mixdownWav([{ ...base, path: noisy, denoise: 20 }], 3, x)
    await FF.mixdownWav([{ ...base, path: out }], 3, y)
    const e = relErr(pcmOf(y), pcmOf(x))
    check('an export of a denoised clip plays the same cached file', e < -90, `${e.toFixed(0)} dB`)
    FF.configureDenoiser(null)
  })

  // ---- 6. (K2) a range inside a fade enters it part-way
  await safe('mid-fade range', async () => {
    const assets = [{ id: 'A', kind: 'audio', path: src, duration: 6, hasAudio: true, channels: 2 }]
    const project = (extra) => ({ assets, tracks: [{ id: 't', kind: 'audio', gain: 1, muted: false, clips: [
      { id: 'c', kind: 'media', assetId: 'A', start: 0, duration: 5, inPoint: 0.5, speed: 1, gain: { value: 1 }, muted: false, ...extra }] }] })
    for (const [name, extra, from, to] of [
      ['fade-in', { fadeIn: 2, fadeInCurve: 'qsin' }, 1, 5],
      ['fade-out', { fadeOut: 2, fadeOutCurve: 'lin' }, 0, 4]
    ]) {
      const full = join(dir, `full-${name}.wav`), part = join(dir, `part-${name}.wav`)
      await FF.mixdownWav(SUB.collectRangeAudio(project(extra), 0, 5), 5, full)
      await FF.mixdownWav(SUB.collectRangeAudio(project(extra), from, to), to - from, part)
      const F = pcmOf(full), P = pcmOf(part)
      let worst = 0
      for (let t = 0; t < to - from - 0.1; t += 0.1) {
        const d = Math.abs(db(rmsOf(P, t, t + 0.1)) - db(rmsOf(F, from + t, from + t + 0.1)))
        if (rmsOf(F, from + t, from + t + 0.1) > 1e-4) worst = Math.max(worst, d)
      }
      check(`a range ${name === 'fade-in' ? 'starting' : 'ending'} inside a ${name} enters it part-way — level = the full export's at the same time`, worst <= 0.2, `worst ${worst.toFixed(3)} dB`)
    }
  })

  // ---- collect: effects ride the segments
  await safe('collect fx', async () => {
    const assets = [{ id: 'A', kind: 'audio', path: src, duration: 6, hasAudio: true, channels: 2 }]
    const comp = [fx('comp')], dn = [fx('denoise', { nr: 15 }), fx('eq', { midGain: 3 }), fx('deess', {}, false)]
    const p = { assets, tracks: [{ id: 't', kind: 'audio', gain: 1, muted: false, audioFx: comp, clips: [
      { id: 'c', kind: 'media', assetId: 'A', start: 0, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false, audioFx: dn }] }] }
    const [s] = SUB.collectRangeAudio(p, 0, 4)
    check('a segment carries its clip\'s enabled DSP effects, its denoise strength and its track\'s bus',
      s?.fx?.length === 1 && s.fx[0].type === 'eq' && s.denoise === 15 && s.bus?.id === 't' && s.bus.fx.length === 1,
      JSON.stringify({ fx: s?.fx?.map((f) => f.type), denoise: s?.denoise, bus: s?.bus?.id }))
    const q = { assets, tracks: [{ id: 't', kind: 'audio', gain: 1, muted: false, clips: [
      { id: 'c', kind: 'media', assetId: 'A', start: 0, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false }] }] }
    const [s2] = SUB.collectRangeAudio(q, 0, 4)
    check('a clip and track without effects add nothing to the segment (old projects mix as before)',
      s2 && !('fx' in s2) && !('bus' in s2) && !('denoise' in s2), JSON.stringify(s2))
  })

  // ---- 7. (K10) bake hash and the up-mix
  await safe('bake hash', async () => {
    const mk = (channels) => ({ fps: 30, assets: [{ id: 'A', kind: 'audio', path: src, duration: 6, hasAudio: true, ...(channels ? { channels } : {}) }],
      markers: [], tracks: [
        { id: 'v', kind: 'video', gain: 1, muted: false, clips: [{ id: 'f', kind: 'remotion', start: 0, duration: 2, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false,
          fragmentMeta: { fps: 30, durationInFrames: 60 } }] },
        { id: 't', kind: 'audio', gain: 1, muted: false, clips: [{ id: 'c', kind: 'media', assetId: 'A', start: 0, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, muted: false }] }] })
    const plan = (c) => AR.bakePlan(mk(c), mk(c).tracks[0].clips[0])
    // the hash formula as it was before (no up-mix mark)
    const oldHash = (segments) => {
      let h = 0x811c9dc5
      const s = JSON.stringify({ fps: 30, frames: 60, t0: 0, speed: 1, source: 'mix', segments, music: [] })
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      return h.toString(16).padStart(8, '0')
    }
    const none = plan(0), two = plan(2)
    check('a bake over a source of unknown channel count goes stale once (its export level moved with K10)',
      none.hash !== oldHash(none.segments), `${none.hash} vs before ${oldHash(none.segments)}`)
    check('…while a bake over known channel counts keeps its hash', two.hash === oldHash(two.segments), `${two.hash} vs ${oldHash(two.segments)}`)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
