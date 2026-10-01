// K6: the mixer's writes. The strip, the track header and the Inspector's
// audio rows all go through here, so a fader and the header's slider are one
// value (`Track.gain`), mute and solo are the header's own fields, and every
// gesture is one undo step: the caller pushes once (beginMixGesture) on
// pointerdown, then writes as often as the pointer moves.
import type { Anim, Clip, Track } from '@shared/types'
import { clampPan } from '@shared/pan'
import { useEditor, findClip } from '@/state/store'
import { upsertKf, KF_EPS } from '@/components/animUtils'
import { evalAnim } from './anim'
import { create } from 'zustand'

/** the header's own range for an audio track's gain (0 … +6 dB) */
export const TRACK_GAIN_MAX = 2
const clampGain = (g: number) => (Number.isFinite(g) ? Math.min(TRACK_GAIN_MAX, Math.max(0, g)) : 1)

export function beginMixGesture(): void {
  useEditor.getState().pushHistory('hEdit')
}

/** a run of arrow keys on one control is ONE undo step; a pointer or a blur ends the run (`end`) */
export function keyRun(): { key(): void; end(): void } {
  let on = false
  return {
    key() { if (!on) { beginMixGesture(); on = true } },
    end() { on = false }
  }
}

export function setTrackGain(trackId: string, gain: number): void {
  useEditor.getState().updateTrack(trackId, { gain: clampGain(gain) })
}

export function setMaster(gain: number): void {
  useEditor.getState().setMasterGain(clampGain(gain))
}

/** mute / solo: one undo step per click, from the header and the strip alike */
export function toggleTrack(trackId: string, key: 'muted' | 'solo'): void {
  const st = useEditor.getState()
  const t = st.project.tracks.find((x) => x.id === trackId)
  if (!t) return
  st.pushHistory('hTrack')
  st.updateTrack(trackId, { [key]: !t[key] })
}

/** a track's pan at project time `t` (keys are in project seconds) */
export const trackPanAt = (track: Track, t: number): number => clampPan(evalAnim(track.pan, t))

/** static: the value; keyed: a key at project time `at` */
export function setTrackPan(trackId: string, pan: number, at: number): void {
  const st = useEditor.getState()
  const t = st.project.tracks.find((x) => x.id === trackId)
  if (!t) return
  const v = clampPan(pan)
  const a: Anim = t.pan ?? { value: 0 }
  st.updateTrack(trackId, { pan: a.keyframes?.length ? upsertKf(a, at, v) : { ...a, value: v } })
}

type ClipAudioKey = 'gain' | 'pan'
const animOf = (clip: Clip, key: ClipAudioKey): Anim => clip[key] ?? { value: key === 'gain' ? 1 : 0 }

/**
 * The Inspector's gain / pan of a clip. Keyed: a key at the clip-local
 * playhead — never `.value`, which evalAnim ignores once there are keys (K1
 * finding 2); outside the clip a keyed edit has no place and writes nothing.
 */
export function setClipAnimAt(clipId: string, key: ClipAudioKey, v: number, playhead: number): boolean {
  const st = useEditor.getState()
  const clip = findClip(st.project, clipId)?.clip
  if (!clip) return false
  const a = animOf(clip, key)
  const val = key === 'gain' ? clampGain(v) : clampPan(v)
  if (a.keyframes?.length) {
    const rel = playhead - clip.start
    if (rel < 0 || rel > clip.duration) return false
    st.updateClip(clipId, { [key]: upsertKf(a, rel, val) })
  } else {
    st.updateClip(clipId, { [key]: { ...a, value: val } })
  }
  return true
}

/** the diamond: a key at the playhead comes or goes (one undo step); the last key leaves its value */
export function toggleKeyAt(clipId: string, key: ClipAudioKey, playhead: number): void {
  const st = useEditor.getState()
  const clip = findClip(st.project, clipId)?.clip
  if (!clip) return
  const rel = playhead - clip.start
  if (rel < 0 || rel > clip.duration) return
  const a = animOf(clip, key)
  const hit = a.keyframes?.find((k) => Math.abs(k.time - rel) < KF_EPS)
  st.pushHistory('hEdit')
  if (!hit) { st.updateClip(clipId, { [key]: upsertKf(a, rel, evalAnim(a, rel)) }); return }
  const rest = a.keyframes!.filter((k) => k !== hit)
  st.updateClip(clipId, { [key]: rest.length ? { ...a, keyframes: rest } : { value: hit.value } })
}

/** where the mixer is: open, per user (RULES 4), not in the project */
const OPEN_KEY = 'kadr.mixer'
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1' } catch { return false } }
export const useMixerUi = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({
  open: readOpen(),
  setOpen: (open) => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* a convenience */ }
    set({ open })
  }
}))
