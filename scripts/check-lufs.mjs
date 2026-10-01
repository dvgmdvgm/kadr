// The preview's loudness meter (shared/loudness.ts — the DSP the AudioWorklet
// runs on the master, after the limiter) against an independent meter:
// ffmpeg's ebur128 filter, on the same generated stereo float signals.
//
//   node scripts/check-lufs.mjs      (needs ffmpeg in PATH or KADR_FFMPEG)
//
// "the meter DSP matches ffmpeg ebur128 on test signals":
//   1. integrated LUFS within 0.3 LU — a steady tone, noise with silent gaps
//      (the absolute gate) and a quiet passage next to a loud one (the relative
//      gate), at 48 and 44.1 kHz, fed in 128-frame render quanta;
//   2. momentary and short-term at the end within 0.3 LU of ebur128's last
//      frame-log line;
//   3. true peak within 0.3 dB — including a tone whose samples miss its crest
//      by 3 dB (fs/4 at 45°), where the sample peak is wrong on purpose.
// Cost when it fails: a meter the user cannot trust for delivery.
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = process.env.KADR_FFMPEG || 'ffmpeg'
const js = buildSync({
  entryPoints: [join(root, 'shared', 'loudness.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral'
}).outputFiles[0].text
const { createLoudnessMeter } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const dir = mkdtempSync(join(tmpdir(), 'kadr-lufs-'))

let seed = 777
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 * 2 - 1 }
const db = (x) => 10 ** (x / 20)

/** planar stereo, `sec` seconds; f(t, i) → [l, r] */
function gen(sr, sec, f) {
  const n = Math.round(sr * sec), l = new Float32Array(n), r = new Float32Array(n)
  for (let i = 0; i < n; i++) { const [a, b] = f(i / sr, i); l[i] = a; r[i] = b }
  return [l, r]
}
const signals = {
  'tone −20 dBFS 1 kHz': (sr) => gen(sr, 6, (t) => { const s = db(-20) * Math.sin(2 * Math.PI * 1000 * t); return [s, s] }),
  'noise with silent gaps': (sr) => gen(sr, 8, (t) => {
    const on = Math.floor(t / 0.7) % 2 === 0
    return on ? [db(-12) * rnd(), db(-15) * rnd()] : [0, 0]
  }),
  'quiet passage beside a loud one': (sr) => gen(sr, 12, (t) => {
    const a = t < 6 ? db(-42) : db(-14)
    return [a * rnd(), a * Math.sin(2 * Math.PI * 220 * t)]
  }),
  'intersample crest (fs/4 at 45°)': (sr) => gen(sr, 3, (t, i) => {
    // faded in: an abrupt onset overshoots between samples for real (Gibbs)
    const s = 0.9 * Math.min(1, t / 0.2) * Math.sin(Math.PI / 2 * i + Math.PI / 4); return [s, -s]
  })
}

function ebur128(file, sr) {
  const r = spawnSync(FFMPEG, ['-nostats', '-hide_banner', '-v', 'verbose', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', file,
    '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const log = r.stderr
  const frames = [...log.matchAll(/ M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/g)]
  const last = frames[frames.length - 1]
  const s = log.slice(log.lastIndexOf('Summary:'))
  return {
    i: parseFloat(s.match(/I:\s*(-?[\d.]+|-inf)\s*LUFS/)?.[1]),
    tp: parseFloat(s.match(/True peak:\s*Peak:\s*(-?[\d.]+|-inf)/)?.[1]),
    m: parseFloat(last?.[1]), s: parseFloat(last?.[2])
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x))

for (const sr of [48000, 44100]) {
  for (const [name, make] of Object.entries(signals)) {
    const [l, r] = make(sr)
    const file = join(dir, 'sig.f32')
    const inter = new Float32Array(l.length * 2)
    for (let i = 0; i < l.length; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i] }
    writeFileSync(file, Buffer.from(inter.buffer))
    const ref = ebur128(file, sr)

    const meter = createLoudnessMeter(sr, 2)
    for (let o = 0; o < l.length; o += 128) {
      const n = Math.min(128, l.length - o)
      meter.process([l.subarray(o, o + n), r.subarray(o, o + n)], n)
    }
    const got = meter.read()
    const tag = `${sr / 1000} kHz, ${name}`
    check(`${tag}: integrated`, near(got.integrated, ref.i, 0.3), `${f1(got.integrated)} vs ebur128 ${ref.i} LUFS`)
    check(`${tag}: momentary`, near(got.momentary, ref.m, 0.3), `${f1(got.momentary)} vs ${ref.m}`)
    check(`${tag}: short-term`, near(got.shortTerm, ref.s, 0.3), `${f1(got.shortTerm)} vs ${ref.s}`)
    check(`${tag}: true peak`, near(got.truePeak, ref.tp, 0.3), `${f1(got.truePeak)} vs ${ref.tp} dBTP`)
  }
}

// silence reads −∞, and reset() starts the integration over
{
  const m = createLoudnessMeter(48000, 2)
  const z = new Float32Array(128)
  for (let k = 0; k < 400; k++) m.process([z, z], 128)
  check('silence reads −∞', m.read().integrated === -Infinity && m.read().truePeak === -Infinity)
  const [l, r] = signals['tone −20 dBFS 1 kHz'](48000)
  for (let o = 0; o + 128 <= l.length; o += 128) m.process([l.subarray(o, o + 128), r.subarray(o, o + 128)], 128)
  const before = m.read().integrated
  m.reset()
  // a −40 dBFS tone alone: without the reset the −20 history would outvote it
  const [ql, qr] = gen(48000, 4, (t) => { const s = db(-40) * Math.sin(2 * Math.PI * 1000 * t); return [s, s] })
  for (let o = 0; o + 128 <= ql.length; o += 128) m.process([ql.subarray(o, o + 128), qr.subarray(o, o + 128)], 128)
  const after = m.read().integrated
  m.reset() // the peak too: the next second is the −40 tone alone
  for (let o = 0; o + 128 <= ql.length; o += 128) m.process([ql.subarray(o, o + 128), qr.subarray(o, o + 128)], 128)
  const tp = m.read().truePeak
  check('reset() forgets the history', near(before, -20, 0.3) && near(after, -40, 0.3) && near(tp, -40, 0.1),
    `${f1(before)} → ${f1(after)} LUFS, peak ${f1(tp)}`)
}

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
