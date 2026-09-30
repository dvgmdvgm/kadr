// Shared WebAudio graph for the live preview: every media element is routed
// element → per-clip gain (allows >100% volume) → pan (K4, shared/pan.ts) →
// master (the project's fader) → limiter → analyser
// → output, and the analyser also feeds the loudness meter (K3,
// shared/loudness.ts: LUFS M/S/I and true peak of what reaches the speakers). The limiter is the export's own (shared/previewLimiter.ts, an
// AudioWorklet), so a hot mix clips in neither; `useSettings.previewLimiter`
// takes it out, and until its module has loaded the master goes straight on.
import { useSettings } from '../state/store'
import { logWarn } from './log'
import { tr } from '../i18n'
import type { Loudness } from '@shared/loudness'
import { PANNER_OPTIONS, clampPan } from '@shared/pan'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let analyser: AnalyserNode | null = null
let limiter: AudioWorkletNode | null = null
let limiterState: 'loading' | 'ready' | 'failed' = 'loading'
let meter: AudioWorkletNode | null = null
const SILENT: Loudness = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeak: -Infinity }
let reading: Loudness = SILENT
/** the worklet's URL, handed in by main.tsx: a `?worker&url` import is vite's
 *  alone, and the node checks bundle this file with esbuild */
let limiterModule = ''
export function wirePreviewLimiter(url: string) { limiterModule = url }
const gains = new WeakMap<HTMLMediaElement, GainNode>()
const pans = new WeakMap<HTMLMediaElement, StereoPannerNode>()
/** the project's master fader, and whether silencePreview holds it at 0 */
let masterLevel = 1
let silenced = false
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
/** elements routed into the graph right now (see audioStats) */
let routed = 0

export function ensureAudio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = masterLevel
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    analyser.connect(ctx.destination)
    const c = ctx
    c.audioWorklet.addModule(limiterModule).then(() => {
      limiter = new AudioWorkletNode(c, 'kadr-limiter', {
        outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      })
      limiter.connect(analyser!)
      limiterState = 'ready'
      // a worklet is only pulled while it reaches the destination: it outputs silence there
      meter = new AudioWorkletNode(c, 'kadr-loudness', {
        numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit'
      })
      meter.port.onmessage = (e) => { reading = e.data as Loudness }
      analyser!.connect(meter)
      meter.connect(c.destination)
      route()
    }).catch((e) => {
      limiterState = 'failed'
      logWarn(tr('lgSound'), tr('lmLimiterFail'), String(e))
    })
    useSettings.subscribe((s, prev) => { if (s.previewLimiter !== prev.previewLimiter) route() })
    route()
  }
  return ctx
}

function limiterOn(): boolean {
  return !!limiter && useSettings.getState().previewLimiter
}

/** master → limiter when it is loaded and wanted, else master → analyser */
function route() {
  master!.disconnect()
  master!.connect(limiterOn() ? limiter! : analyser!)
}

export function resumeAudio() {
  const c = ensureAudio()
  if (c.state === 'suspended') c.resume().catch(() => { /* needs a gesture */ })
}

/** Route an element through the graph (idempotent). */
export function attachAudio(el: HTMLMediaElement) {
  const c = ensureAudio()
  if (gains.has(el)) return
  try {
    const src = c.createMediaElementSource(el)
    const gain = c.createGain()
    const pan = new StereoPannerNode(c, PANNER_OPTIONS)
    src.connect(gain).connect(pan).connect(master!)
    gains.set(el, gain)
    pans.set(el, pan)
    sources.set(el, src)
    routed++
  } catch { /* already attached to another context */ }
}

/**
 * Take an element out of the graph for good (the pool is dropping it). A
 * source node stays connected — and is processed on every render quantum —
 * for as long as it is wired to the master, even with its element paused
 * and unreferenced: playing a 19-minute project through left 1080 of them
 * on the graph, and corrective seeks grew from none to more than one a second
 * by the end (see MediaPool.evictFar).
 */
export function detachAudio(el: HTMLMediaElement) {
  const g = gains.get(el)
  if (!g) return
  try { sources.get(el)?.disconnect() } catch { /* already */ }
  try { g.disconnect() } catch { /* already */ }
  try { pans.get(el)?.disconnect() } catch { /* already */ }
  gains.delete(el)
  pans.delete(el)
  sources.delete(el)
  routed--
}

/** Per-clip volume; values above 1 boost beyond the source level. */
export function setElementGain(el: HTMLMediaElement, v: number) {
  const g = gains.get(el)
  // a non-finite value throws inside WebAudio and kills the caller's rAF
  // loop — no gain glitch is worth losing playback for the whole session
  if (g) g.gain.value = Number.isFinite(v) ? Math.max(0, v) : 0
}

/** K4: the element's pan, −1…1 (shared/pan.ts) */
export function setElementPan(el: HTMLMediaElement, p: number) {
  const n = pans.get(el)
  if (n && n.pan.value !== clampPan(p)) n.pan.value = clampPan(p)
}

/** K4: the project's master fader (linear), in front of the limiter as in the export */
export function setMasterGain(v: number) {
  const g = Number.isFinite(v) ? Math.max(0, v) : 1
  if (g === masterLevel || !master) { masterLevel = g; return }
  masterLevel = g
  if (!silenced) master.gain.value = g
}

export function isRouted(el: HTMLMediaElement): boolean {
  return gains.has(el)
}

export function getAnalyser(): AnalyserNode {
  ensureAudio()
  return analyser!
}

/**
 * What the preview's audio graph carries and how its output is doing — for
 * the debug panel, the embedded Claude and tests. `playback` is Chromium's
 * AudioContext.playbackStats: underrunEvents / underrunDuration are the
 * glitches you hear (the device asked for audio the graph had not made).
 */
export function audioStats() {
  const c = ctx
  const ps = c && (c as unknown as { playbackStats?: Record<string, number> }).playbackStats
  // the output's peak right now (the analyser's window, ~11 ms), dBFS
  let peak = 0
  if (analyser) {
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    for (const x of buf) peak = Math.max(peak, Math.abs(x))
  }
  return {
    routed,
    state: c?.state ?? 'none',
    limiter: limiterOn() ? 'on' : limiterState === 'ready' ? 'off' : limiterState,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    loudness: reading,
    playback: ps ? {
      underrunEvents: ps.underrunEvents, underrunDuration: ps.underrunDuration,
      totalDuration: ps.totalDuration, averageLatency: ps.averageLatency, maximumLatency: ps.maximumLatency
    } : null
  }
}

/** The preview output's loudness (LUFS; −Infinity = nothing measured yet). */
export function loudness(): Loudness {
  return reading
}

/** Start the integrated value and the true-peak hold over. */
export function resetLoudness() {
  reading = SILENT
  meter?.port.postMessage('reset')
}

/** Measurements and tests: the graph runs as usual, nothing reaches the speakers. */
export function silencePreview(on: boolean) {
  ensureAudio()
  silenced = on
  master!.gain.value = on ? 0 : masterLevel
}
