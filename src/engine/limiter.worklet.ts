// AudioWorklets of the preview's master: the limiter — the export's alimiter,
// ported in shared/previewLimiter.ts — and the loudness meter after it
// (shared/loudness.ts, K3). Loaded by src/engine/audio.ts through vite's
// `?worker&url`, so the shared modules are bundled in.
import { createLimiter } from '@shared/previewLimiter'
import { createLoudnessMeter } from '@shared/loudness'

// the AudioWorkletGlobalScope, which lib.dom does not describe
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor { readonly port: MessagePort }

/** posts the gain reduction (dB, ≤ 0) of the last ~100 ms — the master strip's «Лимитер −2.1 dB» (K6) */
class KadrLimiter extends AudioWorkletProcessor {
  private lim = createLimiter(sampleRate, 2)
  private every = Math.round(sampleRate / 128 / 10)
  private n = 0
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    // no input connected = silence in; the look-ahead still drains
    if (out.length) this.lim.process(inputs[0] ?? [], out, out[0].length)
    if (++this.n >= this.every) { this.n = 0; this.port.postMessage(20 * Math.log10(this.lim.takeMinGain())) }
    return true
  }
}

registerProcessor('kadr-limiter', KadrLimiter)

/** measures what it is fed, outputs nothing; posts a reading every ~100 ms and
 *  takes 'reset' (a new integration), 'pause' and 'run'. Paused, nothing is
 *  fed: the filter's tail no longer drifts the integrated value after a stop
 *  (−18.60 → −18.67 in 3 s, canvas K BREAKS 6), M and S read −∞, I and TP hold. */
class KadrLoudness extends AudioWorkletProcessor {
  private meter = createLoudnessMeter(sampleRate, 2)
  private every = Math.round(sampleRate / 128 / 10)
  private n = 0
  private paused = false
  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'reset') this.meter.reset()
      else if (e.data === 'pause' || e.data === 'run') this.paused = e.data === 'pause'
    }
  }
  process(inputs: Float32Array[][]): boolean {
    const inp = inputs[0] ?? []
    if (inp.length && !this.paused) this.meter.process(inp, inp[0].length)
    if (++this.n >= this.every) {
      this.n = 0
      const r = this.meter.read()
      this.port.postMessage(this.paused ? { ...r, momentary: -Infinity, shortTerm: -Infinity } : r)
    }
    return true
  }
}

registerProcessor('kadr-loudness', KadrLoudness)

declare const currentFrame: number

/** K8: a microphone take. Mono in (the node down-mixes), outputs silence (it is
 *  pulled only while it reaches the destination); posts `{ frame }` with the
 *  context frame of its first sample, then Float32Array chunks of ~0.1 s, and
 *  `'done'` after the last one once told 'stop'. */
class KadrCapture extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.round(sampleRate / 10))
  private n = 0
  private started = false
  private stopped = false
  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => { if (e.data === 'stop') this.stopped = true }
  }
  private flush() {
    if (!this.n) return
    const chunk = this.buf.slice(0, this.n)
    this.port.postMessage(chunk, [chunk.buffer])
    this.n = 0
  }
  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) { this.flush(); this.port.postMessage('done'); return false }
    const ch = inputs[0]?.[0]
    if (!ch) return true
    if (!this.started) { this.started = true; this.port.postMessage({ frame: currentFrame }) }
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) this.flush()
    }
    return true
  }
}

registerProcessor('kadr-capture', KadrCapture)
