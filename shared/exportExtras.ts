// The export's extras (G7): subtitles and chapters moved into the export range,
// their text formats, the ffmetadata file the muxer reads, and the YouTube list.
// Pure — the muxer (electron/ffmpeg.ts), the exporter and the dialog share it.
import type { SubCue, TimelineMarker } from './types'

export interface Chapter { start: number; end: number; title: string }

export interface ExportExtras {
  /** the file's title tag; empty = none */
  title?: string
  /** export-time chapters (chaptersInRange) */
  chapters?: Chapter[]
  /** export-time cues (cuesInRange) */
  cues?: SubCue[]
  /** write `<name>.srt` / `<name>.vtt` next to the file */
  sidecar?: 'srt' | 'vtt'
  /** a mov_text track inside an mp4 / mov */
  embedSubs?: boolean
}

/** Containers that take a mov_text track. */
export const embedsSubs = (container: string) => container === 'mp4' || container === 'mov'

/** Cues overlapping [start, end), clipped to it and moved to start at 0. */
export function cuesInRange(cues: SubCue[], start: number, end: number): SubCue[] {
  return cues
    .filter((c) => c.end > start && c.start < end)
    .map((c) => ({ start: Math.max(c.start, start) - start, end: Math.min(c.end, end) - start, text: c.text }))
}

/**
 * Chapters of the export [start, end): each mark opens one that runs to the next.
 * The chapter the range opens inside keeps its title from 0; with no mark before
 * the range the first is `lead` (YouTube wants the first at 00:00).
 */
export function chaptersInRange(marks: { time: number; title: string }[], start: number, end: number, lead: string): Chapter[] {
  const sorted = [...marks].sort((a, b) => a.time - b.time)
  const inside = sorted.filter((m) => m.time >= start && m.time < end)
  if (!inside.length && !sorted.some((m) => m.time < start)) return []
  const opens = inside.length && inside[0].time === start ? [] : [{ time: start, title: sorted.filter((m) => m.time < start).pop()?.title ?? lead }]
  const all = [...opens, ...inside]
  return all.map((m, i) => ({ start: m.time - start, end: (all[i + 1]?.time ?? end) - start, title: m.title }))
}

/** Which markers make chapters: the user's own, or the song's parts. */
export function chapterMarks(markers: TimelineMarker[], kind: 'markers' | 'sections'): { time: number; title: string }[] {
  const pick = markers.filter((m) => kind === 'sections' ? m.kind === 'section' : !m.kind).sort((a, b) => a.time - b.time)
  return pick.map((m, i) => ({ time: m.time, title: m.label || m.section || String(i + 1) }))
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function clock(t: number, sep: string): string {
  const ms = Math.max(0, Math.round(t * 1000))
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`
}
export const srtTime = (t: number) => clock(t, ',')

export function cuesToSrt(cues: SubCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.trim()}\n`).join('\n')
}

export function cuesToVtt(cues: SubCue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.text.trim()}\n`).join('\n')
}

// ffmetadata: `=`, `;`, `#`, `\` and newlines are escaped with a backslash
const esc = (s: string) => s.replace(/[=;#\\\n]/g, (c) => '\\' + c)

export function ffmetadata({ title, chapters }: { title?: string; chapters?: Chapter[] }): string {
  return ';FFMETADATA1\n' + (title ? `title=${esc(title)}\n` : '') + (chapters ?? []).map((c) =>
    `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${esc(c.title)}\n`).join('')
}

/** «00:00 Title» lines for a video description. */
export function youtubeChapters(chapters: Chapter[]): string {
  const at = (t: number) => {
    const s = Math.floor(t)
    const h = Math.floor(s / 3600)
    return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
  }
  return chapters.map((c) => `${at(c.start)} ${c.title}`).join('\n')
}

/** What YouTube would refuse (the first at 00:00 is chaptersInRange's own rule): fewer than 3, one under 10 s. */
export function youtubeProblems(chapters: Chapter[]): ('count' | 'short')[] {
  const p: ('count' | 'short')[] = []
  if (chapters.length < 3) p.push('count')
  if (chapters.some((c) => c.end - c.start < 10)) p.push('short')
  return p
}
