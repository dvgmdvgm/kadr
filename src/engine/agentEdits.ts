// The page side of the agent's semantic edit tools (card I1): kadr_cut, kadr_move,
// kadr_trim, kadr_ripple_delete, kadr_keyframe, kadr_text_add, kadr_volume,
// kadr_marker and kadr_undo in electron/mcp-edit-tools.cjs call these, and only these.
//
// Each edit is ONE undo step through one store action, whatever the agent
// remembers about pushHistory: `once` checks that exactly one history entry
// appeared, and an edit that changed nothing leaves no entry behind and throws,
// so the agent hears "nothing happened" instead of reading a silent no-op as done.
// Times are project seconds; the store lands them on frames (card E1).
// Test: node scripts/check-mcp-tools.mjs
import type { Anim, Clip, Easing, Project, TextStyle, TimelineMarker } from '@shared/types'
import { useEditor, findClip, withLinked, defaultTextStyle } from '@/state/store'
import { toFrame } from './timelineMath'
import { upsertKf } from '@/components/animUtils'
import { applySilences, findSilences, type FindSilencesArgs } from './silences'
import { findScenes, type FindScenesArgs } from './scenes'

const st = () => useEditor.getState()

/** what these edits can change: tracks and markers (never the assets and their blobs) */
const edited = (p: Project) => JSON.stringify([p.tracks, p.markers])

function once<T>(what: string, edit: () => T): T {
  const before = st()
  const was = edited(before.project)
  const out = edit()
  const after = st()
  const pushed = after.past.filter((e) => !before.past.includes(e)).length
  if (after.project === before.project || edited(after.project) === was) {
    // an action that pushed and then found nothing to do: its entry would undo nothing
    useEditor.setState({ project: before.project, past: after.past.slice(0, after.past.length - pushed), future: before.future })
    throw new Error(`${what}: nothing changed`)
  }
  if (pushed !== 1) throw new Error(`${what}: ${pushed} undo steps instead of one`)
  return out
}

function clipOr(id: string): Clip {
  const f = findClip(st().project, id)
  if (!f) throw new Error(`no clip ${id}`)
  if (f.track.locked) throw new Error(`clip ${id} is on a locked track`)
  return f.clip
}

const at = (t: number) => toFrame(t, st().project.fps)

export function cut(a: { t: number; trackIds?: string[] }) {
  const ids = once('cut', () => st().splitAt(a.t, a.trackIds))
  return { t: at(a.t), rightHalves: ids }
}

export function move(a: { clipId: string; start: number; trackId?: string }) {
  const clip = clipOr(a.clipId)
  const dt = a.start - clip.start
  // the twins keep their own tracks and move by the same amount
  const entries = withLinked(st().project, [a.clipId]).map((id) => ({
    id, start: findClip(st().project, id)!.clip.start + dt,
    ...(id === a.clipId && a.trackId ? { trackId: a.trackId } : {})
  }))
  once('move', () => { st().pushHistory('hMove'); st().setClipStarts(entries) })
  const c = findClip(st().project, a.clipId)!
  if (a.trackId && c.track.id !== a.trackId) throw new Error('moved, but the target track refused the clip (another kind or locked)')
  return { clipId: a.clipId, start: c.clip.start, trackId: c.track.id }
}

export function trim(a: { clipId: string; edge: 'in' | 'out'; t: number; ripple?: boolean }) {
  clipOr(a.clipId)
  once('trim', () => {
    st().pushHistory(a.ripple ? 'hRippleTrim' : 'hTrim')
    if (a.ripple) st().rippleTrim(a.clipId, a.edge, a.t)
    else st().trimClip(a.clipId, a.edge, a.t)
  })
  const c = findClip(st().project, a.clipId)!.clip
  return { clipId: c.id, start: c.start, duration: c.duration, inPoint: c.inPoint }
}

export function rippleDelete(a: { clipIds?: string[]; start?: number; end?: number }) {
  if (a.clipIds) {
    const gone = withLinked(st().project, a.clipIds)
    once('ripple delete', () => st().rippleDelete(a.clipIds))
    return { removed: gone }
  }
  once('ripple delete', () => st().extractRange({ start: at(a.start!), end: at(a.end!) }))
  return { removedRange: [at(a.start!), at(a.end!)] }
}

const KEY_PARAMS = ['x', 'y', 'scale', 'rotation', 'opacity', 'rotX', 'rotY', 'z', 'gain'] as const
type KeyParam = typeof KEY_PARAMS[number]

export function keyframe(a: { clipId: string; param: KeyParam; t: number; value: number; easing?: Easing }) {
  const clip = clipOr(a.clipId)
  const rel = at(a.t) - clip.start // keyframe times are clip-local
  if (rel < -1e-9 || rel > clip.duration + 1e-9) throw new Error(`t=${a.t} is outside the clip [${clip.start}, ${clip.start + clip.duration}]`)
  const cur: Anim = (a.param === 'gain' ? clip.gain : clip.transform[a.param]) ?? { value: 0 }
  const next = upsertKf(cur, rel, a.value, a.easing)
  if (a.easing) next.keyframes = next.keyframes!.map((k) => Math.abs(k.time - rel) < 1e-9 ? { ...k, easing: a.easing! } : k)
  const patch: Partial<Clip> = a.param === 'gain' ? { gain: next } : { transform: { ...clip.transform, [a.param]: next } }
  once('keyframe', () => { st().pushHistory('hKeyframe'); st().updateClip(a.clipId, patch) })
  return { clipId: a.clipId, param: a.param, keyTime: rel, keys: next.keyframes!.length }
}

export function textAdd(a: { at: number; text: string; style?: Partial<TextStyle>; duration?: number }) {
  once('text', () => {
    st().insertTextClip(a.at) // pushes its own step and selects the new clip
    const id = st().selection[0]
    if (!id || findClip(st().project, id)?.clip.kind !== 'text') return
    st().updateClip(id, { text: a.text, textStyle: { ...defaultTextStyle(), ...a.style } })
  })
  const id = st().selection[0]
  const c = findClip(st().project, id)?.clip
  if (!c || c.kind !== 'text') throw new Error('no unlocked video track to put the text on')
  return { clipId: c.id, start: c.start, duration: c.duration }
}

export function volume(a: { clipId: string; value?: number; keys?: { t: number; value: number; easing?: Easing }[] }) {
  clipOr(a.clipId)
  const ids = withLinked(st().project, [a.clipId]).filter((id) => !findClip(st().project, id)!.track.locked)
  once('volume', () => {
    st().pushHistory('hEdit')
    for (const id of ids) {
      const c = findClip(st().project, id)!.clip
      const gain: Anim = a.keys
        ? { value: a.keys[0].value, keyframes: a.keys.map((k) => ({ time: at(k.t) - c.start, value: k.value, easing: k.easing ?? 'linear' })).sort((x, y) => x.time - y.time) }
        : { value: a.value! }
      st().updateClip(id, { gain })
    }
  })
  return { clipIds: ids }
}

export function marker(a: { t: number; label?: string; kind?: TimelineMarker['kind']; end?: number }) {
  const id = once('marker', () => st().addMarker(a.t, { label: a.label, kind: a.kind, end: a.end }))
  const m = st().project.markers!.find((x) => x.id === id)!
  return { id, time: m.time, label: m.label }
}

export function undo(a: { steps: number }) {
  const labels: string[] = []
  for (let i = 0; i < a.steps; i++) {
    const s = st()
    if (!s.past.length) break
    labels.push(s.past[s.past.length - 1].label)
    s.undo()
  }
  return { undone: labels.length, labels, left: st().past.length }
}

/** kadr_silences: find pauses (shown on the timeline as proposals), or cut
    proposals out of every unlocked track — one undo step. */
export async function silences(a: FindSilencesArgs & { apply?: 'confirmed' | 'all' | string[] }) {
  if (a.apply) {
    const gone = once('silences', () => applySilences(a.apply!))
    return { removed: gone.map(({ id, start, end }) => ({ id, start, end })), seconds: +gone.reduce((n, x) => n + x.end - x.start, 0).toFixed(3) }
  }
  const found = await findSilences(a)
  return { proposals: found.map(({ id, start, end }) => ({ id, start, end })), seconds: +found.reduce((n, x) => n + x.end - x.start, 0).toFixed(3) }
}

/** kadr_scenes: hard cuts of the video as 'scene' markers (replacing the old
    ones over the stretch) — one undo step, none when they did not change. */
export async function scenes(a: FindScenesArgs) {
  const found = await findScenes(a)
  return { scenes: found, count: found.length }
}
