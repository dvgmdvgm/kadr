// K4: the pan law, one place for the preview and the export. The preview pans
// with WebAudio's StereoPannerNode; the export replays that node's stereo
// algorithm (Web Audio API, "StereoPannerNode" processing) as an ffmpeg `pan`
// matrix, or per sample as `aeval` when the pan moves. It is an equal-power
// balance: a channel panned across keeps L² + R², and centre leaves a stereo
// source untouched. A mono source is upmixed to stereo FIRST, at unity on both sides (the mix's
// `pan=stereo|c0=c0|c1=c0`, K10; the panner's explicit 2-channel input), then panned.
import type { GainKey } from './gainKeys'
import { gainExpr } from './gainKeys'

export const clampPan = (p: number): number => (Number.isFinite(p) ? Math.max(-1, Math.min(1, p)) : 0)

/**
 * The node's stereo algorithm as a matrix [ll, rl, lr, rr]:
 * outL = ll·inL + rl·inR, outR = lr·inL + rr·inR.
 */
export function panMatrix(pan: number): [number, number, number, number] {
  const p = clampPan(pan)
  const x = (p <= 0 ? p + 1 : p) * Math.PI / 2
  // cos(π/2) is 6e-17, not 0: centre and the hard edges are exact here
  const gl = p === 0 || p === 1 ? 0 : Math.cos(x)
  const gr = p === -1 ? 0 : p === 0 ? 1 : Math.sin(x)
  return p <= 0 ? [1, gl, 0, gr] : [gl, 0, gr, 1]
}

/** the preview's panner: a mono input is upmixed to two channels before the law */
export const PANNER_OPTIONS = {
  channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
} as const

const n = (x: number) => String(+x.toFixed(9))

/** the export's filter for a pan that does not move */
export function panFilter(pan: number): string {
  const [ll, rl, lr, rr] = panMatrix(pan)
  return `pan=stereo|c0=${n(ll)}*c0+${n(rl)}*c1|c1=${n(lr)}*c0+${n(rr)}*c1`
}

/**
 * The export's filter for a keyframed pan: the same law per sample, `t` in
 * seconds from the segment's first sample (the caller recounts pts first).
 * ponytail: aeval evaluates per sample (~10× slower than `pan`); a moving pan is rare.
 */
export function panEvalFilter(keys: GainKey[]): string {
  const p = `st(0,max(-1,min(1,${gainExpr(keys)})))`
  const x = 'if(lte(ld(0),0),ld(0)+1,ld(0))*PI/2'
  const l = `${p};if(lte(ld(0),0),val(0)+val(1)*cos(${x}),val(0)*cos(${x}))`
  const r = `${p};if(lte(ld(0),0),val(1)*sin(${x}),val(1)+val(0)*sin(${x}))`
  return `aeval=exprs='${l}|${r}':c=same`
}
