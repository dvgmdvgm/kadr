/**
 * The loudness meter (K3): ITU-R BS.1770-4 / EBU R128 momentary (400 ms),
 * short-term (3 s) and gated integrated loudness, plus true peak by 4×
 * oversampling. The preview runs it in an AudioWorklet on the master, after the
 * limiter (src/engine/limiter.worklet.ts); scripts/check-lufs.mjs runs the same
 * code in node against ffmpeg's ebur128.
 *
 * K-weighting is the two biquads with the coefficients derived per sample rate
 * exactly as libebur128 and ffmpeg's f_ebur128 derive them. Channels are summed
 * with weight 1 (L, R — the preview master is stereo).
 *
 * The history is kept as BLOCKS, never samples: one energy per 100 ms step (a
 * 400 ms gating block with 75 % overlap) — 36 000 numbers an hour.
 */

type Samples = ArrayLike<number>

export interface Loudness {
  /** LUFS; −Infinity until there is a block, or when it is silent */
  momentary: number
  shortTerm: number
  integrated: number
  /** dBTP since the last reset */
  truePeak: number
}

export interface LoudnessMeter {
  /** n frames of planar input (a missing channel reads as silence) */
  process(input: Samples[], n: number): void
  read(): Loudness
  /** forget the integration and the peak */
  reset(): void
}

/** 4× interpolator: a Hann-windowed sinc, 24 taps per phase — the length that
 *  lands on ebur128's true peak (16 read white noise 0.3 dB low, 48 0.5 dB high) */
const TAPS = 24
const HALF = TAPS / 2
const PHASES: Float64Array[] = [1, 2, 3].map((p) => {
  const h = new Float64Array(TAPS)
  let sum = 0
  for (let j = 0; j < TAPS; j++) {
    const t = j - HALF + p / 4 // distance, in input samples, from x[m-j] to the output instant
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t)
    const w = 0.5 + 0.5 * Math.cos(Math.PI * t / (HALF + 1))
    h[j] = sinc * w
    sum += h[j]
  }
  for (let j = 0; j < TAPS; j++) h[j] /= sum
  return h
})

function kWeighting(sr: number) {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan(Math.PI * f0 / sr)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const pre = {
    b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan(Math.PI * f0 / sr)
  a0 = 1 + K / Q + K * K
  const rlb = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 }
  return { pre, rlb }
}

const lufs = (energy: number) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity)
const ABS_GATE = 10 ** ((-70 + 0.691) / 10)

export function createLoudnessMeter(sampleRate: number, channels: number): LoudnessMeter {
  const { pre, rlb } = kWeighting(sampleRate)
  // biquad state per channel: [pre x1 x2 y1 y2, rlb x1 x2 y1 y2]
  const st = Array.from({ length: channels }, () => new Float64Array(8))
  const ring = Array.from({ length: channels }, () => new Float64Array(TAPS))
  const step = Math.round(sampleRate / 10) // 100 ms
  let ringPos = 0
  let acc = 0, accN = 0 // the current 100 ms sub-block
  let sub: number[] = [] // the last 30 sub-block mean energies
  let blocks: number[] = [] // every 400 ms gating block's energy
  let peak = 0

  function feed(f: number, input: Samples[]) {
    let e = 0
    for (let c = 0; c < channels; c++) {
      const x = input[c] ? input[c][f] : 0
      const s = st[c]
      const y1 = pre.b0 * x + pre.b1 * s[0] + pre.b2 * s[1] - pre.a1 * s[2] - pre.a2 * s[3]
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y1
      const y = rlb.b0 * y1 + rlb.b1 * s[4] + rlb.b2 * s[5] - rlb.a1 * s[6] - rlb.a2 * s[7]
      s[5] = s[4]; s[4] = y1; s[7] = s[6]; s[6] = y
      e += y * y

      // true peak: the sample itself (phase 0) and three interpolated instants
      const r = ring[c]
      r[ringPos] = x
      const ax = Math.abs(x)
      if (ax > peak) peak = ax
      for (const h of PHASES) {
        let v = 0
        for (let j = 0; j < TAPS; j++) v += h[j] * r[(ringPos - j + TAPS) % TAPS]
        const av = Math.abs(v)
        if (av > peak) peak = av
      }
    }
    ringPos = (ringPos + 1) % TAPS
    acc += e
    if (++accN === step) {
      sub.push(acc / step)
      if (sub.length > 30) sub.shift()
      acc = 0
      accN = 0
      if (sub.length >= 4) blocks.push(mean(sub, 4))
    }
  }

  function mean(a: number[], last: number) {
    let s = 0
    for (let i = a.length - last; i < a.length; i++) s += a[i]
    return s / last
  }

  function integrated(): number {
    // ponytail: two passes over every block per read; ~1 M adds/s at 10 reads/s
    // after three hours — a histogram (ffmpeg's) if sessions get longer than that
    let s = 0, n = 0
    for (const b of blocks) if (b > ABS_GATE) { s += b; n++ }
    if (!n) return -Infinity
    const rel = (s / n) * 0.1 // −10 LU
    s = 0; n = 0
    for (const b of blocks) if (b > ABS_GATE && b > rel) { s += b; n++ }
    return n ? lufs(s / n) : -Infinity
  }

  return {
    process(input, n) { for (let f = 0; f < n; f++) feed(f, input) },
    read() {
      return {
        momentary: sub.length >= 4 ? lufs(mean(sub, 4)) : -Infinity,
        shortTerm: sub.length >= 30 ? lufs(mean(sub, 30)) : -Infinity,
        integrated: integrated(),
        truePeak: peak > 0 ? 20 * Math.log10(peak) : -Infinity
      }
    },
    reset() { sub = []; blocks = []; acc = 0; accN = 0; peak = 0 }
  }
}
