// L6: the timelines of a project. The OPEN one keeps its tracks in
// `project.tracks` — every editing and render path reads that field and keeps
// working — and the others keep theirs in `project.timelines[i].tracks`.
// A project without `timelines` is one timeline, as every project was before.
import type { Clip, Project, Timeline, Track } from './types'

/** the id an old project's single timeline gets when a second one appears */
export const MAIN_TIMELINE = 'main'
/** how deep compound clips may nest; deeper ones draw nothing */
export const MAX_NEST_DEPTH = 8

export const isCompound = (c: Clip): boolean => c.kind === 'timeline'

/** every timeline, the open one first if the list is absent */
export function timelinesOf(p: Project): Timeline[] {
  return p.timelines?.length ? p.timelines : [{ id: p.activeTimeline ?? MAIN_TIMELINE, name: '' }]
}

export function activeTimelineId(p: Project): string {
  return p.activeTimeline ?? timelinesOf(p)[0].id
}

/** the tracks of timeline `id` (the open one's are project.tracks); null when there is none */
export function timelineTracks(p: Project, id: string): Track[] | null {
  if (id === activeTimelineId(p)) return p.tracks
  return p.timelines?.find((t) => t.id === id)?.tracks ?? null
}

/** the tracks of EVERY timeline — for what is project-wide: sources used, paths, removals */
export function allTracks(p: Project): Track[] {
  const act = activeTimelineId(p)
  return [...p.tracks, ...(p.timelines ?? []).flatMap((t) => (t.id === act ? [] : t.tracks ?? []))]
}

/** the end of timeline `id`, in its own seconds */
export function timelineDuration(p: Project, id: string): number {
  let end = 0
  for (const t of timelineTracks(p, id) ?? []) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

/** Would a clip of timeline `ref` inside timeline `host` close a loop? True when
    `ref` is `host` or contains it, at any depth. */
export function nestsInto(p: Project, host: string, ref: string): boolean {
  const seen = new Set<string>()
  const walk = (id: string): boolean => {
    if (id === host) return true
    if (seen.has(id)) return false
    seen.add(id)
    for (const t of timelineTracks(p, id) ?? []) {
      for (const c of t.clips) if (isCompound(c) && c.timelineId && walk(c.timelineId)) return true
    }
    return false
  }
  return walk(ref)
}

/** Load-time healing (sanitizeProject): junk and duplicate entries go, the open
    one exists and holds no tracks of its own, every other one has a list.
    Nothing here drops a clip. */
export function healTimelines(p: Project): void {
  if (p.timelines === undefined) {
    if (typeof p.activeTimeline !== 'string') delete p.activeTimeline
    return
  }
  const seen = new Set<string>()
  p.timelines = (Array.isArray(p.timelines) ? p.timelines : []).filter((t) => {
    if (!t || typeof t.id !== 'string' || !t.id || seen.has(t.id)) return false
    seen.add(t.id)
    if (typeof t.name !== 'string') t.name = ''
    if (!Array.isArray(t.tracks)) delete t.tracks
    return true
  })
  if (!p.timelines.length) {
    delete p.timelines
    delete p.activeTimeline
    return
  }
  if (!p.activeTimeline || !seen.has(p.activeTimeline)) p.activeTimeline = p.timelines[0].id
  const extra: Timeline[] = []
  for (const t of p.timelines) {
    if (t.id === p.activeTimeline) {
      // a script that wrote the open timeline's tracks into its entry: they become
      // the open tracks if those are empty, a timeline of their own otherwise
      if (t.tracks?.some((x) => x?.clips?.length)) {
        if (!p.tracks.some((x) => x.clips.length)) p.tracks = t.tracks
        else extra.push({ id: `${t.id}-2`, name: `${t.name} 2`, tracks: t.tracks })
      }
      delete t.tracks
    } else t.tracks ??= []
  }
  p.timelines.push(...extra.filter((t) => !seen.has(t.id)))
}
