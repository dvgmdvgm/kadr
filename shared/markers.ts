// L1: where the user's markers are — the timeline's own and the clips' — for
// the list, the next/previous keys and the clip's flags. Pure; tested by
// scripts/check-markers.mjs.
import type { Clip, Project } from './types'
import { relAtOffset } from './speedRamp'

/** A clip marker's place on the timeline: its source second through the
    clip's in point and speed (a ramp's integral), or null when the clip does not show it (trimmed
    off, or a freeze frame). The first pass only — a looped tail does not repeat it. */
export function clipMarkerTime(clip: Clip, source: number): number | null {
  if (!Number.isFinite(source) || clip.freezeAt !== undefined) return null
  const rel = relAtOffset(clip, source - clip.inPoint)
  return rel >= -1e-9 && rel <= clip.duration + 1e-9 ? clip.start + rel : null
}

export interface MarkerRow {
  id: string
  /** set for a clip marker */
  clipId?: string
  /** project seconds */
  time: number
  label: string
  note?: string
  color?: number
}

/** The user's own timeline markers and every shown clip marker, in time order
    (the analysis' beats, sections, pauses and scenes are not the user's). */
export function markerRows(p: Project): MarkerRow[] {
  const rows: MarkerRow[] = (p.markers ?? []).filter((m) => !m.kind)
    .map((m) => ({ id: m.id, time: m.time, label: m.label, note: m.note, color: m.color }))
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      for (const m of c.markers ?? []) {
        const time = clipMarkerTime(c, m.source)
        if (time !== null) rows.push({ id: m.id, clipId: c.id, time, label: m.label, note: m.note, color: m.color })
      }
    }
  }
  return rows.sort((a, b) => a.time - b.time)
}

/** The nearest marker strictly after (dir 1) or before (dir −1) `t`; null when there is none. */
export function nextMarkerTime(p: Project, t: number, dir: 1 | -1): number | null {
  const eps = 1e-6
  let best: number | null = null
  for (const r of markerRows(p)) {
    if (dir > 0 ? r.time > t + eps && (best === null || r.time < best) : r.time < t - eps && (best === null || r.time > best)) best = r.time
  }
  return best
}
