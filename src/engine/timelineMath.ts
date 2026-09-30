// Pure timeline maths, kept apart from the component so it can be checked in
// plain node (scripts/check-timeline.mjs): the waveform's per-pixel peaks and
// the overlap zones of a track. Both were rewritten for speed on a 1124-clip,
// 19-minute project, and both must give EXACTLY what the old, slow code gave.
import type { Clip } from '@shared/types'

/** A waveform as the timeline draws it: peak and RMS bins (0..255) at `rate` per second. */
export interface WaveBins {
  rate: number
  max: Uint8Array
  rms: Uint8Array
  /** window k: w[i] = the max of bins [i, i + 2^k) (clipped at the end), made
      on demand. Zoomed out, one pixel spans hundreds of bins (a quarter second
      at 1000 bins/s), and scanning them all for every pixel of every visible
      clip made a zoom step cost ~275 ms on an 1100-clip project; with one
      window, a pixel's range [a, b) is max(w[a], w[b − 2^k]) — the SAME value
      as the scan. (A pyramid of merged bins was tried first and rejected: it
      widened a lone click onto the neighbouring pixel in half the columns.) */
  windows: Map<number, { max: Uint8Array; rms: Uint8Array }>
}

/** the sliding-window maxima of width 2^k (see WaveBins.windows); a few kept per waveform */
export function waveWindow(wf: WaveBins, k: number): { max: Uint8Array; rms: Uint8Array } {
  const hit = wf.windows.get(k)
  if (hit) {
    wf.windows.delete(k) // most recently used last
    wf.windows.set(k, hit)
    return hit
  }
  const n = wf.max.length
  const max = wf.max.slice()
  const rms = wf.rms.slice()
  // doubling in place: before pass j every entry covers 2^(j-1) bins; reading a
  // HIGHER index while walking upwards still sees the previous pass's value
  for (let h = 1; h < 1 << k; h *= 2) {
    for (let i = 0; i < n; i++) {
      const o = Math.min(i + h, n - 1)
      if (max[o] > max[i]) max[i] = max[o]
      if (rms[o] > rms[i]) rms[i] = rms[o]
    }
  }
  wf.windows.set(k, { max, rms })
  if (wf.windows.size > 3) wf.windows.delete(wf.windows.keys().next().value!)
  return { max, rms }
}

/**
 * The peak and RMS of every device pixel column `x` in [0, cw) of a clip's
 * visible slice: the column covers the source from its own time for one
 * pixel's worth of source (`speed / (zoom · dpr)` seconds), looping the source
 * after `span` seconds. `vis0` = the slice's left edge, clip-local CSS px.
 */
export function waveColumns(wf: WaveBins, o: {
  cw: number; vis0: number; dpr: number; zoom: number; speed: number; inPoint: number; span: number
}): { peak: Uint8Array; rms: Uint8Array } {
  const peakOut = new Uint8Array(o.cw)
  const rmsOut = new Uint8Array(o.cw)
  const srcPerPx = o.speed / (o.zoom * o.dpr)
  const n = wf.max.length
  // Two windows of 2^k cover a range of L bins exactly when 2^k ≤ L < 2^(k+1),
  // so k is taken per pixel from ITS range: neighbouring pixels differ by a bin
  // or two (floor/ceil), and one k for all left the middle bin of the longer
  // ranges uncovered (8 columns in 688 773 read one unit low — caught by
  // scripts/check-timeline.mjs). At most two adjacent k per drawing.
  const wins: ({ max: Uint8Array; rms: Uint8Array } | undefined)[] = []
  for (let x = 0; x < o.cw; x++) {
    const localT = (o.vis0 + x / o.dpr) / o.zoom
    const srcT = o.inPoint + ((localT * o.speed) % o.span)
    const i0 = Math.floor(srcT * wf.rate)
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((srcT + srcPerPx) * wf.rate)))
    let peak = 0
    let rms = 0
    const len = i1 - i0
    const k = len >= 2 ? 31 - Math.clz32(len) : 0 // floor(log2(len))
    if (k > 0) {
      const win = (wins[k] ??= waveWindow(wf, k))
      const j = i1 - (1 << k)
      peak = Math.max(win.max[i0], win.max[j])
      rms = Math.max(win.rms[i0], win.rms[j])
    } else {
      for (let i = i0; i < i1; i++) {
        if (wf.max[i] > peak) peak = wf.max[i]
        if (wf.rms[i] > rms) rms = wf.rms[i]
      }
    }
    peakOut[x] = peak
    rmsOut[x] = rms
  }
  return { peak: peakOut, rms: rmsOut }
}

/** Overlap zones and butt joints of a track's clips — one sweep over the
    clips sorted by start (it was every pair: 136 000 comparisons per render on
    a 522-clip track, on every zoom step). Same result: a zone runs from a
    clip's start to the furthest end of the clips that started STRICTLY before
    it, capped at its own end. */
export function trackOverlaps(clips: Clip[]) {
  const zones: { clip: Clip; from: number; to: number }[] = []
  const joints: { a: Clip; b: Clip; at: number }[] = []
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  let before = -Infinity // max end over clips with a smaller start
  let groupStart = NaN
  let groupEnd = -Infinity // max end within the run of equal starts
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]
    if (b.start !== groupStart) {
      before = Math.max(before, groupEnd)
      groupStart = b.start
      groupEnd = -Infinity
    }
    if (i > 0) {
      const coverEnd = before > b.start ? before : 0
      const to = Math.min(coverEnd, b.start + b.duration)
      if (to > b.start + 1e-6) zones.push({ clip: b, from: b.start, to })
      // butt joint: the previous clip ends exactly where this one starts
      const a = sorted[i - 1]
      if (Math.abs(a.start + a.duration - b.start) < 0.02) joints.push({ a, b, at: b.start })
    }
    groupEnd = Math.max(groupEnd, b.start + b.duration)
  }
  return { zones, joints }
}

/** `t` on the nearest frame boundary (or the one below/above with Math.floor /
    Math.ceil). A fractional rate is the NTSC rational — 29.97 is 30000/1001,
    so its frames sit at k·1001/30000, not at k/29.97. The 1e-6 nudge keeps a
    time already on a frame from dropping one below it under floor. */
export function toFrame(t: number, fps: number, snap: (x: number) => number = Math.round): number {
  if (!(fps > 0) || !Number.isFinite(t)) return t
  const r = frameRate(fps)
  const x = t * r
  return snap(snap === Math.floor ? x + 1e-6 : snap === Math.ceil ? x - 1e-6 : x) / r
}

/** frames per second as the frames really sit: 29.97 → 30000/1001 */
function frameRate(fps: number): number {
  const ntsc = Math.round(fps * 1.001)
  return fps % 1 && Math.abs(fps * 1.001 - ntsc) < 0.01 ? ntsc / 1.001 : fps
}

/** `hh:mm:ss.ff` — the transport's timecode (real seconds, then the frame within
    the second). The 1e-7 s nudge keeps a time on a frame from showing the one
    before it (1.4 s at 30 fps is 1.3999…, which read «01.11»). */
export function formatTime(t: number, fps: number): string {
  const sign = t < 0 ? '-' : ''
  t = Math.abs(t) + 1e-7
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const f = Math.floor((t % 1) * frameRate(fps))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`
}

/**
 * What the go-to-timecode field typed means, as a playhead time on a frame
 * (null = not a timecode). Absolute: `hh:mm:ss:ff`, `mm:ss:ff`, `ss:ff`,
 * `ss.ff` (any `:`/`.` mix, so the display's own `hh:mm:ss.ff` reads back),
 * bare `ss`, `1.5s`, `90f`. A leading + or − makes it relative to `current`.
 * An absolute timecode names the frame the display calls that — the first
 * frame at or after it, since `formatTime` floors.
 */
export function parseTimecode(text: string, fps: number, current: number): number | null {
  const m = /^([+-]?)(?:(\d+(?:\.\d+)?)s|(\d+)f|(\d+(?:[:.]\d+){0,3}))$/.exec(text.trim())
  if (!m) return null
  const [, sign, secs, frames, tc] = m
  let v: number
  if (secs !== undefined) v = Number(secs)
  else if (frames !== undefined) v = toFrame(Number(frames) / frameRate(fps), fps)
  else {
    const n = tc.split(/[:.]/).map(Number)
    if (n.length === 1) v = n[0]
    else {
      const ff = n.pop()!
      if (ff >= Math.round(fps)) return null
      v = n.reduce((acc, x) => acc * 60 + x, 0) + ff / frameRate(fps)
    }
  }
  const t = sign ? toFrame(current + (sign === '-' ? -v : v), fps) : toFrame(v, fps, Math.ceil)
  return Math.max(0, t)
}

/** The next (dir 1) or previous (dir −1) clip edge on the unlocked tracks, 0 included; null when none. */
export function nextEdit(tracks: { locked?: boolean; clips: { start: number; duration: number }[] }[],
  t: number, dir: 1 | -1): number | null {
  let best: number | null = dir < 0 && t > 1e-6 ? 0 : null
  for (const tr of tracks) {
    if (tr.locked) continue
    for (const c of tr.clips) for (const x of [c.start, c.start + c.duration]) {
      if (dir > 0 ? x > t + 1e-6 && (best === null || x < best) : x < t - 1e-6 && (best === null || x > best)) best = x
    }
  }
  return best
}

/** The playback clock's anchor: the playhead `t` at rAF time `ts`, moving at `rate` (signed). */
export interface ClockAnchor { ts: number; t: number; rate: number }

/** Where the playhead is at `ts`. Inside [lo, hi] it runs at the anchor's rate;
    past the edge it wraps (loop) with the overshoot carried over — seamless — or
    stops on the edge. A loop started outside its span jumps to its start (end in
    reverse). On `wrapped` the caller re-anchors at {ts, t}. */
export function advanceClock(a: ClockAnchor, ts: number, lo: number, hi: number, loop: boolean):
  { t: number; stop: boolean; wrapped: boolean } {
  const t = a.t + (a.rate * (ts - a.ts)) / 1000
  const fwd = a.rate > 0
  const outside = fwd ? a.t >= hi || a.t < lo : a.t <= lo || a.t > hi
  if (!(loop && outside) && (fwd ? t < hi : t > lo)) return { t, stop: false, wrapped: false }
  const span = hi - lo
  if (!loop || !(span > 0)) return { t: fwd ? hi : lo, stop: true, wrapped: false }
  const over = (outside ? Math.abs(t - a.t) : fwd ? t - hi : lo - t) % span
  return { t: fwd ? lo + over : hi - over, stop: false, wrapped: true }
}

/** px/s bounds of the timeline zoom; the floor fits an hour on one screen (Shift+Z) */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4000
/** px left free on both sides of a span fitted with Shift+Z / Alt+Z */
export const FIT_MARGIN = 24

/** The zoom and the time at the lanes' left edge that show [a, b] in `lanes` px
    plus FIT_MARGIN on each side (none before 0, where the view cannot go);
    a span too short for MAX_ZOOM is centred. */
export function fitZoom(a: number, b: number, lanes: number): { zoom: number; t0: number } | null {
  if (!(b > a) || !(lanes > 2 * FIT_MARGIN)) return null
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (lanes - 2 * FIT_MARGIN) / (b - a)))
  const t0 = (a + b) / 2 - lanes / 2 / zoom
  if (t0 >= 0) return { zoom, t0 }
  // the view cannot start before 0: the span starts at the lanes' edge, margin on the right only
  return { zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (lanes - FIT_MARGIN) / b)), t0: 0 }
}

export type FollowMode = 'off' | 'page' | 'smooth'
/** px of the old page kept in view after a page turn */
const PAGE_KEEP = 24

/** Playback follow: the new scrollLeft for a playhead at `x` px (lanes coords)
    in a view [left, left + lanes), heading the way `rate` says — or null when
    the view stays. 'page' turns a page once the playhead leaves the side it is
    heading to; 'smooth' holds it at the centre once it gets there. */
export function followLeft(mode: FollowMode, x: number, left: number, lanes: number, rate: number): number | null {
  if (mode === 'off' || !(lanes > 0)) return null
  const fwd = rate >= 0
  let want: number
  if (mode === 'smooth') want = x - lanes / 2
  else if (x < left || x >= left + lanes) want = fwd ? x - PAGE_KEEP : x - lanes + PAGE_KEEP
  else return null
  if (mode === 'smooth' && (fwd ? want <= left : want >= left) && x >= left && x < left + lanes) return null
  want = Math.max(0, want)
  return Math.abs(want - left) < 0.5 ? null : want
}
