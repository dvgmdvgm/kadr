// What kadr_state returns (card I3). A whole-project dump outgrew what one tool
// reply can carry and used to be cut mid-JSON at 4 MB, so the agent read a
// corrupt picture of a big edit. Now: a summary by default, and exact slices
// (tracks, a time range, named fields) that are never cut — a slice that is
// still too big is refused with a narrower one to ask for.
import type { Clip, Project, TimelineMarker, Track } from '@shared/types'
import { projectDuration } from '../state/store'

/** a reply larger than this is refused, not cut (chars of compact JSON) */
export const STATE_BUDGET = 100_000
/** selection ids the summary lists before it only counts */
const SUMMARY_SELECTION = 100

/** what the page hands over: the project with its asset blobs already stripped */
export interface StateSource {
  project: Project
  projectPath: string | null
  selection: string[]
  playhead: number
  range: { start: number; end: number } | null
  exportPresets: unknown[]
  voiceDefects: Array<{ timeline: [number, number] } & Record<string, unknown>>
}

export interface StateArgs {
  /** track ids or names — those tracks whole (clipped to `range` when given) */
  tracks?: string[]
  /** project seconds: clips overlapping it; markers and voice defects in it */
  range?: { start: number; end: number }
  /** sections to include; with tracks/range, `assets` are those the sliced clips use */
  fields?: StateField[]
}

export const STATE_FIELDS = ['meta', 'tracks', 'assets', 'bins', 'texts', 'markers', 'voiceRuns',
  'defects', 'claudeChats', 'selection', 'voiceDefects', 'exportPresets'] as const
export type StateField = typeof STATE_FIELDS[number]
/** project keys that are not `meta`: each is a field of the same name */
const PROJECT_FIELDS = new Set(['tracks', 'assets', 'bins', 'texts', 'markers', 'voiceRuns', 'defects', 'claudeChats'])

const overlaps = (a0: number, a1: number, r: { start: number; end: number }) => a0 < r.end && a1 > r.start
const markerIn = (m: TimelineMarker, r: { start: number; end: number }) =>
  m.end != null ? overlaps(m.time, m.end, r) : m.time >= r.start && m.time < r.end

function summary(src: StateSource) {
  const p = src.project
  const markers: Record<string, number> = {}
  for (const m of p.markers ?? []) markers[m.kind ?? 'user'] = (markers[m.kind ?? 'user'] ?? 0) + 1
  return {
    project: { id: p.id, name: p.name, width: p.width, height: p.height, fps: p.fps, duration: projectDuration(p) },
    projectPath: src.projectPath,
    playhead: src.playhead,
    range: src.range,
    selection: src.selection.slice(0, SUMMARY_SELECTION),
    selectionCount: src.selection.length,
    tracks: p.tracks.map((t) => ({
      id: t.id, kind: t.kind, name: t.name, clips: t.clips.length,
      from: t.clips.length ? Math.min(...t.clips.map((c) => c.start)) : null,
      to: t.clips.length ? Math.max(...t.clips.map((c) => c.start + c.duration)) : null,
      muted: t.muted, locked: t.locked, ...(t.solo ? { solo: true } : {})
    })),
    counts: {
      assets: p.assets.length, bins: p.bins?.length ?? 0, texts: p.texts?.length ?? 0, markers,
      voiceRuns: p.voiceRuns?.length ?? 0, voiceDefects: src.voiceDefects.length,
      exportPresets: src.exportPresets.length
    },
    more: 'summary only — pass tracks (ids or names), range {start,end} and/or fields ' +
      `(${STATE_FIELDS.join(', ')}) for the details`
  }
}

/** kadr_state's reply: the summary with no args, else exactly the slice asked for. Throws when it is over STATE_BUDGET. */
export function sliceState(src: StateSource, args: StateArgs = {}): unknown {
  const p = src.project
  const { tracks: names, range, fields } = args
  if (!names && !range && !fields) return fit(summary(src), src, args)
  if (range && !(range.end > range.start)) throw new Error('range: end must be after start')
  let tracks: Track[] | undefined
  if (names || range) {
    const picked = names
      ? names.map((n) => {
          const t = p.tracks.find((x) => x.id === n) ?? p.tracks.find((x) => x.name === n)
          if (!t) throw new Error(`no track "${n}"; tracks: ${p.tracks.map((x) => `${x.name} (${x.id})`).join(', ')}`)
          return t
        })
      : p.tracks
    tracks = range
      ? picked.map((t) => ({ ...t, clips: t.clips.filter((c) => overlaps(c.start, c.start + c.duration, range)) }))
      : picked
  }
  // tracks/range alone mean the clips; fields add sections (or narrow to them)
  const want = new Set<StateField>(fields ?? ['tracks'])
  if (tracks) want.add('tracks')
  const out: Record<string, unknown> = {}
  for (const f of want) {
    if (f === 'meta') {
      for (const [k, v] of Object.entries(p)) if (!PROJECT_FIELDS.has(k)) out[k] = v
      out.projectPath = src.projectPath
    } else if (f === 'tracks') out.tracks = tracks ?? p.tracks
    else if (f === 'assets') {
      const used = tracks && new Set(tracks.flatMap((t) => t.clips.map((c: Clip) => c.assetId)))
      out.assets = used ? p.assets.filter((a) => used.has(a.id)) : p.assets
    } else if (f === 'markers') out.markers = range ? (p.markers ?? []).filter((m) => markerIn(m, range)) : p.markers ?? []
    else if (f === 'voiceDefects') out.voiceDefects = range ? src.voiceDefects.filter((d) => overlaps(d.timeline[0], d.timeline[1], range)) : src.voiceDefects
    else if (f === 'selection') out.selection = src.selection
    else if (f === 'exportPresets') out.exportPresets = src.exportPresets
    else out[f] = (p as unknown as Record<string, unknown>)[f] ?? []
  }
  return fit(out, src, args)
}

/** refuse, never cut: name the size and a slice that would fit */
function fit(reply: unknown, src: StateSource, args: StateArgs): unknown {
  const size = JSON.stringify(reply).length
  if (size <= STATE_BUDGET) return reply
  const p = src.project
  const perTrack = p.tracks
    .map((t) => `${t.name} (${t.id}) ${t.clips.length} clips ≈${Math.round(JSON.stringify(t).length / 1000)} KB`)
    .join('; ')
  const span = args.range ?? { start: 0, end: projectDuration(p) }
  const len = Math.max(1, Math.floor((span.end - span.start) * STATE_BUDGET / size / 2))
  throw new Error(`kadr_state: this reply is ${Math.round(size / 1000)} KB, over the ${STATE_BUDGET / 1000} KB ` +
    `a reply may carry, and is never cut — ask for less: fewer tracks, a shorter range (about ${len} s, ` +
    `e.g. range {start: ${span.start}, end: ${span.start + len}}) or fewer fields. Tracks: ${perTrack}`)
}
