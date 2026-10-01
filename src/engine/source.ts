// L5: the source viewer's state (canvas L, design-source/canvas/L/RULES.md).
// One bin file held for marking and putting on the timeline with Insert or
// Overwrite. Everything here is VIEW state for the session: opening, playing,
// marking and patching never touch the project or the undo history — only
// the edit itself does, through the store's threePointEdit.
import { create } from 'zustand'
import { useEditor, setting } from '../state/store'
import { resolveThreePoint } from '@shared/threePoint'
import type { MediaAsset, Project, Track, TrackKind } from '@shared/types'

/** a target: a track id, 'new' (a track made by the edit), or null = not taken */
export type SourceTarget = string | 'new' | null
interface Marks { in: number | null; out: number | null; pos: number }

interface SourceState {
  assetId: string | null
  tab: 'source' | 'program'
  /** «Рядом»: source and programme side by side (per user, like kadr.sidew) */
  split: boolean
  /** the last click was inside the viewer: I/O, Space, J/K/L, arrows act on it */
  focused: boolean
  playing: boolean
  /** marks and position per asset, for the session */
  marks: Record<string, Marks>
  /** chosen targets per project, for the session; absent = the default */
  targets: Record<string, Partial<Record<TrackKind, SourceTarget>>>
}

const readSplit = () => { try { return localStorage.getItem('kadr.svsplit') === '1' } catch { return false } }

export const useSource = create<SourceState>(() => ({
  assetId: null, tab: 'program', split: readSplit(), focused: false, playing: false, marks: {}, targets: {}
}))

const NO_MARKS: Marks = { in: null, out: null, pos: 0 }
export const marksOf = (s: SourceState, id: string | null): Marks => (id && s.marks[id]) || NO_MARKS

/** the viewer's media element (SourceViewer registers it) */
let media: HTMLMediaElement | null = null
export function registerSourceMedia(el: HTMLMediaElement | null) { media = el }

export function sourceAsset(s = useSource.getState(), p = useEditor.getState().project): MediaAsset | null {
  return (s.assetId && p.assets.find((a) => a.id === s.assetId)) || null
}
/** a still has no time of its own: it is put down for the default still length */
export const sourceDuration = (a: MediaAsset) =>
  a.kind === 'image' ? setting<number>('editing.stillDuration') : a.duration

const setMarks = (patch: Partial<Marks>) => useSource.setState((s) => {
  if (!s.assetId) return s
  return { marks: { ...s.marks, [s.assetId]: { ...marksOf(s, s.assetId), ...patch } } }
})

export function openSource(assetId: string) {
  if (useSource.getState().assetId !== assetId) media?.pause()
  // the defaults are taken once and then held for the session (RULES 20): a
  // target locked later blocks the edit with its name, it does not jump
  const p = useEditor.getState().project
  const held = useSource.getState().targets[p.id] ?? {}
  const fill = { video: held.video !== undefined ? held.video : targetOf('video', p), audio: held.audio !== undefined ? held.audio : targetOf('audio', p) }
  useSource.setState((s) => ({ assetId, tab: 'source', playing: false, targets: { ...s.targets, [p.id]: fill } }))
}
export function closeSource() {
  media?.pause()
  useSource.setState({ assetId: null, tab: 'program', focused: false, playing: false })
}
export function showTab(tab: 'source' | 'program') { useSource.setState({ tab }) }
export function toggleSplit() {
  const split = !useSource.getState().split
  try { localStorage.setItem('kadr.svsplit', split ? '1' : '0') } catch { /* a convenience */ }
  useSource.setState({ split })
}
export function setSourceFocus(focused: boolean) {
  if (useSource.getState().focused !== focused) useSource.setState({ focused })
}

// ---------------------------------------------------------------- transport

/** the source position (the element's while it exists) */
export function sourcePos(): number {
  return media ? media.currentTime : marksOf(useSource.getState(), useSource.getState().assetId).pos
}
export function seekSource(t: number) {
  const a = sourceAsset()
  if (!a) return
  const pos = Math.min(sourceDuration(a), Math.max(0, t))
  if (media) media.currentTime = pos
  setMarks({ pos })
}
let reverseRate = 0
let reverseRaf = 0
function stopReverse() { reverseRate = 0; cancelAnimationFrame(reverseRaf) }
export function playSource(on = !useSource.getState().playing) {
  stopReverse()
  if (!media) return
  if (on) {
    media.playbackRate = 1
    if (media.ended || media.currentTime >= media.duration - 0.01) media.currentTime = 0
    void media.play().catch(() => { /* a pause raced it */ })
  } else media.pause()
}
/** L: forward ×1 → ×2 → ×4 → ×8; J: the same backwards (seek-following, like the programme's) */
export function shuttleSource(dir: 1 | -1) {
  if (!media) return
  const el = media
  if (dir > 0) {
    stopReverse()
    const r = !el.paused && el.playbackRate >= 1 ? Math.min(8, el.playbackRate * 2) : 1
    el.playbackRate = r
    void el.play().catch(() => {})
    return
  }
  el.pause()
  reverseRate = reverseRate > 0 ? Math.min(8, reverseRate * 2) : 1
  cancelAnimationFrame(reverseRaf)
  let last = performance.now()
  const tick = (now: number) => {
    if (!reverseRate || !media) return
    const t = Math.max(0, el.currentTime - reverseRate * (now - last) / 1000)
    last = now
    el.currentTime = t
    setMarks({ pos: t })
    if (t <= 0) { stopReverse(); return }
    reverseRaf = requestAnimationFrame(tick)
  }
  reverseRaf = requestAnimationFrame(tick)
  useSource.setState({ playing: true })
}
export function stopSource() {
  stopReverse()
  media?.pause()
  useSource.setState({ playing: false })
}
export function stepSource(frames: number) {
  const a = sourceAsset()
  if (!a) return
  stopSource()
  seekSource(sourcePos() + frames / (a.fps > 0 ? a.fps : useEditor.getState().project.fps))
}

// -------------------------------------------------------------------- marks

export function markSource(which: 'in' | 'out') {
  if (!sourceAsset()) return
  setMarks({ [which]: sourcePos() })
}
export function setSourceMark(which: 'in' | 'out', t: number | null) { setMarks({ [which]: t }) }
export function clearSourceMarks() { setMarks({ in: null, out: null }) }
export function goSourceMark(which: 'in' | 'out') {
  const a = sourceAsset()
  if (!a) return
  const m = marksOf(useSource.getState(), a.id)
  stopSource()
  seekSource(m[which] ?? (which === 'in' ? 0 : sourceDuration(a)))
}

// ------------------------------------------------------------------ targets

/** what the file can give: picture (video, image) and sound (audio, video with sound) */
export const hasPicture = (a: MediaAsset) => a.kind !== 'audio'
export const hasSound = (a: MediaAsset) => a.kind === 'audio' || (a.kind === 'video' && a.hasAudio)

/** The target of one kind: the chosen one while its track exists, else the
    topmost unlocked track of that kind (or a new one when there is none). */
export function targetOf(kind: TrackKind, p: Project = useEditor.getState().project, s = useSource.getState()): SourceTarget {
  const chosen = s.targets[p.id]?.[kind]
  if (chosen === null || chosen === 'new') return chosen
  if (chosen && p.tracks.some((t) => t.id === chosen && t.kind === kind)) return chosen
  return p.tracks.find((t) => t.kind === kind && !t.locked)?.id ?? 'new'
}
export function setTarget(kind: TrackKind, target: SourceTarget) {
  const id = useEditor.getState().project.id
  useSource.setState((s) => ({ targets: { ...s.targets, [id]: { ...s.targets[id], [kind]: target } } }))
}

export interface SourcePlan {
  asset: MediaAsset
  video: SourceTarget
  audio: SourceTarget
  /** why the buttons are off ('' = they work); `track` names the locked one */
  why: '' | 'locked' | 'nothing'
  track?: Track
  len: number
  whole: boolean
}

/** Everything the viewer's buttons say and do, for the current source. */
export function sourcePlan(p: Project = useEditor.getState().project, s = useSource.getState()): SourcePlan | null {
  const asset = sourceAsset(s, p)
  if (!asset) return null
  const video = hasPicture(asset) ? targetOf('video', p, s) : null
  const audio = hasSound(asset) ? targetOf('audio', p, s) : null
  const m = marksOf(s, asset.id)
  const ed = useEditor.getState()
  const still = asset.kind === 'image'
  const r = resolveThreePoint({
    srcDur: sourceDuration(asset), srcIn: still ? null : m.in, srcOut: still ? null : m.out,
    playhead: ed.playhead, range: ed.range
  })
  const plan: SourcePlan = { asset, video, audio, why: '', len: r.len, whole: r.srcIn === 0 && r.len >= sourceDuration(asset) - 1e-6 }
  if (video === null && audio === null) plan.why = 'nothing'
  for (const t of [video, audio]) {
    const tr = t && t !== 'new' ? p.tracks.find((x) => x.id === t) : undefined
    if (tr?.locked) { plan.why = 'locked'; plan.track = tr; break }
  }
  return plan
}

/** Insert (,) or Overwrite (.) the marked part of the source; the programme comes forward. */
export function sourceEdit(mode: 'insert' | 'overwrite'): boolean {
  const s = useSource.getState()
  const plan = sourcePlan(undefined, s)
  if (!plan || plan.why) return false
  const m = marksOf(s, plan.asset.id)
  stopSource()
  const ids = useEditor.getState().threePointEdit(mode, { assetId: plan.asset.id, in: m.in, out: m.out },
    { video: plan.video, audio: plan.audio })
  if (!ids.length) return false
  useSource.setState({ tab: 'program', focused: false })
  return true
}

// --------------------------------------------------------------- key routing

/** The keys that act on the viewer while it has focus (RULES 13). Returns
    true when the key was the viewer's. */
export function routeSourceKey(id: string, stopHeld: boolean): boolean {
  const s = useSource.getState()
  if (!s.focused || !s.assetId) return false
  switch (id) {
    case 'transport.play': playSource(); return true
    case 'transport.stop': stopSource(); return true
    case 'transport.forward': if (stopHeld) stepSource(1); else shuttleSource(1); return true
    case 'transport.reverse': if (stopHeld) stepSource(-1); else shuttleSource(-1); return true
    case 'range.in': markSource('in'); return true
    case 'range.out': markSource('out'); return true
    case 'playhead.prevFrame': stepSource(-1); return true
    case 'playhead.nextFrame': stepSource(1); return true
    case 'playhead.back1s': stopSource(); seekSource(sourcePos() - 1); return true
    case 'playhead.fwd1s': stopSource(); seekSource(sourcePos() + 1); return true
    case 'playhead.start': stopSource(); seekSource(0); return true
    case 'playhead.end': { const a = sourceAsset(); stopSource(); if (a) seekSource(sourceDuration(a)); return true }
  }
  return false
}
