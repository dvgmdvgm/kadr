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

class KadrLimiter extends AudioWorkletProcessor {
  private lim = createLimiter(sampleRate, 2)
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    // no input connected = silence in; the look-ahead still drains
    if (out.length) this.lim.process(inputs[0] ?? [], out, out[0].length)
    return true
  }
}

registerProcessor('kadr-limiter', KadrLimiter)

/** measures what it is fed, outputs nothing; posts a reading every ~100 ms and
 *  takes 'reset' (a new integration) */
class KadrLoudness extends AudioWorkletProcessor {
  private meter = createLoudnessMeter(sampleRate, 2)
  private every = Math.round(sampleRate / 128 / 10)
  private n = 0
  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => { if (e.data === 'reset') this.meter.reset() }
  }
  process(inputs: Float32Array[][]): boolean {
    const inp = inputs[0] ?? []
    if (inp.length) this.meter.process(inp, inp[0].length)
    if (++this.n >= this.every) { this.n = 0; this.port.postMessage(this.meter.read()) }
    return true
  }
}

registerProcessor('kadr-loudness', KadrLoudness)
