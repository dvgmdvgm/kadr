// K9: audio effects — EQ, compressor, de-esser — as ONE DSP. The preview runs
// it in an AudioWorklet (`kadr-fx` in src/engine/limiter.worklet.ts) between a
// clip's element and its gain, or between a track's bus and the master; the
// export runs the very same code in main over the decoded segment (clip) or the
// track's premixed sum (track) — electron/ffmpeg.ts `applyAudioFx`. Parameters
// are in Hz, dB and ms, so the 44.1 kHz preview context and the 48 kHz export
// compute their own coefficients from the same numbers.
// (scripts/check-audio-fx.mjs: worklet blocks vs one buffer, EQ vs ffmpeg's
// own biquads, the compressor's static curve.)
//
// Denoise is not here: it is a file (ffmpeg afftdn, rendered once and cached —
// electron/main.ts `ensureDenoised`) that both the preview and the export play
// in place of the source.

export type AudioFxType = 'eq' | 'comp' | 'deess' | 'denoise'
export const AUDIO_FX_TYPES: AudioFxType[] = ['eq', 'comp', 'deess', 'denoise']

export interface AudioFx {
  id: string
  type: AudioFxType
  enabled: boolean
  params: Record<string, number>
}

/** each parameter: default, range and step (the Inspector's sliders read this) */
export interface FxParam { key: string; def: number; min: number; max: number; step: number; unit: 'Hz' | 'dB' | 'ms' | '' | ':1' }
export const FX_PARAMS: Record<AudioFxType, FxParam[]> = {
  eq: [
    // low cut: 0 = off
    { key: 'hp', def: 0, min: 0, max: 400, step: 5, unit: 'Hz' },
    { key: 'lowGain', def: 0, min: -18, max: 18, step: 0.5, unit: 'dB' },
    { key: 'lowFreq', def: 120, min: 40, max: 500, step: 5, unit: 'Hz' },
    { key: 'midGain', def: 0, min: -18, max: 18, step: 0.5, unit: 'dB' },
    { key: 'midFreq', def: 1000, min: 200, max: 8000, step: 10, unit: 'Hz' },
    { key: 'midQ', def: 1, min: 0.3, max: 8, step: 0.1, unit: '' },
    { key: 'highGain', def: 0, min: -18, max: 18, step: 0.5, unit: 'dB' },
    { key: 'highFreq', def: 8000, min: 2000, max: 16000, step: 100, unit: 'Hz' }
  ],
  // a dialogue compressor (docs/agents/knowledge/audio-fx-dsp.md)
  comp: [
    { key: 'threshold', def: -24, min: -60, max: 0, step: 0.5, unit: 'dB' },
    { key: 'ratio', def: 3, min: 1, max: 20, step: 0.1, unit: ':1' },
    { key: 'knee', def: 6, min: 0, max: 24, step: 0.5, unit: 'dB' },
    { key: 'attack', def: 10, min: 0.1, max: 200, step: 0.1, unit: 'ms' },
    { key: 'release', def: 150, min: 5, max: 2000, step: 5, unit: 'ms' },
    { key: 'makeup', def: 0, min: 0, max: 24, step: 0.5, unit: 'dB' }
  ],
  deess: [
    { key: 'freq', def: 6000, min: 2000, max: 12000, step: 100, unit: 'Hz' },
    { key: 'threshold', def: -30, min: -60, max: 0, step: 0.5, unit: 'dB' },
    { key: 'range', def: 10, min: 0, max: 24, step: 0.5, unit: 'dB' }
  ],
  // afftdn's noise reduction, dB (ffmpeg's own default is 12)
  denoise: [
    { key: 'nr', def: 12, min: 1, max: 40, step: 1, unit: 'dB' }
  ]
}

export const fxDefaults = (type: AudioFxType): Record<string, number> =>
  Object.fromEntries(FX_PARAMS[type].map((p) => [p.key, p.def]))

/** a parameter as stored, falling back to its default and clamped to its range */
export function fxParam(fx: AudioFx, key: string): number {
  const p = FX_PARAMS[fx.type]?.find((x) => x.key === key)
  const v = fx.params?.[key]
  if (!p) return Number.isFinite(v) ? v : 0
  return Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def
}

/** what the DSP has to run: enabled, and not denoise (that one is a file) */
export const dspFx = (list: AudioFx[] | undefined): AudioFx[] =>
  (list ?? []).filter((f) => f.enabled && f.type !== 'denoise' && FX_PARAMS[f.type])

/** the enabled denoise of a list, if any — its reduction in dB */
export function denoiseOf(list: AudioFx[] | undefined): number | null {
  const d = (list ?? []).find((f) => f.enabled && f.type === 'denoise')
  return d ? fxParam(d, 'nr') : null
}

/** sanitizeProject: a list of well-formed effects, or undefined */
export function cleanFx(raw: unknown): AudioFx[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: AudioFx[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object' || !AUDIO_FX_TYPES.includes((f as AudioFx).type)) continue
    const x = f as AudioFx
    const params: Record<string, number> = {}
    for (const p of FX_PARAMS[x.type]) params[p.key] = fxParam(x, p.key)
    out.push({ id: typeof x.id === 'string' && x.id ? x.id : Math.random().toString(36).slice(2, 10), type: x.type, enabled: x.enabled !== false, params })
  }
  return out.length ? out : undefined
}

// ---------------------------------------------------------------- the DSP

/** RBJ cookbook biquad (Bristow-Johnson), normalised: [b0, b1, b2, a1, a2] */
type Coefs = [number, number, number, number, number]
const norm = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Coefs =>
  [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]

export function peaking(f: number, q: number, gainDb: number, sr: number): Coefs {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q)
  return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A)
}
/** shelves with slope S = 1 */
export function lowShelf(f: number, gainDb: number, sr: number): Coefs {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), s2 = 2 * Math.sqrt(A) * (Math.sin(w) / Math.SQRT2)
  return norm(A * (A + 1 - (A - 1) * c + s2), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - s2),
    A + 1 + (A - 1) * c + s2, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - s2)
}
export function highShelf(f: number, gainDb: number, sr: number): Coefs {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), s2 = 2 * Math.sqrt(A) * (Math.sin(w) / Math.SQRT2)
  return norm(A * (A + 1 + (A - 1) * c + s2), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s2),
    A + 1 - (A - 1) * c + s2, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s2)
}
export function lowPass(f: number, q: number, sr: number): Coefs {
  const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q)
  return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al)
}
export function highPass(f: number, q: number, sr: number): Coefs {
  const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q)
  return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
}

/** one biquad per channel, transposed direct form II in doubles */
class Biquad {
  z: Float64Array
  constructor(private k: Coefs, ch: number, readonly band = '') { this.z = new Float64Array(ch * 2) }
  step(x: number, ch: number): number {
    const [b0, b1, b2, a1, a2] = this.k, z = this.z, i = ch * 2
    const y = b0 * x + z[i]
    z[i] = b1 * x - a1 * y + z[i + 1]
    z[i + 1] = b2 * x - a2 * y
    return y
  }
}

const coef = (ms: number, sr: number) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sr)))

/** static gain computer, dB in → dB of gain (≤ 0), soft knee of width W (Giannoulis, Massberg & Reiss 2012) */
export function gainComputer(x: number, T: number, R: number, W: number): number {
  const d = x - T
  if (2 * d < -W) return 0
  if (W > 0 && 2 * Math.abs(d) <= W) return (1 / R - 1) * (d + W / 2) ** 2 / (2 * W)
  return (1 / R - 1) * d
}

interface Stage {
  run(chs: (Float32Array | Float64Array)[], from: number, n: number): void
  /** carry the running state of the stage it replaces (a slider moved): no click */
  take(prev: Stage): void
  kind: string
  /** the running state a successor takes over */
  bands?: Biquad[]
  st?: { g: number }
  hp?: Biquad
  lp?: Biquad
}

function eqStage(fx: AudioFx, sr: number, ch: number): Stage | null {
  const p = (k: string) => fxParam(fx, k)
  const nyq = sr / 2 - 1
  const bands: Biquad[] = []
  if (p('hp') > 0) bands.push(new Biquad(highPass(Math.min(nyq, p('hp')), Math.SQRT1_2, sr), ch, 'hp'))
  if (p('lowGain')) bands.push(new Biquad(lowShelf(Math.min(nyq, p('lowFreq')), p('lowGain'), sr), ch, 'low'))
  if (p('midGain')) bands.push(new Biquad(peaking(Math.min(nyq, p('midFreq')), p('midQ'), p('midGain'), sr), ch, 'mid'))
  if (p('highGain')) bands.push(new Biquad(highShelf(Math.min(nyq, p('highFreq')), p('highGain'), sr), ch, 'high'))
  if (!bands.length) return null
  return {
    kind: 'eq',
    bands,
    take(prev: Stage) {
      for (const b of bands) { const o = prev.bands?.find((x) => x.band === b.band); if (o && o.z.length === b.z.length) b.z.set(o.z) }
    },
    run(chs, from, n) {
      for (let c = 0; c < chs.length; c++) {
        const a = chs[c]
        for (let i = from; i < from + n; i++) {
          let x = a[i]
          for (const b of bands) x = b.step(x, c)
          a[i] = x
        }
      }
    }
  }
}

const EPS = 1e-10
const toDb = (x: number) => 20 * Math.log10(x + EPS)

/** feed-forward, stereo-linked (the louder channel), log-domain smoothing of the gain */
function compStage(fx: AudioFx, sr: number): Stage {
  const T = fxParam(fx, 'threshold'), R = fxParam(fx, 'ratio'), W = fxParam(fx, 'knee')
  const aA = coef(fxParam(fx, 'attack'), sr), aR = coef(fxParam(fx, 'release'), sr)
  const makeup = fxParam(fx, 'makeup')
  const st = { g: 0 } // smoothed gain, dB
  return {
    kind: 'comp',
    st,
    take(prev: Stage) { if (prev.st) st.g = prev.st.g },
    run(chs, from, n) {
      let g = st.g
      for (let i = from; i < from + n; i++) {
        let m = 0
        for (const a of chs) { const v = Math.abs(a[i]); if (v > m) m = v }
        const gc = gainComputer(toDb(m), T, R, W)
        g = gc < g ? aA * g + (1 - aA) * gc : aR * g + (1 - aR) * gc
        const k = 10 ** ((g + makeup) / 20)
        for (const a of chs) a[i] *= k
      }
      st.g = g
    }
  }
}

/** split band. A high-pass at `freq` DETECTS the sibilance; what is turned down
    is x − lowpass(x), so out = g·x + (1 − g)·lowpass(x): with nothing to reduce
    the signal comes back exactly, and the reduced band stays in phase with the
    rest (turning down a plain high-pass output, phase-shifted, took 0.7 dB off
    an 8 kHz tone where 10 were asked) */
function deessStage(fx: AudioFx, sr: number, ch: number): Stage {
  const T = fxParam(fx, 'threshold'), range = fxParam(fx, 'range')
  const f = Math.min(sr / 2 - 1, fxParam(fx, 'freq'))
  const hp = new Biquad(highPass(f, Math.SQRT1_2, sr), ch)
  const lp = new Biquad(lowPass(f, Math.SQRT1_2, sr), ch)
  const aA = coef(1, sr), aR = coef(60, sr)
  const low = new Float64Array(ch)
  const st = { g: 0 }
  return {
    kind: 'deess',
    st,
    hp,
    lp,
    take(prev: Stage) {
      if (prev.st) st.g = prev.st.g
      if (prev.hp && prev.hp.z.length === hp.z.length) hp.z.set(prev.hp.z)
      if (prev.lp && prev.lp.z.length === lp.z.length) lp.z.set(prev.lp.z)
    },
    run(chs, from, n) {
      let g = st.g
      for (let i = from; i < from + n; i++) {
        let m = 0
        for (let c = 0; c < chs.length; c++) {
          const x = chs[c][i]
          low[c] = lp.step(x, c)
          const v = Math.abs(hp.step(x, c))
          if (v > m) m = v
        }
        const gc = Math.max(-range, gainComputer(toDb(m), T, 4, 6))
        g = gc < g ? aA * g + (1 - aA) * gc : aR * g + (1 - aR) * gc
        if (g < 0) {
          const k = 10 ** (g / 20)
          for (let c = 0; c < chs.length; c++) chs[c][i] = k * chs[c][i] + (1 - k) * low[c]
        }
      }
      st.g = g
    }
  }
}

export interface FxChain {
  /** process `n` frames of planar channels in place, from `from` */
  process(chs: (Float32Array | Float64Array)[], n: number, from?: number): void
  stages: Stage[]
}

/** the chain for a list (denoise and disabled entries skipped); null = nothing to do.
    `prev`: the chain this one replaces — stages of the same kind in the same place keep their state */
export function createFxChain(list: AudioFx[] | undefined, sampleRate: number, channels = 2, prev?: FxChain | null): FxChain | null {
  const stages: Stage[] = []
  for (const fx of dspFx(list)) {
    const s = fx.type === 'eq' ? eqStage(fx, sampleRate, channels)
      : fx.type === 'comp' ? compStage(fx, sampleRate)
      : deessStage(fx, sampleRate, channels)
    if (s) stages.push(s)
  }
  if (!stages.length) return null
  if (prev) stages.forEach((s, i) => { const o = prev.stages[i]; if (o?.kind === s.kind) s.take(o) })
  return { stages, process(chs, n, from = 0) { for (const s of stages) s.run(chs, from, n) } }
}

/** what a DSP chain depends on — a change of it means a new chain */
export const fxSignature = (list: AudioFx[] | undefined): string =>
  JSON.stringify(dspFx(list).map((f) => [f.type, FX_PARAMS[f.type].map((p) => fxParam(f, p.key))]))
