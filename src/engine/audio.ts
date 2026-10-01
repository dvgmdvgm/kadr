// Shared WebAudio graph for the live preview: every media element is routed
// element → per-clip gain (allows >100% volume) → pan (K4, shared/pan.ts) →
// its audio track's bus (K6, a unity gain the mixer strip meters) →
// master (the project's fader) → limiter → analyser
// → output, and the analyser also feeds the loudness meter (K3,
// shared/loudness.ts: LUFS M/S/I and true peak of what reaches the speakers). The limiter is the export's own (shared/previewLimiter.ts, an
// AudioWorklet), so a hot mix clips in neither; `useSettings.previewLimiter`
// takes it out, and until its module has loaded the master goes straight on.
import { useSettings, useEditor, setting } from '../state/store'
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

// ---- K6: the mixer's taps. A track's gain stays in each element's gain (the
// preview sounds as before); what the strip meters is the sum of its elements
// after their gain and pan — one bus per AUDIO track, in front of the master.
/** a stereo peak tap: a splitter into one analyser per channel */
type Tap = [AnalyserNode, AnalyserNode]
let masterTap: Tap | null = null
const buses = new Map<string, { bus: GainNode; tap: Tap }>()
/** where each element's pan goes now: a track id, or '' = straight to the master */
const routedTo = new WeakMap<HTMLMediaElement, string>()
let limiterReduction = 0
/** the playhead where playback last stopped; null = never played */
let meterPausedAt: number | null = null
const peakBuf = new Float32Array(2048)

function tap(c: AudioContext, from: AudioNode): Tap {
  const split = c.createChannelSplitter(2)
  const mk = () => { const a = c.createAnalyser(); a.fftSize = 2048; return a }
  const t: Tap = [mk(), mk()]
  from.connect(split)
  split.connect(t[0], 0)
  split.connect(t[1], 1)
  return t
}

function busFor(trackId: string): GainNode {
  let b = buses.get(trackId)
  if (!b) {
    const c = ensureAudio()
    const bus = c.createGain()
    bus.connect(master!)
    // ponytail: a deleted track's bus stays (a GainNode and two analysers, silent); prune if projects churn tracks
    b = { bus, tap: tap(c, bus) }
    buses.set(trackId, b)
  }
  return b.bus
}

/** K6: send an element into its audio track's bus ('' or a video track: straight to the master) */
export function setElementTrack(el: HTMLMediaElement, trackId: string) {
  const p = pans.get(el)
  if (!p || routedTo.get(el) === trackId) return
  try { p.disconnect() } catch { /* not yet */ }
  p.connect(trackId ? busFor(trackId) : master!)
  routedTo.set(el, trackId)
}

function peaks(t: Tap | null | undefined): [number, number] {
  if (!t) return [0, 0]
  const out: [number, number] = [0, 0]
  for (let ch = 0; ch < 2; ch++) {
    t[ch].getFloatTimeDomainData(peakBuf)
    let m = 0
    for (let i = 0; i < peakBuf.length; i++) { const x = Math.abs(peakBuf[i]); if (x > m) m = x }
    out[ch] = m
  }
  return out
}

/** sample peaks (linear) of the last ~43 ms, L and R: a track's bus after its fader and pan */
export const trackPeaks = (trackId: string): [number, number] => peaks(buses.get(trackId)?.tap)
/** …and of the output, after the limiter (the compact meter, the master strip) */
export const masterPeaks = (): [number, number] => peaks(masterTap)

/** the limiter as the master strip shows it; `reductionDb` ≤ 0 over the last ~100 ms */
export function limiterInfo(): { state: 'on' | 'off' | 'loading' | 'failed'; reductionDb: number } {
  const state = limiterOn() ? 'on' : limiterState === 'ready' ? 'off' : limiterState
  return { state, reductionDb: state === 'on' ? limiterReduction : 0 }
}

export function ensureAudio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = masterLevel
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    analyser.connect(ctx.destination)
    masterTap = tap(ctx, analyser)
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
      if (!useEditor.getState().playing && meterPausedAt !== null) meter.port.postMessage('pause')
      analyser!.connect(meter)
      meter.connect(c.destination)
      limiter.port.onmessage = (e) => { limiterReduction = e.data as number }
      route()
    }).catch((e) => {
      limiterState = 'failed'
      logWarn(tr('lgSound'), tr('lmLimiterFail'), String(e))
    })
    useSettings.subscribe((s, prev) => {
      if (s.previewLimiter !== prev.previewLimiter) route()
      if (s.snap !== prev.snap) applySink()
    })
    // K6 (canvas K, RULES 17): the measurement freezes while paused and starts
    // over when playback starts from a place the playhead was MOVED to — not
    // when it resumes where it stopped, so a stop-and-listen keeps it
    useEditor.subscribe((s, prev) => {
      if (s.playing === prev.playing) return
      if (s.playing) {
        if (meterPausedAt !== null && Math.abs(s.playhead - meterPausedAt) > 1e-6) resetLoudness()
        meter?.port.postMessage('run')
      } else {
        meterPausedAt = s.playhead
        meter?.port.postMessage('pause')
      }
    })
    route()
    applySink()
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

/** the device last asked for; a failed switch leaves the context where it was */
let sinkWanted: string | null = null

/**
 * K7: the output device (`playback.audioOutput`, '' = the system default).
 * One context carries everything the preview plays — elements, the scrub, the
 * popped-out window's canvas included — so one setSinkId moves all of it.
 * Only a CHANGE of the setting is applied: a measurement that parked the
 * output on {type:'none'} keeps it until the user picks a device.
 */
function applySink() {
  const id = String(setting('playback.audioOutput') ?? '')
  const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
  if (!c?.setSinkId || id === sinkWanted) return
  sinkWanted = id
  c.setSinkId(id).catch((e) => logWarn(tr('lgSound'), tr('lmSinkFail'), `${id}: ${String(e)}`))
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
    routedTo.set(el, '')
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
  routedTo.delete(el)
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
