// L5: three-point editing — given what is marked in the source and on the
// timeline, the fourth point. Pure; scripts/check-three-point.mjs drives it.
//
// The source side: an in and/or an out (none = the whole file). The timeline
// side: the range (I/O on the timeline) or the playhead.
//   * both source marks → the length is the source's; it lands at the range's
//     in, or at the playhead;
//   * otherwise, with a timeline range → the length is the range's; the source
//     starts at its in, or ends at its out (backtimed), or starts at 0;
//   * otherwise → from the in (or 0) to the out (or the end), at the playhead.
// The length never reaches past the source: what the file has is what lands.

export interface ThreePointInput {
  /** the source's length, s (a still: its default duration) */
  srcDur: number
  srcIn?: number | null
  srcOut?: number | null
  playhead: number
  range?: { start: number; end: number } | null
}

export interface ThreePoint {
  /** source second the edit starts from */
  srcIn: number
  /** timeline second the edit lands at */
  at: number
  /** seconds edited, on both sides */
  len: number
}

export function resolveThreePoint(i: ThreePointInput): ThreePoint {
  const dur = Math.max(0, i.srcDur)
  const clamp = (t: number) => Math.min(dur, Math.max(0, t))
  const sIn = i.srcIn == null ? null : clamp(i.srcIn)
  const sOut = i.srcOut == null ? null : clamp(i.srcOut)
  const r = i.range && i.range.end > i.range.start ? i.range : null
  const at = Math.max(0, r ? r.start : i.playhead)
  let from: number
  let len: number
  if (sIn !== null && sOut !== null) {
    from = Math.min(sIn, sOut)
    len = Math.abs(sOut - sIn)
  } else if (r) {
    len = r.end - r.start
    from = sIn !== null ? sIn : sOut !== null ? Math.max(0, sOut - len) : 0
    if (sIn === null && sOut !== null) len = Math.min(len, sOut - from)
  } else {
    from = sIn ?? 0
    len = (sOut ?? dur) - from
  }
  len = Math.max(0, Math.min(len, dur - from))
  return { srcIn: from, at, len }
}
