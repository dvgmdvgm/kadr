// K8: where a microphone take lands. The capture runs from before the pre-roll
// and the file keeps all of it; the clip starts at the record point and its
// inPoint skips to the sample spoken while the picture showed that point.
// Pure — scripts/check-record-place.mjs drives it.
//
// Two clocks meet here: the player's (timeline seconds, rAF-anchored) and the
// AudioContext's (the capture worklet counts its frames on it). While recording,
// every playhead update is paired with `ctx.currentTime`; their difference is
// constant at rate 1, and the median shrugs off the device's callback jitter.

/** timeline − context seconds, from (playhead, ctx.currentTime) readings; NaN with none */
export function clockOffset(pairs: Array<[number, number]>): number {
  if (!pairs.length) return NaN
  const d = pairs.map(([tl, c]) => tl - c).sort((a, b) => a - b)
  const m = d.length >> 1
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2
}

export interface TakeIn {
  /** the timeline second the take starts at (the playhead, or the range's start) */
  at: number
  /** the context frame of the file's first sample */
  startFrame: number
  sampleRate: number
  /** clockOffset() of the run */
  offset: number
  /** seconds the input arrives late: the device's own latency plus the user's offset */
  latency: number
  /** samples in the file */
  frames: number
  /** the timeline second recording stopped at (or the range's end) */
  end: number
}

/** the clip: start, inPoint into the file, duration — null when nothing was recorded past `at` */
export function placeTake(o: TakeIn): { start: number; inPoint: number; duration: number } | null {
  // context time the picture showed `at`, then where that moment's voice sits in the file
  const inPoint = Math.max(0, o.at - o.offset - o.startFrame / o.sampleRate + o.latency)
  const duration = Math.min(o.end - o.at, o.frames / o.sampleRate - inPoint)
  if (!(duration > 0.05)) return null
  return { start: o.at, inPoint, duration }
}
