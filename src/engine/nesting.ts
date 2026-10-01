// L6: compound clips, as the renderers see them. A clip of kind 'timeline'
// plays another timeline of the project; `flattenProject` replaces it by that
// timeline's own clips — cut to the clip's window, moved to its place, their
// tracks stacked where the compound's track is — so drawFrame, the audio
// segments, the fragment pages and the export all read an ordinary project
// and stay what they were. Nested compounds expand the same way, recursively;
// a loop or a nest deeper than MAX_NEST_DEPTH draws nothing.
//
// EXACT FOR A CONTAINER, which is what «Сделать составной клип» makes: the
// export of a nest is frame-identical to the same clips laid out flat
// (scripts/check-nesting.mjs). The compound's own gain and mute reach its
// contents; its picture controls are not offered (Inspector) — a transform,
// effect or opacity on the WHOLE nest needs the nest drawn into a texture of
// its own first.
// ponytail: expansion, not a nested render pass — the upgrade is an offscreen
// pass in drawFrame when compound clips get picture controls.
import type { Anim, Clip, Project, Track, Transform3D } from '@shared/types'
import { MAX_NEST_DEPTH, activeTimelineId, isCompound, timelineTracks } from '@shared/timelines'
import { clipIntersection } from '@/state/store'

const memo = new WeakMap<Project, Project>()

const shifted = (a: Anim, dt: number): Anim =>
  a.keyframes?.length ? { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time + dt })) } : a

const shiftedMotion = (m: Transform3D, dt: number): Transform3D => ({
  x: shifted(m.x, dt), y: shifted(m.y, dt), scale: shifted(m.scale, dt), rotation: shifted(m.rotation, dt),
  rotX: shifted(m.rotX, dt), rotY: shifted(m.rotY, dt), z: shifted(m.z, dt)
})

/** The project with every compound clip of the open timeline replaced by its
    contents. The same object when there is none; cached per project object
    (every edit makes a new one), so the preview asks for it on every tick. */
export function flattenProject(p: Project): Project {
  if (!p.tracks.some((t) => t.clips.some(isCompound))) return p
  let out = memo.get(p)
  if (!out) {
    out = { ...p, tracks: expand(p, p.tracks, [activeTimelineId(p)]) }
    memo.set(p, out)
  }
  return out
}

function expand(p: Project, tracks: Track[], stack: string[]): Track[] {
  const out: Track[] = []
  const sound: Track[] = []
  for (const T of tracks) {
    const comps = T.clips.filter(isCompound)
    if (!comps.length) { out.push(T); continue }
    for (const C of comps) {
      const id = C.timelineId
      const inner = id && !stack.includes(id) && stack.length < MAX_NEST_DEPTH ? timelineTracks(p, id) : null
      if (!inner) continue // a loop, a missing timeline or too deep: nothing
      const flat = expand(p, inner, [...stack, id!])
      const soloed = flat.some((t) => t.solo)
      const off = C.start - C.inPoint
      const gain = C.gain?.value ?? 1 // ponytail: a keyed nest gain applies its base value
      for (const nt of flat) {
        const clips = nt.clips.flatMap((c): Clip[] => {
          const piece = clipIntersection(c, C.inPoint, C.inPoint + C.duration)
          if (!piece) return []
          piece.id = `${C.id}/${c.id}`
          piece.start += off
          if (piece.linkId) piece.linkId = `${C.id}/${piece.linkId}`
          if (C.muted) piece.muted = true
          if (C.disabled) piece.disabled = true
          if (gain !== 1) {
            piece.gain = { ...piece.gain, value: piece.gain.value * gain,
              ...(piece.gain.keyframes && { keyframes: piece.gain.keyframes.map((k) => ({ ...k, value: k.value * gain })) }) }
          }
          return [piece]
        })
        if (!clips.length) continue
        const picture = nt.kind === 'video'
        // the nest's tracks stand where the compound's track is: its mute, solo
        // and (for pictures) its opacity apply to them as they did to the clip
        const x: Track = {
          ...nt,
          id: `${T.id}/${C.id}/${nt.id}`,
          clips,
          muted: T.muted || nt.muted || (soloed && !nt.solo),
          solo: T.solo,
          gain: nt.gain * (picture || T.kind === 'audio' ? T.gain : 1),
          ...(nt.pan ? { pan: shifted(nt.pan, off) } : T.pan ? { pan: T.pan } : {}),
          ...(nt.motion ? { motion: shiftedMotion(nt.motion, off) } : T.motion ? { motion: T.motion } : {})
        }
        if (!x.solo) delete x.solo
        ;(picture ? out : sound).push(x)
      }
    }
    out.push({ ...T, clips: T.clips.filter((c) => !isCompound(c)) })
  }
  return [...out, ...sound]
}
