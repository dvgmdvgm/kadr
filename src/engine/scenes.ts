// Scene-cut markers (card I6): the hard cuts of the video under a clip or a
// range, found by ffmpeg's scdet in main (`media:scenes`, source seconds) and
// laid on the timeline as markers of kind 'scene' — thin lines like beats,
// snap targets like every marker. A new search replaces the scene markers of
// its own stretch, one undo step. The palette command and kadr_scenes run it.
// Test: node scripts/check-scenes.mjs
import { useEditor, projectDuration } from '@/state/store'
import { logError } from './log'
import { tr } from '@/i18n'

export interface FindScenesArgs {
  /** one clip; default: start+end, else the in/out range, else the whole timeline */
  clipId?: string
  start?: number
  end?: number
  /** scdet score 0..100 a frame change must pass (default 10, ffmpeg's own) */
  threshold?: number
}

/** Find the cuts, replace the scene markers over the stretch, return their times (project s). */
export async function findScenes(a: FindScenesArgs = {}): Promise<number[]> {
  const s = useEditor.getState()
  const p = s.project
  const all = p.tracks.flatMap((t) => t.clips)
  let start: number, end: number
  if (a.clipId) {
    const c = all.find((x) => x.id === a.clipId)
    if (!c) throw new Error(`no clip ${a.clipId}`)
    start = c.start; end = c.start + c.duration
  } else if (a.start !== undefined && a.end !== undefined) {
    start = a.start; end = a.end
  } else if (s.range) {
    start = s.range.start; end = s.range.end
  } else {
    start = 0; end = projectDuration(p)
  }
  if (!(end > start)) throw new Error('nothing to analyse: empty range')
  const clips = all.filter((c) => (!a.clipId || c.id === a.clipId) && c.kind === 'media' &&
    p.assets.find((x) => x.id === c.assetId)?.kind === 'video' && c.start < end && c.start + c.duration > start)
  if (!clips.length) throw new Error('no video there')
  const times: number[] = []
  for (const c of clips) {
    const asset = p.assets.find((x) => x.id === c.assetId)!
    const t0 = Math.max(start, c.start)
    const t1 = Math.min(end, c.start + c.duration)
    const src0 = c.inPoint + (t0 - c.start) * c.speed
    // ponytail: a clip looped past its source (duration > source/speed) is scanned once
    const len = Math.min((t1 - t0) * c.speed, asset.duration - src0)
    if (!(len > 0)) continue
    const cuts = await window.kadr.detectScenes(asset.path, src0, len, a.threshold)
    for (const t of cuts) times.push(c.start + (t - c.inPoint) / c.speed)
  }
  useEditor.getState().setSceneMarkers(times, { start, end })
  return (useEditor.getState().project.markers ?? [])
    .filter((m) => m.kind === 'scene' && m.time >= start - 1e-6 && m.time <= end + 1e-6).map((m) => m.time)
}

/** The palette: the one selected clip, else the range, else everything. */
export async function findScenesHere(): Promise<void> {
  const sel = useEditor.getState().selection
  try {
    await findScenes(sel.length === 1 ? { clipId: sel[0] } : {})
  } catch (e) {
    logError(tr('actFindScenes'), `${tr('scenesFailed')}: ${(e as Error)?.message ?? e}`)
  }
}
