import { create } from 'zustand'
import type {
  Project, Track, Clip, Anim, MediaAsset, TrackKind, TextStyle, TextDoc, FragmentSpec,
  VoiceRun, AudioDefect, DefectState, TimelineMarker, MusicSectionLabel
} from '@shared/types'
import { isMusicMarker, LABEL_COLORS } from '@shared/types'
import { saveUserStore } from '../engine/userStore'
import { logWarn } from '../engine/log'
import { tr, trf } from '../i18n'
import { toFrame, nextEdit, clipSourceTime, MAX_ZOOM, MIN_ZOOM } from '../engine/timelineMath'
import { evalAnim } from '../engine/anim'
import { existingClips } from '../engine/timelineSelect'
import {
  SETTINGS, effective, fromLegacy, healValue,
  type SettingDef, type SettingKey, type SettingSource, type SettingValue, type SettingsDiff, type SettingsSnapshot
} from '@shared/settings'

export const uid = () => Math.random().toString(36).slice(2, 10)

/** The end of a clip that starts at `start` (already on a frame), quantised
    from the RAW end and at least one frame after the start. Edits quantise
    starts and ends, never the speed or the in-point (card E1). */
const frameEnd = (fps: number, start: number, end: number, snap?: (x: number) => number) =>
  Math.max(toFrame(end, fps, snap), toFrame(start + 1 / fps, fps))


import { defaultTextStyle } from '@/engine/text'
import { exactFps } from '@shared/projectFormat'
import { healBins, moveInto, dissolveBin } from '@shared/bins'
import { mapPaths, projectPaths } from '@shared/projectPaths'
import { said } from '@shared/said'
import { GRADE_KEYS, type ClipGrade } from '@shared/colour'
export { defaultTextStyle }

export const newClipDefaults = (): Pick<
  Clip,
  'speed' | 'gain' | 'muted' | 'transform' | 'mask' | 'effects' | 'fadeIn' | 'fadeOut' | 'transitionIn'
> => ({
  // «Переход по умолчанию»: stamped into the clip (duration 0 = the overlap blend), so the
  // project renders the same everywhere; crossfade is what a clip without one gets anyway
  ...(setting('editing.transition') !== 'crossfade'
    ? { transitionIn: { type: String(setting('editing.transition')), duration: 0 } } : {}),
  speed: 1,
  gain: { value: 1 },
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
  transform: {
    x: { value: 0 },
    y: { value: 0 },
    scale: { value: 1 },
    rotation: { value: 0 },
    opacity: { value: 1 }
  },
  mask: {
    left: { value: 0 },
    top: { value: 0 },
    right: { value: 0 },
    bottom: { value: 0 }
  },
  effects: []
})

/** a new project from the «Новые проекты» settings (the open project keeps its own) */
/** «Затухание звука на краях клипа»: a new clip on an audio track fades in and out */
const audioFade = () => {
  const f = setting<number>('editing.fade')
  return { fadeIn: f, fadeOut: f }
}

export function newProject(): Project {
  const nv = setting<number>('newProject.videoTracks')
  const na = setting<number>('newProject.audioTracks')
  const track = (kind: TrackKind, name: string): Track => ({ id: uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
  return {
    version: 1,
    id: uid(),
    name: 'Untitled',
    width: setting<number>('newProject.width'),
    height: setting<number>('newProject.height'),
    // D's settings list 29.97 as a decimal; the project stores 30000/1001 (H2)
    fps: exactFps(setting<number>('newProject.fps')),
    background: setting<string>('newProject.background'),
    // V2, V1 over A1: tracks[0] is the top video track
    tracks: [
      ...Array.from({ length: nv }, (_, i) => track('video', `V${nv - i}`)),
      ...Array.from({ length: na }, (_, i) => track('audio', `A${i + 1}`))
    ],
    assets: []
  }
}

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

/**
 * Heal foreign or script-written projects on load. Anim slots written as
 * plain numbers (e.g. `gain: 0.5` from a kadr_eval script) become `{value}`,
 * non-finite values and broken keyframes are dropped — a single NaN reaching
 * WebAudio used to kill playback for the rest of the session.
 */
export function sanitizeProject(p: Project): Project {
  const anim = (a: unknown, fallback: number): Anim => {
    if (typeof a === 'number') return { value: Number.isFinite(a) ? a : fallback }
    if (!a || typeof a !== 'object') return { value: fallback }
    const o = a as Anim
    if (o.keyframes) {
      o.keyframes = o.keyframes.filter((k) => Number.isFinite(k?.time) && Number.isFinite(k?.value))
      if (!o.keyframes.length) delete o.keyframes
    }
    if (!Number.isFinite(o.value)) o.value = o.keyframes?.[0]?.value ?? fallback
    return o
  }
  // a hex, or 'transparent' (H2's «Прозрачный», honoured by the compositor and the alpha export)
  if (typeof p.background !== 'string') p.background = '#000000'
  if (!Number.isFinite(p.width) || p.width <= 0) p.width = 1920
  if (!Number.isFinite(p.height) || p.height <= 0) p.height = 1080
  if (!Number.isFinite(p.fps) || p.fps <= 0) p.fps = 30
  p.assets ??= []
  healBins(p)
  p.claudeChats = (p.claudeChats ?? []).filter((id) => typeof id === 'string' && id.length > 0)
  p.markers = (p.markers ?? []).filter(
    (m) => m && typeof m.id === 'string' && Number.isFinite(m.time)
  )
  for (const m of p.markers) {
    // the analysis' markers are the ones that legitimately have no label
    const found = isMusicMarker(m) || m.kind === 'scene'
    if (m.kind !== undefined && !found) delete m.kind
    if (typeof m.label !== 'string' || (!m.label && !found)) m.label = found ? '' : '•'
    if (m.time < 0) m.time = 0
    if (m.kind === 'section' || m.kind === 'pause') {
      if (!Number.isFinite(m.end) || m.end! < m.time) m.end = m.time
    } else delete m.end
    for (const k of ['bar', 'beatInBar', 'energy'] as const) {
      if (m[k] !== undefined && !Number.isFinite(m[k])) delete m[k]
    }
    if (m.strength !== undefined) {
      if (!Number.isFinite(m.strength)) delete m.strength
      else m.strength = Math.min(1, Math.max(0, m.strength))
    }
    if (m.strong !== undefined && typeof m.strong !== 'boolean') m.strong = !!m.strong
  }
  // a voice-over is meaningless without its asset and its script; tempo must be
  // a real factor or a regenerated phrase would be stretched by NaN
  p.voiceRuns = (p.voiceRuns ?? []).filter(
    (r) => r && typeof r.id === 'string' && typeof r.assetId === 'string' &&
      typeof r.scriptPath === 'string' && p.assets.some((a) => a.id === r.assetId)
  )
  for (const r of p.voiceRuns) {
    if (!Number.isFinite(r.tempo) || r.tempo <= 0) r.tempo = 1
    if (!Number.isFinite(r.duration) || r.duration < 0) r.duration = 0
    if (typeof r.scriptHash !== 'string') r.scriptHash = ''
  }
  // Дефекты держатся на ассете и на прогоне: без любого из них они бессмысленны.
  // Инвариант «дефект лежит внутри своей фразы» чинится, а не обсуждается — на
  // нём стоит вся перегенерация.
  const runIds = new Set(p.voiceRuns.map((r) => r.id))
  const assetIds = new Set(p.assets.map((a) => a.id))
  const DEFECT_STATES = ['proposed', 'confirmed', 'rejected', 'done', 'failed']
  p.defects = (p.defects ?? []).filter(
    (d) => d && typeof d.id === 'string' && assetIds.has(d.assetId) && runIds.has(d.runId) &&
      Array.isArray(d.src) && d.src.length === 2 &&
      Number.isFinite(d.src[0]) && Number.isFinite(d.src[1]) && d.src[1] > d.src[0]
  )
  for (const d of p.defects) {
    if (!DEFECT_STATES.includes(d.state)) d.state = 'proposed'
    if (d.origin !== 'user') d.origin = 'detector'
    if (d.src[0] < 0) d.src[0] = 0
    if (!Number.isFinite(d.confidence as number)) delete d.confidence
    if (d.words && !(Number.isInteger(d.words[0]) && Number.isInteger(d.words[1]) &&
        d.words[1] >= d.words[0])) delete d.words
    const ph = d.phrase
    if (!ph || !Number.isFinite(ph.t0) || !Number.isFinite(ph.t1) || ph.t1 <= ph.t0) {
      // фраза потеряна: вырождаем её в сам дефект и честно помечаем, что резать
      // по ней нельзя, пока разбор не пересчитан
      d.phrase = {
        t0: d.src[0], t1: d.src[1], sentFrom: -1, sentTo: -1,
        wordFrom: -1, wordTo: -1, charFrom: -1, charTo: -1, text: '',
        cut: ['fallback', 'fallback']
      }
      d.note = said('eStPhraseLost')
    } else {
      if (!Array.isArray(ph.cut) || ph.cut.length !== 2) ph.cut = ['fallback', 'fallback']
      if (ph.t0 > d.src[0]) ph.t0 = d.src[0]
      if (ph.t1 < d.src[1]) ph.t1 = d.src[1]
    }
  }
  // E9: a colour is a label index, solo/disabled are booleans; junk is dropped
  const label = (o: { color?: number }) => {
    if (o.color !== undefined && !(Number.isInteger(o.color) && o.color >= 1 && o.color <= LABEL_COLORS)) delete o.color
  }
  for (const track of p.tracks) {
    if (!Number.isFinite(track.gain)) track.gain = 1
    label(track)
    if (track.solo !== undefined) track.solo = !!track.solo
    for (const c of track.clips) {
      label(c)
      if (c.disabled !== undefined) { if (c.disabled) c.disabled = true; else delete c.disabled }
      if (c.freezeAt !== undefined && !(Number.isFinite(c.freezeAt) && c.freezeAt >= 0)) delete c.freezeAt
      // F4: contain is the default and stays implicit; flips are booleans
      if (c.fit !== 'cover' && c.fit !== 'stretch') delete c.fit
      for (const k of ['flipX', 'flipY'] as const) { if (c[k]) c[k] = true; else delete c[k] }
      for (const k of ['start', 'duration', 'inPoint'] as const)
        if (!Number.isFinite(c[k])) c[k] = 0
      if (!Number.isFinite(c.speed) || c.speed <= 0) c.speed = 1
      c.transform = { ...newClipDefaults().transform, ...(c.transform ?? {}) }
      c.gain = anim(c.gain, 1)
      c.effects ??= []
      // J1: a grade that is there has every control; one that is not stays absent
      if (c.grade !== undefined) {
        if (!c.grade || typeof c.grade !== 'object') delete c.grade
        else for (const k of GRADE_KEYS) c.grade[k] = anim(c.grade[k], 0)
      }
      // J2: a LUT needs a path; its intensity defaults to full
      if (c.lut !== undefined) {
        if (!c.lut || typeof c.lut.path !== 'string' || !c.lut.path) delete c.lut
        else c.lut.intensity = anim(c.lut.intensity, 1)
      }
      if (c.audioBake !== undefined && !(c.audioBake && typeof c.audioBake.hash === 'string' &&
          typeof c.audioBake.source === 'string')) delete c.audioBake
      forEachAnim(c, (a) => anim(a, Number.isFinite((a as Anim)?.value) ? (a as Anim).value : 0))
      if (c.kind === 'text') c.textStyle = textStyleOf(c.textStyle)
    }
  }
  return p
}

/** F2: a text style with every field present and of its type — the fields
    added later default to what the renderer drew before them. */
function textStyleOf(raw: unknown): TextStyle {
  const d = defaultTextStyle() as unknown as Record<string, unknown>
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(d))
    out[k] = typeof o[k] === typeof d[k] && (typeof d[k] !== 'number' || Number.isFinite(o[k])) ? o[k] : d[k]
  if (!['left', 'center', 'right'].includes(out.align as string)) out.align = d.align
  for (const k of ['fontSize', 'wrapWidth', 'shadowBlur', 'outlineWidth', 'backgroundPad', 'lineHeight'])
    if ((out[k] as number) < 0) out[k] = d[k]
  return out as unknown as TextStyle
}

/** All animatable scalars of a clip (transform, gain, mask, shape). */
export function forEachAnim(c: Clip, fn: (a: Anim) => Anim) {
  const tr = c.transform
  c.transform = {
    x: fn(tr.x), y: fn(tr.y), scale: fn(tr.scale),
    rotation: fn(tr.rotation), opacity: fn(tr.opacity),
    rotX: tr.rotX ? fn(tr.rotX) : undefined,
    rotY: tr.rotY ? fn(tr.rotY) : undefined,
    z: tr.z ? fn(tr.z) : undefined
  }
  c.gain = fn(c.gain)
  if (c.grade) {
    const g: Partial<ClipGrade> = { ...c.grade }
    for (const k of GRADE_KEYS) if (g[k]) g[k] = fn(g[k]!)
    c.grade = g as ClipGrade
  }
  if (c.lut) c.lut = { ...c.lut, intensity: fn(c.lut.intensity) }
  if (c.mask) {
    c.mask = {
      left: fn(c.mask.left), top: fn(c.mask.top),
      right: fn(c.mask.right), bottom: fn(c.mask.bottom)
    }
  }
  if (c.maskShape) {
    c.maskShape = {
      ...c.maskShape,
      cx: fn(c.maskShape.cx), cy: fn(c.maskShape.cy),
      w: fn(c.maskShape.w), h: fn(c.maskShape.h),
      featherIn: fn(c.maskShape.featherIn), featherOut: fn(c.maskShape.featherOut)
    }
  }
  if (c.maskShapes) {
    c.maskShapes = c.maskShapes.map((s) => ({
      ...s,
      cx: fn(s.cx), cy: fn(s.cy),
      w: fn(s.w), h: fn(s.h),
      featherIn: fn(s.featherIn), featherOut: fn(s.featherOut)
    }))
  }
}

/** Shift keyframe times (content moved: trim-in, split) — keeps anims glued to frames. */
export function shiftClipAnims(c: Clip, delta: number) {
  forEachAnim(c, (a) =>
    a.keyframes?.length
      ? { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time + delta })) }
      : a
  )
  if (Math.abs(delta) > 1e-9) {
    // fades hug the clip edges; trimming from the left consumes the fade-in
    if (c.fadeIn) c.fadeIn = Math.max(0, c.fadeIn + delta)
  }
}

/** Rescale keyframe times and fades when playback speed changes. */
export function rescaleClipAnims(c: Clip, factor: number) {
  forEachAnim(c, (a) =>
    a.keyframes?.length
      ? { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time * factor })) }
      : a
  )
  if (c.fadeIn) c.fadeIn *= factor
  if (c.fadeOut) c.fadeOut *= factor
}

/** THE ripple primitive: every clip on `trackIds` (minus `skip`) whose start
    is at or right of `t` moves by `dt`. A clip spanning t does not move —
    callers trim it. Lock-agnostic: callers pass the tracks they may move. */
export function shiftAfter(p: Project, t: number, dt: number, trackIds: Iterable<string>, skip?: Set<string>) {
  const ids = new Set(trackIds)
  for (const tr of p.tracks) {
    if (!ids.has(tr.id)) continue
    for (const c of tr.clips) if (c.start >= t - 1e-6 && !skip?.has(c.id)) c.start += dt
  }
}

/** Gaps between the clips of one track, left to right (not the lead-in). */
function gapsOf(clips: Clip[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let end = -Infinity
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    if (c.start > end + 1e-6 && end > -Infinity) out.push([end, c.start])
    end = Math.max(end, c.start + c.duration)
  }
  return out
}

/** What deleting `gone` leaves EMPTY: their spans minus what `kept` still covers. */
function freedSpans(gone: Clip[], kept: Clip[]): Array<[number, number]> {
  let spans: Array<[number, number]> = []
  for (const c of [...gone].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1]
    if (last && c.start <= last[1] + 1e-6) last[1] = Math.max(last[1], c.start + c.duration)
    else spans.push([c.start, c.start + c.duration])
  }
  for (const k of kept) {
    const ka = k.start, kb = k.start + k.duration
    spans = spans.flatMap(([a, b]): Array<[number, number]> =>
      kb <= a + 1e-6 || ka >= b - 1e-6 ? [[a, b]]
        : [...(ka > a + 1e-6 ? [[a, ka] as [number, number]] : []), ...(kb < b - 1e-6 ? [[kb, b] as [number, number]] : [])])
  }
  return spans
}

/** Lift a range off every unlocked track: clips inside go, clips across it
    are trimmed or split. Leaves the hole (extractRange closes it). */
/** trimClip's edit on a cloned project: the clip and its unlocked twins
    (returned); null when the clip is missing or on a locked track. */
function trimInPlace(p: Project, clipId: string, edge: 'in' | 'out', time: number) {
  const first = findClip(p, clipId)
  if (!first || first.track.locked) return null
  // linked partners trim together
  const targets = withLinked(p, [clipId])
    .map((id) => findClip(p, id))
    .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)
  for (const f of targets) {
    const c = f.clip
    const speed = c.speed || 1
    const asset = c.assetId ? p.assets.find((a) => a.id === c.assetId) : undefined
    if (edge === 'in') {
      const end = c.start + c.duration
      let ns = Math.min(toFrame(Math.max(0, time), p.fps), toFrame(end - 0.05, p.fps, Math.floor))
      let delta = ns - c.start
      // can't reveal media before the source start: the first frame inside it
      if (c.inPoint + delta * speed < 0) {
        ns = toFrame(c.start - c.inPoint / speed, p.fps, Math.ceil)
        delta = ns - c.start
      }
      c.inPoint = Math.max(0, c.inPoint + delta * speed)
      c.start = ns
      c.duration = end - ns
      shiftClipAnims(c, -delta) // keyframes stay glued to the content
    } else {
      let nd = frameEnd(p.fps, c.start, c.start + Math.max(0.05, time - c.start)) - c.start
      if (asset && asset.kind !== 'image' && c.freezeAt === undefined) {
        // edge trim never reveals more than the source (unless already looping; a freeze is not bound by it)
        const maxOut = Math.max((asset.duration - c.inPoint) / speed, c.duration)
        if (nd > maxOut + 1e-9) nd = frameEnd(p.fps, c.start, c.start + maxOut, Math.floor) - c.start
      }
      c.duration = nd
    }
  }
  return targets
}

/** The largest part of `want` that every edge of `apply` can take: it runs on
    a scratch copy and returns how far each edge really moved (a trim clamps at
    the source and at one frame); the edit then runs once with that. */
function settle(p: Project, want: number, apply: (q: Project, d: number) => number[]): number {
  let d = want
  for (const g of apply(cloneProject(p), want)) d = want > 0 ? Math.min(d, Math.max(0, g)) : Math.max(d, Math.min(0, g))
  return Math.abs(d) < 1e-9 ? 0 : d
}

/** Roll the cut after `leftId` by `d`: left's end and right's start (and their
    twins') move together; returns how far each actually went. */
function rollIn(p: Project, leftId: string, rightId: string, d: number): number[] {
  const L = findClip(p, leftId)?.clip
  const R = findClip(p, rightId)?.clip
  if (!L || !R) return [0]
  const le = L.start + L.duration
  const rs = R.start
  if (!trimInPlace(p, leftId, 'out', le + d) || !trimInPlace(p, rightId, 'in', rs + d)) return [0]
  return [L.start + L.duration - le, R.start - rs]
}

/** Slide `clipId` (and its twins) by `d` with their source: the butted
    neighbours' facing edges follow; with no neighbour the gap takes it, down
    to the next clip or 0. Returns how far each edge could go. */
function slideIn(p: Project, clipId: string, d: number): number[] {
  const own = new Set(withLinked(p, [clipId]))
  const targets = [...own].map((id) => findClip(p, id)).filter((x): x is NonNullable<typeof x> => !!x)
  if (targets.some((f) => f.track.locked)) return [0]
  // neighbours are found before anything moves: a trim takes the twins along
  const plan = targets.map(({ track, clip: c }) => {
    const a = c.start, b = c.start + c.duration
    const others = track.clips.filter((o) => !own.has(o.id))
    return {
      c, a, b,
      left: others.find((o) => Math.abs(o.start + o.duration - a) < 1e-6),
      right: others.find((o) => Math.abs(o.start - b) < 1e-6),
      floor: Math.max(0, ...others.filter((o) => o.start + o.duration <= a + 1e-6).map((o) => o.start + o.duration)),
      ceil: Math.min(Infinity, ...others.filter((o) => o.start >= b - 1e-6).map((o) => o.start))
    }
  })
  const got: number[] = []
  for (const { c, a, b, left, right, floor, ceil } of plan) {
    if (left) { trimInPlace(p, left.id, 'out', a + d); got.push(left.start + left.duration - a) }
    else got.push(Math.max(d, floor - a))
    if (right) { trimInPlace(p, right.id, 'in', b + d); got.push(right.start - b) }
    else got.push(Math.min(d, ceil - b))
    c.start = a + d
  }
  return got
}

/** Cut `c` at `t` in place and push the right half onto `track`; halves of a
    linked pair stay linked pairwise through `rightLinks` (linkId → new one). */
function splitClipAt(track: Track, c: Clip, t: number, rightLinks: Map<string, string>): Clip {
  const offset = t - c.start
  let linkId: string | undefined
  if (c.linkId) {
    if (!rightLinks.has(c.linkId)) rightLinks.set(c.linkId, uid())
    linkId = rightLinks.get(c.linkId)
  }
  const right: Clip = {
    ...clone(c),
    id: uid(),
    start: t,
    duration: c.duration - offset,
    inPoint: c.inPoint + offset * (c.speed || 1),
    fadeIn: 0,
    linkId
  }
  shiftClipAnims(right, -offset)
  c.duration = offset
  c.fadeOut = 0
  track.clips.push(right)
  return right
}

/** `trackIds` plus the unlocked tracks of the twins of every clip that ends
    right of `t` on them — a ripple there must take the other half of each
    A/V pair along, or the pair desyncs. */
function rippleTracks(p: Project, trackIds: Iterable<string>, t: number): string[] {
  const ids = new Set(trackIds)
  for (let grew = true; grew;) {
    grew = false
    const links = new Set(p.tracks.filter((tr) => ids.has(tr.id))
      .flatMap((tr) => tr.clips.filter((c) => c.linkId && c.start + c.duration > t + 1e-6).map((c) => c.linkId)))
    for (const tr of p.tracks) {
      if (tr.locked || ids.has(tr.id) || !tr.clips.some((c) => c.linkId && links.has(c.linkId))) continue
      ids.add(tr.id)
      grew = true
    }
  }
  return [...ids]
}

/** Make room for `len` at `t` on the receiving tracks (and their twins'):
    a clip across t is split, everything from t on moves right. */
function openGap(p: Project, t: number, len: number, trackIds: Iterable<string>, skip: Set<string>) {
  const ids = rippleTracks(p, trackIds, t)
  const rightLinks = new Map<string, string>()
  for (const tr of p.tracks) {
    if (!ids.includes(tr.id)) continue
    for (const c of [...tr.clips]) {
      if (!skip.has(c.id) && c.start < t - 1e-6 && c.start + c.duration > t + 1e-6) splitClipAt(tr, c, t, rightLinks)
    }
  }
  shiftAfter(p, t, len, ids, skip)
}

/** Copies of the clips `ids` (unlocked tracks only) moved by `dt` on their own
    tracks; the copies of a pair are a pair of their own. Returns the new ids. */
function copyClips(p: Project, ids: string[], dt: number): string[] {
  const want = new Set(ids)
  const links = new Map<string, string>()
  const out: string[] = []
  for (const tr of p.tracks) {
    if (tr.locked) continue
    for (const c of tr.clips.filter((x) => want.has(x.id))) {
      const copy: Clip = { ...clone(c), id: uid(), start: c.start + dt }
      if (c.linkId) {
        if (!links.has(c.linkId)) links.set(c.linkId, uid())
        copy.linkId = links.get(c.linkId)
      }
      tr.clips.push(copy)
      out.push(copy.id)
    }
  }
  return out
}

function liftRange(p: Project, r: { start: number; end: number }) {
  const rightLinks = new Map<string, string>()
  for (const tr of p.tracks) {
    if (tr.locked) continue
    const out: Clip[] = []
    for (const c of [...tr.clips]) {
      const end = c.start + c.duration
      const speed = c.speed || 1
      if (end <= r.start + 1e-6 || c.start >= r.end - 1e-6) {
        out.push(c) // outside
      } else if (c.start >= r.start - 1e-6 && end <= r.end + 1e-6) {
        // fully inside — drop
      } else if (c.start < r.start && end > r.end) {
        // covers the range — split into two; right halves of a pair stay linked pairwise
        const right = splitClipAt(tr, c, r.end, rightLinks)
        c.duration = r.start - c.start
        out.push(c, right)
      } else if (c.start < r.start) {
        c.duration = r.start - c.start
        out.push(c)
      } else {
        const cut = r.end - c.start
        c.inPoint += cut * speed
        c.duration = end - r.end
        c.start = r.end
        shiftClipAnims(c, -cut)
        out.push(c)
      }
    }
    tr.clips = out
  }
}

/** Expand clip ids with their linked partners (video + its audio). */
export function withLinked(p: Project, ids: string[]): string[] {
  const out = new Set(ids)
  const links = new Set<string>()
  for (const t of p.tracks) {
    for (const c of t.clips) if (out.has(c.id) && c.linkId) links.add(c.linkId)
  }
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.linkId && links.has(c.linkId)) out.add(c.id)
  }
  return [...out]
}

/**
 * Snap targets for dragging, each switchable in the magnet's menu: edges of all
 * clips (and 0), the playhead, the user's markers, the detected beats.
 * `exclude` takes clip AND marker ids (a dragged marker must not stick to where
 * it started). The magnet itself (N) is read live by `snapTo`, so N mid-drag works.
 */
export function snapPoints(
  p: Project,
  exclude: string | string[],
  playhead: number,
  beats: boolean = useSettings.getState().snapBeats
): number[] {
  const on = (k: SettingKey) => setting<boolean>(k)
  const ex = Array.isArray(exclude) ? exclude : [exclude]
  const edges = on('editing.snapEdges')
  const marks = on('editing.snapMarkers')
  const pts = edges ? [0] : []
  if (on('editing.snapPlayhead')) pts.push(playhead)
  for (const t of edges ? p.tracks : []) {
    for (const c of t.clips) {
      if (ex.includes(c.id)) continue
      pts.push(c.start, c.start + c.duration)
    }
  }
  for (const m of p.markers ?? []) {
    if (ex.includes(m.id)) continue
    if (isMusicMarker(m) ? !beats : !marks) continue
    pts.push(m.time)
    // a pause is snapped to at both ends (a cut lands where the music returns)
    if (m.kind === 'pause' && m.end !== undefined) pts.push(m.end)
  }
  return pts
}

/**
 * The nearest point within «Радиус прилипания» (screen px → seconds at `zoom`),
 * else `t`. Nothing snaps while the magnet (N) is off.
 */
export function snapTo(t: number, points: number[], zoom: number): number {
  if (!setting<boolean>('editing.snap')) return t
  let best = t
  let bestD = setting<number>('editing.snapRadius') / zoom
  for (const p of points) {
    const d = Math.abs(p - t)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

interface SettingsState {
  /** main's copy (shared/settings.ts): the file's diff and the env overrides */
  snap: SettingsSnapshot
  lang: 'ru' | 'en'
  /** uniform lane height for all tracks, px */
  trackH: number
  /** clips, the range and markers snap to detected beats (default on) */
  snapBeats: boolean
  /** «Подтверждать удаление»: deleting a track with clips asks first (default on; D5 row) */
  confirmDelete: boolean
  /** «Лимитер в превью»: the preview's master is limited at −1 dBFS like the export (default on; D5 row) */
  previewLimiter: boolean
  effective(key: SettingKey): { value: SettingValue; source: SettingSource }
  /** change one setting (null = back to its default); main writes it to userData/settings.json */
  set(key: SettingKey, value: SettingValue | null): void
  setLang(l: 'ru' | 'en'): void
  setTrackH(h: number): void
  setSnapBeats(v: boolean): void
  setConfirmDelete(v: boolean): void
  setPreviewLimiter(v: boolean): void
}

/** the named fields the components read, from the effective values */
const settingFields = (snap: SettingsSnapshot) => {
  const v = (k: SettingKey) => effective(k, snap).value
  return {
    snap,
    lang: v('general.lang') as 'ru' | 'en',
    trackH: v('editing.trackHeight') as number,
    snapBeats: v('editing.snapBeats') as boolean,
    confirmDelete: v('editing.confirmDelete') as boolean,
    previewLimiter: v('playback.previewLimiter') as boolean
  }
}

/**
 * Main's settings, read synchronously on boot. The values that used to live in
 * localStorage move over once: a legacy key main has no value for is sent to
 * main, and removed here only after main has written it.
 */
// node checks bundle this store without a window
const kadrApi = () => (typeof window === 'undefined' ? undefined : window.kadr)

function bootSettings(): SettingsSnapshot {
  const snap: SettingsSnapshot = kadrApi()?.settingsGet?.() ?? { user: {}, env: {} }
  const ls = typeof localStorage === 'undefined' ? null : localStorage
  if (!ls) return snap
  const patch: SettingsDiff = {}
  const legacy: string[] = []
  for (const [k, d] of Object.entries(SETTINGS) as [SettingKey, SettingDef][]) {
    const raw = d.legacy ? ls.getItem(d.legacy) : null
    if (raw === null) continue
    legacy.push(d.legacy!)
    const v = fromLegacy(k, raw)
    if (snap.user[k] === undefined && v !== undefined && v !== d.default) patch[k] = v
  }
  if (!legacy.length) return snap
  const user = { ...snap.user, ...patch }
  void kadrApi()?.settingsSet?.(patch)
    .then(() => legacy.forEach((k) => ls.removeItem(k)))
    .catch((err) => logWarn(tr('logStore'), `${tr('storeWriteFail')}: settings.json`, err))
  return { ...snap, user }
}

/** a setting's value now (shared/settings.ts) — for code outside React */
export const setting = <T extends SettingValue = SettingValue>(key: SettingKey): T =>
  useSettings.getState().effective(key).value as T

export const useSettings = create<SettingsState>((set, get) => ({
  ...settingFields(bootSettings()),
  effective: (key) => effective(key, get().snap),
  set: (key, value) => {
    const cur = get().snap
    const h = value === null ? undefined : healValue(key, value)
    if (value !== null && h === undefined) return
    const user = { ...cur.user }
    if (h === undefined || h === SETTINGS[key].default) delete user[key]
    else user[key] = h
    set(settingFields({ ...cur, user }))
    // the write can fail (read-only userData): the value holds for this session, the log says why
    kadrApi()?.settingsSet?.({ [key]: value })
      .catch((err) => logWarn(tr('logStore'), `${tr('storeWriteFail')}: settings.json`, err))
  },
  setPreviewLimiter: (v) => get().set('playback.previewLimiter', v),
  setConfirmDelete: (v) => get().set('editing.confirmDelete', v),
  setLang: (l) => get().set('general.lang', l),
  setTrackH: (h) => get().set('editing.trackHeight', h),
  setSnapBeats: (v) => get().set('editing.snapBeats', v)
}))

// ---------------------------------------------------------------------------
// Pose presets: a named snapshot of one keyframe's worth of mask/transform
// values. Saved across projects and sessions; applying one writes the values
// through the regular keyframe path (a keyframe lands at the playhead when
// the parameter is animated or link-to-timeline is on).
//
// Source of truth is a JSON file in userData (over IPC) — localStorage is
// only a warm cache: the renderer profile can be locked by a second app
// instance and silently lose writes.

export type { PosePreset, PoseShape } from '@shared/types'
import type { PosePreset } from '@shared/types'

interface PosePresetState {
  presets: PosePreset[]
  savePreset(p: Omit<PosePreset, 'id'>): void
  deletePreset(id: string): void
}

const POSE_LS_KEY = 'kadr.posePresets'
const POSE_FILE = 'pose-presets'

function loadPoseCache(): PosePreset[] {
  try {
    const raw = localStorage.getItem(POSE_LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persistPosePresets(presets: PosePreset[]) {
  void saveUserStore(POSE_FILE, presets)
  try {
    localStorage.setItem(POSE_LS_KEY, JSON.stringify(presets))
  } catch { /* cache only */ }
}

export const usePosePresets = create<PosePresetState>((set) => ({
  presets: loadPoseCache(),
  savePreset: (p) =>
    set((s) => {
      const presets = [...s.presets, { ...p, id: uid() }]
      persistPosePresets(presets)
      return { presets }
    }),
  deletePreset: (id) =>
    set((s) => {
      const presets = s.presets.filter((x) => x.id !== id)
      persistPosePresets(presets)
      return { presets }
    })
}))

// adopt the file store on startup; migrate presets saved before it existed
;(async () => {
  try {
    const fromFile = await window.kadr.readUserStore(POSE_FILE)
    if (Array.isArray(fromFile) && fromFile.length) {
      usePosePresets.setState({ presets: fromFile as PosePreset[] })
      try {
        localStorage.setItem(POSE_LS_KEY, JSON.stringify(fromFile))
      } catch { /* cache only */ }
    } else {
      const cached = loadPoseCache()
      if (cached.length) void saveUserStore(POSE_FILE, cached)
    }
  } catch { /* file store unavailable — cache keeps working */ }
})()

// ---- effect presets: named Effect[] snapshots, same storage scheme --------

export type { FxPreset } from '@shared/types'
import type { FxPreset } from '@shared/types'

interface FxPresetState {
  presets: FxPreset[]
  savePreset(p: Omit<FxPreset, 'id'>): void
  deletePreset(id: string): void
}

const FX_LS_KEY = 'kadr.fxPresets'
const FX_FILE = 'fx-presets'

function loadFxCache(): FxPreset[] {
  try {
    const raw = localStorage.getItem(FX_LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persistFxPresets(presets: FxPreset[]) {
  void saveUserStore(FX_FILE, presets)
  try {
    localStorage.setItem(FX_LS_KEY, JSON.stringify(presets))
  } catch { /* cache only */ }
}

export const useFxPresets = create<FxPresetState>((set) => ({
  presets: loadFxCache(),
  savePreset: (p) =>
    set((s) => {
      const presets = [...s.presets, { ...p, id: uid() }]
      persistFxPresets(presets)
      return { presets }
    }),
  deletePreset: (id) =>
    set((s) => {
      const presets = s.presets.filter((x) => x.id !== id)
      persistFxPresets(presets)
      return { presets }
    })
}))

;(async () => {
  try {
    const fromFile = await window.kadr.readUserStore(FX_FILE)
    if (Array.isArray(fromFile) && fromFile.length) {
      useFxPresets.setState({ presets: fromFile as FxPreset[] })
      try {
        localStorage.setItem(FX_LS_KEY, JSON.stringify(fromFile))
      } catch { /* cache only */ }
    }
  } catch { /* file store unavailable — cache keeps working */ }
})()

export { MAX_ZOOM, MIN_ZOOM }
/** The mounted timeline's view commands (Shift+Z, Alt+Z, -/=), set by Timeline.tsx:
    both go through its zoom-gesture commit, so culling and the anchor stay right. */
export const timelineView: {
  fit: ((a: number, b: number) => void) | null
  zoomBy: ((k: number) => void) | null
} = { fit: null, zoomBy: null }

export interface TimeRange {
  start: number
  end: number
}

/** what «Вставить атрибуты» (Ctrl+Alt+V) can carry over */
export type AttrPart = 'transform' | 'effects' | 'volume' | 'speed' | 'masks'
export const ATTR_PARTS: AttrPart[] = ['transform', 'effects', 'volume', 'speed', 'masks']

interface ClipboardItem {
  kind: TrackKind
  trackId: string
  clip: Clip
}

/** A history entry remembers the state before the action plus its name (i18n key). */
interface HistEntry {
  project: Project
  label: string
}

/** the project as it was when an agent turn began (card B8) */
export interface AgentCheckpoint {
  project: Project
  path: string | null
  at: number
  /** the live object it was copied from: an unchanged project is not checkpointed twice */
  source: Project
}
const AGENT_CHECKPOINTS = 10

interface EditorState {
  project: Project
  projectPath: string | null
  selection: string[]
  playhead: number
  playing: boolean
  /** the clock's signed rate: L/J step it through 1, 2, 4, 8 (player.ts); a pause brings it back to 1 */
  playRate: number
  /** Ctrl+L: playback wraps inside the range, or the whole timeline */
  loop: boolean
  /** play in→out (/): where playback stops; a pause forgets it */
  playEnd: number | null
  previewLoading: boolean
  /** the preview's GL context died (GPU reset); nothing can be drawn until it is back */
  previewGpuLost: boolean
  /** timeline pixels per second */
  zoom: number
  exportOpen: boolean
  /** in/out fragment (Shift+drag on the timeline) */
  range: TimeRange | null
  /** clip whose animation/mask panel is open (double-click) */
  animClipId: string | null
  /** «Привязка к таймлайну»: editing a static parameter records a key at the
      playhead — the animation editor and the preview gizmo alike */
  animLinked: boolean
  /** video track whose Track Motion editor is open */
  motionTrackId: string | null
  /** absolute time of a keyframe being dragged in a mini-timeline,
      highlighted on the main timeline while the drag lasts */
  kfMarker: number | null
  clipboard: ClipboardItem[]
  past: HistEntry[]
  future: HistEntry[]
  /** ring of pre-turn snapshots of the embedded Claude, OUTSIDE the undo stack:
      a turn of more than 50 edits pushes its own start out of undo */
  agentCheckpoints: AgentCheckpoint[]

  setProject(p: Project, path?: string | null): void
  setProjectPath(path: string | null): void
  /** a Claude chat of this project was just talked to: record it, last = latest.
   *  Always a new project object, so the unsaved dot and autosave see that the
   *  transcript in the file is behind. No undo entry: a chat is not an edit. */
  noteClaudeChat(id: string): void
  /** Snapshot current project; call once before a discrete edit or drag. */
  pushHistory(label: string): void
  undo(): void
  redo(): void
  /** an agent turn begins (main calls it before the turn's first /eval) */
  agentCheckpoint(): void
  /** restore the newest checkpoint as one undo entry and drop it; false when there is none */
  revertAgentTurn(): boolean

  addAsset(a: MediaAsset): void
  /** Remove media files from the bin AND every timeline clip that uses them
      (linked twins share the assetId) — one undo entry. */
  removeAssets(assetIds: string[]): void
  /** H5 bin folders, one undo step each: a new folder (holding these assets) → its id;
      rename; move assets/folders into a folder (null = root); delete a folder — what it
      held goes to the root, never away (shared/bins.ts) */
  addBin(name: string, parentId: string | null, assetIds: string[]): string
  renameBin(id: string, name: string): void
  moveToBin(assetIds: string[], binIds: string[], target: string | null): void
  removeBin(id: string): void
  /** Point assets at other files (relink of offline media): each given asset
      replaces the one with its id — one undo entry. */
  relinkAssets(fresh: MediaAsset[]): void
  /** «Собрать проект» (H8): every path found in `map` (old → new) rewritten — media, transcripts,
      voice-over scripts and runs — one undo step; nothing to rewrite pushes none */
  relocatePaths(map: Record<string, string>): void
  /** register transcript/text docs in the sources (one undo entry) */
  addTexts(docs: TextDoc[]): void
  /** Land a finished voice-over — asset, script docs, run record and clip — as
      one undoable step. */
  /** Land a spliced voice-over: new audio, remapped clips, rippled timeline —
      one undo entry. Returns null with a reason when it cannot be done safely. */
  applyVoiceSplice(v: {
    runId: string
    oldAssetId: string
    newAsset: MediaAsset
    /** каждая заменённая фраза и дефекты, которые ею закрыты */
    units: Array<{ cut0: number; cut1: number; patchDur: number; ids: string[] }>
    newDuration: number
    ripple: boolean
    rippleAllTracks: boolean
  }): { delta: number; warnings: string[] } | { error: string }
  /** Detector pass: run metadata + its findings, one undo entry. */
  applyCheckResult(runId: string, runPatch: Partial<VoiceRun>, defects: AudioDefect[]): void
  /** A defect the user spotted themselves. */
  addUserDefect(d: AudioDefect): void
  /** The user's verdict on one or many defects. */
  setDefectState(ids: string | string[], state: DefectState, patch?: Partial<AudioDefect>): void
  /** Edge drag and other live edits — the CALLER pushes history once. */
  updateDefect(id: string, patch: Partial<AudioDefect>): void
  removeDefects(ids: string | string[]): void
  addVoiceOver(v: {
    asset: MediaAsset
    run: VoiceRun
    texts?: TextDoc[]
    trackId?: string | null
    at: number
  }): { clipId: string; trackId: string } | null
  removeText(id: string): void
  /** place a remotion fragment clip on the topmost free video track */
  insertFragmentClip(fragmentId: string, meta: FragmentSpec, start: number, duration: number): string
  /** Patch asset metadata (e.g. a freshly built proxy path); no history. */
  updateAsset(assetId: string, patch: Partial<MediaAsset>): void
  addTrack(kind: TrackKind): void
  addTrackNear(refTrackId: string): void
  removeTrack(trackId: string): void
  moveTrack(trackId: string, toIndex: number): void
  updateTrack(trackId: string, patch: Partial<Track>): void

  insertClipFromAsset(assetId: string, trackId: string | null, at: number, ripple?: boolean): void
  /** Place several assets back-to-back starting at `at` (one undo entry);
      audio assets go to an audio track regardless of the drop lane. `ripple`
      (a Shift-drop) inserts: what is right of `at` on the receiving tracks and
      their twins' moves right by the inserted length, a clip across `at` is split. */
  insertClipsFromAssets(assetIds: string[], trackId: string | null, at: number, ripple?: boolean): void
  insertTextClip(at: number): void
  /** Add a track-independent timeline marker (auto-numbered unless `opts.label`); returns id.
      `opts.kind`/`end` make a music marker (the agent's kadr_marker). One undo step. */
  addMarker(time: number, opts?: { label?: string; kind?: TimelineMarker['kind']; end?: number }): string
  moveMarker(id: string, time: number): void
  removeMarker(id: string): void
  /** one undo step; an unchanged or blank label changes nothing */
  renameMarker(id: string, label: string): void
  /**
   * Replace the music markers (beats, sections, pauses) inside
   * [range.start, range.end] with `beats` and `extra` (project seconds) — one
   * undo entry. The user's own markers are never touched. Returns how many
   * beats were placed.
   */
  setBeatMarkers(beats: { time: number; strength: number; strong: boolean; bar?: number; beatInBar?: number }[],
    range: { start: number; end: number },
    extra?: {
      sections?: { start: number; end: number; label: MusicSectionLabel; energy: number; startBar?: number }[]
      pauses?: { start: number; end: number }[]
    }): number
  /** Remove the music markers (inside `range`, or all of them) — one undo entry; returns the count. */
  clearBeatMarkers(range?: { start: number; end: number }): number
  /** I6: replace the scene-cut markers inside [range] with `times` (project s,
      landed on frames) — one undo entry, none when nothing changes. */
  setSceneMarkers(times: number[], range: { start: number; end: number }): void
  /**
   * Put an audio asset on the timeline at `at` WITHOUT touching anything that
   * is already there: the first unlocked audio track that is free over the
   * clip's span, or a new one. (insertClipsFromAssets drops it onto the first
   * audio track regardless — and overlapping audio on one track crossfades,
   * which would quietly duck the music under a click.) The asset is reused when
   * one with the same path is already in the bin. One undo entry.
   */
  placeAudio(asset: Omit<MediaAsset, 'id'>, at: number,
    opts?: { gain?: number; label?: string; history?: string }): { clipId: string; trackId: string; assetId: string }
  /** Change the project's name, size or fps. One undo step per `session`
   *  (the Inspector passes one per focus of a field, so typing "1080" is one
   *  step); a call without a session is a step of its own. A patch that
   *  changes nothing pushes nothing. */
  updateProjectSettings(patch: ProjectSettingsPatch, session?: number): void
  updateClip(clipId: string, patch: Partial<Clip>): void
  /** the same patch on several clips, one update (the caller pushes history) */
  setClipProps(ids: string[], patch: Partial<Clip>): void
  /** Shift+E: switch the selection off, or back on when all of it is off;
      one undo step; locked tracks are left alone */
  toggleDisabled(): void
  /** Change speed/duration, rescaling keyframes and fades to stay on content.
      Optional `start` moves the clip too (a speed drag from the LEFT edge
      keeps the right edge anchored). */
  setClipSpeed(clipId: string, speed: number, duration: number, start?: number): void
  /** setClipSpeed for several clips in one update (group speed change). */
  setClipSpeeds(entries: { id: string; speed: number; duration: number; start?: number }[]): void
  /** Change duration (loop-extend); linked partners follow. */
  setClipDuration(clipId: string, duration: number): void
  /** Pick the transition for a clip's incoming overlap ('none' = hard cut). */
  setTransition(clipId: string, type: string | null): void
  /** Set edge (tip) effects on clip heads/tails; one undo entry for the batch. */
  setEdgeTransitions(
    entries: { clipId: string; edge: 'in' | 'out'; type: string | null; duration?: number }[]
  ): void
  /** Unlink selected linked clips, or link an audio+video pair. */
  toggleLinkSelection(): void
  moveClip(clipId: string, trackId: string, start: number): void
  /** Batch-update clip positions (group drag), optionally across tracks. */
  setClipStarts(entries: { id: string; start: number; trackId?: string }[]): void
  trimClip(clipId: string, edge: 'in' | 'out', time: number): void
  /** trimClip that moves what follows (Shift+drag of an edge): 'out' puts the
      end at `time`; 'in' takes `time − start` off the head (negative gives it
      back) and KEEPS the start. Everything right of the old end on the clip's
      and its twins' tracks moves by the length change. No history (the gesture
      pushes once, like trimClip). */
  rippleTrim(clipId: string, edge: 'in' | 'out', time: number): void
  /** Roll: the cut between `leftId` and the clip after it moves to `t` —
      left's end and right's start together, with their twins; the sum of
      both lengths stays. Stops where EITHER side hits a limit. No history. */
  rollEdit(leftId: string, rightId: string, t: number): void
  /** Slip: the clip shows its source `dt` timeline seconds later (earlier if
      negative), start and length kept, twins along; a still is a no-op. No history. */
  slip(clipId: string, dt: number): void
  /** Slide: the clip moves by `dt` with its source; the butted neighbours'
      facing edges follow, their outer edges stay. No history. */
  slide(clipId: string, dt: number): void
  /** Q ('in') / W ('out'): ripple-trim the clip under the playhead to it — the
      selected one, else the top track's — one undo step. Q parks the playhead
      at the clip's start, where the cut now is. */
  trimToPlayhead(edge: 'in' | 'out'): void
  splitAtPlayhead(): void
  /** Cut every unlocked clip across `t` on `trackIds` (default: every track), the
      twins of those clips too — one undo step; returns the right halves' ids. */
  splitAt(t: number, trackIds?: string[]): string[]
  deleteSelection(): void
  /** Delete clips (default: the selection) with their linked twins and close
      what they leave empty on their tracks — one undo step. */
  rippleDelete(ids?: string[]): void
  /** Close the gap between clips around `time` on a track (Ctrl+click). */
  closeGapAt(trackId: string, time: number): void
  /** Close every gap between clips on these unlocked tracks (the lead-in stays). */
  closeGaps(trackIds: string[] | 'all'): void
  copySelection(): void
  copyRange(): void
  deleteRange(): void
  /** Delete a range (default: the current one) on every unlocked track and
      close it everywhere; markers right of it follow — one undo step. */
  extractRange(range?: { start: number; end: number }): void
  /** extractRange over several ranges (silence removal, proposals) — still ONE
      undo step; overlapping ranges merge. */
  extractRanges(ranges: { start: number; end: number }[]): void
  /** `ripple` (Ctrl+Shift+V) inserts, like a Shift-drop. */
  pasteAtPlayhead(ripple?: boolean): void
  /** Ctrl+X: copy the selection (else the range) and lift it — one undo step, no ripple. */
  cut(): void
  /** Copies of the clips left where they are (the copy-drag moves the originals
      off them); no undo step of its own — the drag pushed one. Returns the new ids. */
  duplicateInPlace(ids: string[]): string[]
  /** «Дублировать»: a copy of the selection right after it, selected — one undo step. */
  duplicateSelection(): void
  /** Ctrl+Alt+V: the chosen parts of the copied clip onto the selection — one undo step. */
  pasteAttributes(parts: AttrPart[]): void
  /** Shift+F: split the footage under the playhead (the selected clip, else the top
      unlocked video track's) and insert a `len` s still of that frame, rippling what follows. */
  freezeFrame(len?: number): void
  /** I / O: the range's in / out at the playhead; the other end is kept while it
      still lies on its side, else it becomes the timeline's end / 0. */
  markIn(): void
  markOut(): void
  /** X: the range = the clip under the playhead (the selected one, else the top unlocked track's). */
  markClip(): void
  /** Up (-1) / Down (1): the playhead to the previous / next clip edge on the unlocked tracks. */
  goToEdit(dir: 1 | -1): void
  /** Ctrl+A: every clip on the unlocked tracks. */
  selectAll(): void

  select(ids: string[]): void
  toggleSelect(id: string): void
  setAnimClip(id: string | null): void
  setMotionTrack(id: string | null): void
  setKfMarker(t: number | null): void
  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  /** L (1) / J (-1): play that way, or double the rate up to 8× if already playing that way */
  shuttle(dir: 1 | -1): void
  toggleLoop(): void
  /** / : play the range (or the whole timeline) from its in, stopping at its out */
  playInOut(): void
  setPreviewLoading(l: boolean): void
  setPreviewGpuLost(lost: boolean): void
  setZoom(z: number): void
  setExportOpen(open: boolean): void
  setRange(r: TimeRange | null): void
}

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o))

/** Asset fields DERIVED from the media file: the probe in the main process
    (electron/ffmpeg.ts) assigns them once, wholesale, and from then on nothing
    anywhere writes them — the timeline and the media bin only read. That is the
    invariant cloneProject() rests on; e2e28 fails if a copy stops sharing them. */
const ASSET_BLOBS = new Set(['waveform', 'thumbnail', 'thumbnailEnd'])

/** JSON.stringify silently drops these, so a faithful copy must drop them too. */
const dropped = (v: unknown) =>
  v === undefined || typeof v === 'function' || typeof v === 'symbol'

const cloneAsset = (a: MediaAsset): MediaAsset => {
  // a script-written project can hold junk in the list (kadr_eval writes
  // straight into the store); copy it exactly as a plain deep copy would
  if (!a || typeof a !== 'object') return clone(a)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(a)) {
    const v = (a as unknown as Record<string, unknown>)[key]
    if (dropped(v)) continue
    // the blob object itself travels into the copy — not a duplicate of it
    out[key] = ASSET_BLOBS.has(key) ? v : clone(v)
  }
  return out as unknown as MediaAsset
}

/**
 * Deep copy of a project. Every mutation makes one and so does every history
 * entry, i.e. twice per edit, so its cost is felt directly in the hand holding
 * the mouse — and its size is what the undo stack retains.
 *
 * Everything is copied except the assets' derived blobs, which are shared.
 * They are almost the whole project: on a real 78 MB project the waveforms are
 * 78.1 of it, and the numbers that follow are why this function exists —
 * a full copy took 248 ms and 50 history entries held 3.82 GB, which is
 * exactly where V8 gives up ("JavaScript heap out of memory", measured three
 * times in one working day). Sharing the blobs: 0.8 ms and 5.9 MB.
 *
 * The copy is built key by key rather than by blanking the blobs and round
 * tripping, so the live project is never modified even for an instant, key
 * order is preserved, and the result serializes byte for byte like a plain
 * deep copy — which e2e28 checks, on the project AND on the file written from
 * a restored one, because a copy that quietly lost a waveform would be
 * invisible until the day someone reopened that project.
 */
const cloneProject = (p: Project): Project => {
  if (!p || typeof p !== 'object' || !Array.isArray(p.assets)) return clone(p)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(p)) {
    const v = (p as unknown as Record<string, unknown>)[key]
    if (dropped(v)) continue
    out[key] = key === 'assets' ? (v as MediaAsset[]).map(cloneAsset) : clone(v)
  }
  return out as unknown as Project
}

export type ProjectSettingsPatch = Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>>
/** the undo step the last settings session pushed: merge only while it is
 *  still the top of the stack (any other edit or an undo splits the session) */
const settingsMark: { session?: number; entry?: unknown } = {}

/** Ids of the unlocked clips across `t` (a frame) that `want` keeps, on `onTracks` if given. */
function splitTargets(p: Project, t: number, want: (c: Clip) => boolean, onTracks?: Set<string>): string[] {
  return p.tracks.flatMap((tr) =>
    tr.locked || (onTracks && !onTracks.has(tr.id)) ? [] : tr.clips.filter((c) =>
      want(c) && t > c.start + 0.02 && t < c.start + c.duration - 0.02).map((c) => c.id))
}

/** Split `ids` at `t` as one undo step; halves of a linked pair stay linked pairwise. */
function splitClips(
  get: () => EditorState,
  set: (fn: (s: EditorState) => Partial<EditorState>) => void,
  t: number, ids: string[]
): string[] {
  get().pushHistory('hSplit')
  const newIds: string[] = []
  set((st) => {
    const p = cloneProject(st.project)
    const rightLinks = new Map<string, string>()
    for (const id of ids) {
      const f = findClip(p, id)
      if (f) newIds.push(splitClipAt(f.track, f.clip, t, rightLinks).id)
    }
    return { project: p }
  })
  return newIds
}

export const useEditor = create<EditorState>((set, get) => ({
  project: newProject(),
  projectPath: null,
  selection: [],
  playhead: 0,
  playing: false,
  playRate: 1,
  loop: false,
  playEnd: null,
  previewLoading: false,
  previewGpuLost: false,
  zoom: 60,
  exportOpen: false,
  range: null,
  animClipId: null,
  animLinked: false,
  motionTrackId: null,
  kfMarker: null,
  clipboard: [],
  past: [],
  future: [],
  agentCheckpoints: [],

  setProject: (project, path = null) =>
    set({
      project: sanitizeProject(project), projectPath: path, past: [], future: [],
      selection: [], playhead: 0, playing: false, playRate: 1, playEnd: null, range: null
    }),
  setProjectPath: (projectPath) => set({ projectPath }),
  noteClaudeChat: (id) =>
    set((s) => ({
      project: { ...s.project, claudeChats: [...(s.project.claudeChats ?? []).filter((c) => c !== id), id] }
    })),

  pushHistory: (label) =>
    set((s) => ({
      past: [...s.past.slice(-49), { project: cloneProject(s.project), label }],
      future: []
    })),
  undo: () =>
    set((s) => {
      if (!s.past.length) return s
      const past = [...s.past]
      const entry = past.pop()!
      return {
        past,
        // chats are not an edit: undoing the clip before one must not drop it
        project: { ...entry.project, claudeChats: s.project.claudeChats },
        future: [{ project: cloneProject(s.project), label: entry.label }, ...s.future],
        // what is still there stays selected: the gizmo and the Inspector survive a Ctrl+Z
        selection: existingClips(entry.project, s.selection)
      }
    }),
  redo: () =>
    set((s) => {
      if (!s.future.length) return s
      const [entry, ...future] = s.future
      return {
        future,
        project: { ...entry.project, claudeChats: s.project.claudeChats },
        past: [...s.past, { project: cloneProject(s.project), label: entry.label }],
        selection: existingClips(entry.project, s.selection)
      }
    }),

  agentCheckpoint: () =>
    set((s) => {
      // ponytail: "unchanged" is object identity — an in-place mutation between two
      // turns (off-convention) keeps the older checkpoint; a JSON compare costs ~250 ms on big projects
      if (s.agentCheckpoints.at(-1)?.source === s.project) return s
      const cp = { project: cloneProject(s.project), path: s.projectPath, at: Date.now(), source: s.project }
      return { agentCheckpoints: [...s.agentCheckpoints.slice(1 - AGENT_CHECKPOINTS), cp] }
    }),
  revertAgentTurn: () => {
    const cp = get().agentCheckpoints.at(-1)
    if (!cp) return false
    get().pushHistory('hAgentRevert')
    set((s) => ({
      // chats are not an edit (as in undo): the conversation stays in the project
      project: s.project.claudeChats === cp.project.claudeChats ? cp.project : { ...cp.project, claudeChats: s.project.claudeChats },
      projectPath: cp.path,
      agentCheckpoints: s.agentCheckpoints.slice(0, -1),
      selection: []
    }))
    return true
  },

  addAsset: (a) =>
    set((s) => ({ project: { ...s.project, assets: [...s.project.assets, a] } })),

  relinkAssets: (fresh) => {
    const byId = new Map(fresh.map((a) => [a.id, a]))
    if (!get().project.assets.some((a) => byId.has(a.id))) return
    get().pushHistory('hRelink')
    set((st) => {
      const p = cloneProject(st.project)
      // a relinked file stays in its bin folder (H5); the fresh probe knows nothing of it
      p.assets = p.assets.map((a) => {
        const f = byId.get(a.id)
        return !f ? a : a.binId ? { ...f, binId: a.binId } : f
      })
      return { project: p }
    })
  },
  relocatePaths: (map) => {
    const next = mapPaths(get().project, (path, kind) => (kind === 'proxy' ? path : map[path] ?? path))
    if (JSON.stringify(projectPaths(next)) === JSON.stringify(projectPaths(get().project))) return
    get().pushHistory('hCollect')
    set({ project: next })
  },
  addBin: (name, parentId, assetIds) => {
    const id = uid()
    get().pushHistory('hBinNew')
    set((st) => {
      const p = cloneProject(st.project)
      p.bins = [...(p.bins ?? []), { id, name, parentId }]
      moveInto(p, assetIds, [], id)
      return { project: p }
    })
    return id
  },
  renameBin: (id, name) => {
    const next = name.trim()
    const b = get().project.bins?.find((x) => x.id === id)
    if (!b || !next || b.name === next) return
    get().pushHistory('hBinRename')
    set((st) => {
      const p = cloneProject(st.project)
      p.bins!.find((x) => x.id === id)!.name = next
      return { project: p }
    })
  },
  moveToBin: (assetIds, binIds, target) => {
    // tried on a copy first: a drop that moves nothing leaves no undo step
    const p = cloneProject(get().project)
    if (!moveInto(p, assetIds, binIds, target)) return
    get().pushHistory('hBinMove')
    set({ project: p })
  },
  removeBin: (id) => {
    const p = cloneProject(get().project)
    if (!dissolveBin(p, id)) return
    get().pushHistory('hBinDelete')
    set({ project: p })
  },

  removeAssets: (assetIds) => {
    const ids = new Set(assetIds)
    const s = get()
    if (!s.project.assets.some((a) => ids.has(a.id))) return
    s.pushHistory('hDeleteMedia')
    set((st) => {
      const p = cloneProject(st.project)
      p.assets = p.assets.filter((a) => !ids.has(a.id))
      // озвучка и её дефекты держатся на ассете: без него они мусор, и
      // sanitizeProject всё равно выбросил бы их при следующей загрузке
      p.voiceRuns = (p.voiceRuns ?? []).filter((r) => !ids.has(r.assetId))
      p.defects = (p.defects ?? []).filter((d) => !ids.has(d.assetId))
      const dead = new Set<string>()
      // clips lose their source — drop them everywhere, locked tracks included
      for (const tr of p.tracks) {
        tr.clips = tr.clips.filter((c) => {
          const doomed = !!c.assetId && ids.has(c.assetId)
          if (doomed) dead.add(c.id)
          return !doomed
        })
      }
      return {
        project: p,
        selection: st.selection.filter((id) => !dead.has(id)),
        animClipId: st.animClipId && dead.has(st.animClipId) ? null : st.animClipId
      }
    })
  },

  applyVoiceSplice: ({ runId, oldAssetId, newAsset, units, newDuration,
                       ripple, rippleAllTracks }) => {
    const s = get()
    const sorted = [...units].sort((a, b) => a.cut0 - b.cut0)
    const total = sorted.reduce((n, u) => n + (u.patchDur - (u.cut1 - u.cut0)), 0)

    /** Source second before the splice → after it. null inside a replaced
        phrase: that audio no longer exists, so nothing may be mapped onto it. */
    const remap = (t: number): number | null => {
      let d = 0
      for (const u of sorted) {
        if (t > u.cut0 + 1e-6 && t < u.cut1 - 1e-6) return null
        if (t >= u.cut1 - 1e-6) d += u.patchDur - (u.cut1 - u.cut0)
      }
      return t + d
    }

    const affected: Array<{ clip: Clip; track: Track; oldStart: number; oldEnd: number
                            inPoint: number; duration: number }> = []
    for (const track of s.project.tracks) {
      for (const clip of track.clips) {
        if (clip.assetId !== oldAssetId) continue
        const speed = clip.speed || 1
        const a = remap(clip.inPoint)
        const b = remap(clip.inPoint + clip.duration * speed)
        if (a === null || b === null || b <= a) {
          // a clip edge sits inside the phrase being replaced: there is no
          // honest answer for where it should land, so we refuse instead of
          // silently mangling the cut the user made
          return { error: trf('eStCutInside', { label: clip.label ?? '' }) }
        }
        affected.push({ clip, track, oldStart: clip.start, oldEnd: clip.start + clip.duration,
                        inPoint: a, duration: (b - a) / speed })
      }
    }
    if (!affected.length) return { error: tr('eStNoClips') }

    // Куда переехала каждая заменённая фраза: её начало на месте (remap не
    // двигает то, что до реза), а конец задаётся длиной вставки. Без этого
    // повторная перегенерация той же фразы резала бы по старым координатам.
    const unitOf = new Map<string, { from: number; to: number }>()
    for (const u of sorted) {
      const from = remap(u.cut0) ?? u.cut0
      for (const id of u.ids) unitOf.set(id, { from, to: from + u.patchDur })
    }

    const warnings: string[] = []
    let dropped = 0
    let straddles = false
    get().pushHistory('hVoiceFix')
    set((st) => {
      const p = cloneProject(st.project)
      p.assets = [...p.assets, newAsset]

      // shift events: after this clip ended, everything moves by d
      const events = affected.map((a) => ({ at: a.oldEnd, d: a.duration - (a.oldEnd - a.oldStart) }))
        .sort((x, y) => x.at - y.at)
      const tracksToRipple = new Set(
        rippleAllTracks ? p.tracks.filter((t) => !t.locked).map((t) => t.id)
                        : affected.map((a) => a.track.id))

      // what does NOT ride the ripple: clips on other tracks, and a clip that
      // STRADDLES the splice — it would have to stretch. Say so rather than pretend.
      const skip = new Set<string>()
      for (const track of p.tracks) {
        for (const c of track.clips) {
          const mine = affected.find((a) => a.clip.id === c.id)
          if (mine) {
            c.assetId = newAsset.id
            c.inPoint = mine.inPoint
            c.duration = mine.duration
            continue
          }
          if (!tracksToRipple.has(track.id)) { skip.add(c.id); continue }
          if (events.some((e) => c.start < e.at - 1e-6 && c.start + c.duration > e.at + 1e-6)) {
            skip.add(c.id)
            straddles = true
          }
        }
      }
      // right to left, so an event's clips are judged where they stood before it.
      // ponytail: a clip pulled left past an EARLIER event (voice copies overlapping
      // on two tracks) would miss that event's shift; one-pass sum if that ever happens
      if (ripple) {
        const all = p.tracks.map((t) => t.id)
        for (const e of [...events].reverse()) shiftAfter(p, e.at, e.d, all, skip)
      }
      if (ripple && straddles) warnings.push(tr('eStStraddle'))
      if (!ripple) warnings.push(tr('eStNoRipple'))

      p.voiceRuns = (p.voiceRuns ?? []).map((r) =>
        r.id === runId ? { ...r, assetId: newAsset.id, duration: newDuration } : r)

      const kept: AudioDefect[] = []
      for (const d of p.defects ?? []) {
        if (d.assetId !== oldAssetId) { kept.push(d); continue }
        const mine = unitOf.get(d.id)
        if (mine) {
          // ГРАНИЦЫ ОБЯЗАНЫ ПЕРЕЕХАТЬ. Раньше здесь менялись только ассет и
          // состояние, а фраза оставалась в координатах ДО склейки — и вторая
          // перегенерация той же фразы резала уже не там, третья ещё дальше, и
          // дорожка портилась. Теперь фраза — это ровно то, что сейчас вставлено.
          kept.push({
            ...d, assetId: newAsset.id, state: 'done', resultAssetId: newAsset.id,
            attempts: (d.attempts ?? 0) + 1,
            src: [mine.from, mine.to],
            phrase: { ...d.phrase, t0: mine.from, t1: mine.to }
          })
          continue
        }
        const a = remap(d.src[0])
        const b = remap(d.src[1])
        if (a === null || b === null) {
          // Звук этой находки заменён. Раньше она превращалась в отметку на всю
          // новую фразу — и свежая, ещё не разобранная запись оказывалась
          // целиком помечена дефектом. Правильно её просто убрать: решение по
          // ней уже выгружено в корпус (это делается ДО склейки), а что теперь
          // в этом месте звучит — знает только новый разбор.
          dropped++
          continue
        }
        const ph0 = remap(d.phrase.t0)
        const ph1 = remap(d.phrase.t1)
        kept.push({ ...d, assetId: newAsset.id, src: [a, b],
                    phrase: { ...d.phrase, t0: ph0 ?? a, t1: ph1 ?? b } })
      }
      p.defects = kept
      return { project: p }
    })
    if (dropped) warnings.push(trf('eStDropped', { n: dropped }))
    return { delta: total, warnings }
  },

  applyCheckResult: (runId, runPatch, defects) => {
    get().pushHistory('hDefects')
    set((s) => {
      const p = cloneProject(s.project)
      p.voiceRuns = (p.voiceRuns ?? []).map((r) => (r.id === runId ? { ...r, ...runPatch } : r))
      // прежние находки ЭТОГО прогона заменяем: повторный разбор — это новая
      // правда о файле, а не добавка к старой. Вердикты пользователя по другим
      // прогонам не трогаем.
      // ВАЖНО для этапа обучения: решения по заменяемым находкам должны быть
      // выгружены в корпус ДО этого вызова — здесь они перестают существовать.
      const keep = (p.defects ?? []).filter((d) => d.runId !== runId || d.origin === 'user')
      p.defects = [...keep, ...defects]
      return { project: p }
    })
  },

  addUserDefect: (d) => {
    get().pushHistory('hDefectUser')
    set((s) => ({ project: { ...s.project, defects: [...(s.project.defects ?? []), d] } }))
  },

  setDefectState: (ids, state, patch) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (!list.length) return
    get().pushHistory('hDefectVerdict')
    const now = Date.now()
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).map(
          (d) => (list.includes(d.id) ? { ...d, ...patch, state, judgedAt: now } : d))
      }
    }))
  },

  updateDefect: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d))
      }
    })),

  removeDefects: (ids) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (!list.length) return
    get().pushHistory('hDefectDelete')
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).filter((d) => !list.includes(d.id))
      }
    }))
  },

  addVoiceOver: ({ asset, run, texts, trackId, at }) => {
    // one history entry for the whole landing: the asset, its script docs, the
    // run record and the clip belong together — undoing half of it would leave
    // a voice-over whose audio or whose script is gone
    get().pushHistory('hSpeak')
    let result: { clipId: string; trackId: string } | null = null
    set((s) => {
      const p = cloneProject(s.project)
      p.assets = [...p.assets, asset]
      if (texts?.length) p.texts = [...(p.texts ?? []), ...texts]
      p.voiceRuns = [...(p.voiceRuns ?? []), run]
      let track = trackId ? p.tracks.find((t) => t.id === trackId && !t.locked) : undefined
      if (!track || track.kind !== 'audio') track = p.tracks.find((t) => t.kind === 'audio' && !t.locked)
      if (!track) {
        // insertClipsFromAssets would silently drop the clip here; a voice-over
        // that produced no sound on the timeline is a failure, not a no-op
        track = makeTrack(p, 'audio')
        p.tracks.push(track)
      }
      const clip: Clip = {
        id: uid(),
        assetId: asset.id,
        kind: 'media',
        start: Math.max(0, at),
        duration: asset.duration,
        inPoint: 0,
        label: asset.name,
        ...newClipDefaults()
      }
      track.clips.push(clip)
      result = { clipId: clip.id, trackId: track.id }
      return { project: p, selection: [clip.id] }
    })
    return result
  },

  addTexts: (docs) => {
    get().pushHistory('hText')
    set((s) => ({
      project: { ...s.project, texts: [...(s.project.texts ?? []), ...docs] }
    }))
  },

  removeText: (id) => {
    get().pushHistory('hText')
    set((s) => ({
      project: { ...s.project, texts: (s.project.texts ?? []).filter((t) => t.id !== id) }
    }))
  },

  insertFragmentClip: (fragmentId, meta, at, rawDuration) => {
    const clipId = uid()
    get().pushHistory('hInsert')
    set((s) => {
      const p = cloneProject(s.project)
      const start = Math.max(0, toFrame(at, p.fps))
      const end = frameEnd(p.fps, start, start + rawDuration)
      const duration = end - start
      // The topmost unlocked video track with the slot free — but never one
      // UNDER a track that already shows something in that span: a caption put
      // on a free track below the footage is covered by it (and goes through
      // pixel capture for nothing). Nothing free above the first busy track →
      // a fresh track on top.
      let track: Track | undefined
      for (const t of p.tracks) {
        if (t.kind !== 'video') continue
        const busy = t.clips.some((c) => c.start < end && c.start + c.duration > start)
        if (busy) break
        if (!t.locked) { track = t; break }
      }
      if (!track) {
        track = makeTrack(p, 'video')
        p.tracks.unshift(track)
      }
      const clip: Clip = {
        id: clipId,
        kind: 'remotion',
        fragmentId,
        fragmentMeta: meta,
        start,
        duration,
        inPoint: 0,
        label: meta.name,
        ...newClipDefaults()
      }
      track.clips.push(clip)
      return { project: p, selection: [clipId] }
    })
    return clipId
  },

  updateAsset: (assetId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const a = p.assets.find((x) => x.id === assetId)
      if (!a) return s
      Object.assign(a, patch)
      return { project: p }
    }),

  addTrack: (kind) => {
    get().pushHistory('hTrack')
    set((s) => {
      const p = cloneProject(s.project)
      p.tracks.splice(kind === 'video' ? 0 : p.tracks.length, 0, makeTrack(p, kind))
      return { project: p }
    })
  },

  addMarker: (time, opts) => {
    get().pushHistory('hMarker')
    const id = uid()
    set((s) => {
      const p = cloneProject(s.project)
      p.markers ??= []
      const n = p.markers.reduce((m, x) => Math.max(m, parseInt(x.label, 10) || 0), 0) + 1
      const m: TimelineMarker = { id, time: Math.max(0, toFrame(time, p.fps)), label: opts?.label?.trim() || String(n) }
      if (opts?.kind) m.kind = opts.kind
      if (opts?.end !== undefined) m.end = Math.max(m.time, toFrame(opts.end, p.fps))
      p.markers.push(m)
      return { project: p }
    })
    return id
  },

  moveMarker: (id, time) =>
    set((s) => {
      const m0 = s.project.markers?.find((x) => x.id === id)
      if (!m0) return {}
      const p = cloneProject(s.project)
      p.markers!.find((x) => x.id === id)!.time = Math.max(0, toFrame(time, p.fps))
      return { project: p }
    }),

  removeMarker: (id) => {
    get().pushHistory('hMarkerDelete')
    set((s) => {
      const p = cloneProject(s.project)
      p.markers = (p.markers ?? []).filter((x) => x.id !== id)
      return { project: p }
    })
  },

  renameMarker: (id, label) => {
    const next = label.trim()
    const m0 = get().project.markers?.find((x) => x.id === id)
    if (!m0 || !next || m0.label === next) return
    get().pushHistory('hMarkerRename')
    set((s) => {
      const p = cloneProject(s.project)
      p.markers!.find((x) => x.id === id)!.label = next
      return { project: p }
    })
  },

  setBeatMarkers: (beats, range, extra) => {
    const ok = beats.filter((b) => Number.isFinite(b?.time) && b.time >= 0)
    get().pushHistory('hBeats')
    const lo = Math.min(range.start, range.end) - 1e-6
    const hi = Math.max(range.start, range.end) + 1e-6
    const num = (x: unknown) => (Number.isFinite(x) ? Number(x) : undefined)
    set((s) => {
      const p = cloneProject(s.project)
      const kept = (p.markers ?? []).filter((m) => !isMusicMarker(m) || m.time < lo || m.time > hi)
      const added: TimelineMarker[] = ok.map((b) => ({
        id: uid(),
        time: b.time,
        label: '',
        kind: 'beat' as const,
        strength: Math.min(1, Math.max(0, Number(b.strength) || 0)),
        strong: !!b.strong,
        ...(num(b.bar) !== undefined ? { bar: num(b.bar) } : {}),
        ...(num(b.beatInBar) !== undefined ? { beatInBar: num(b.beatInBar) } : {})
      }))
      for (const sec of extra?.sections ?? []) {
        if (!(sec.end > sec.start)) continue
        added.push({
          id: uid(), time: Math.max(0, sec.start), end: sec.end, label: '', kind: 'section',
          section: sec.label, energy: Math.min(1, Math.max(0, Number(sec.energy) || 0)),
          ...(num(sec.startBar) !== undefined ? { bar: num(sec.startBar) } : {})
        })
      }
      for (const pz of extra?.pauses ?? []) {
        if (!(pz.end > pz.start)) continue
        added.push({ id: uid(), time: Math.max(0, pz.start), end: pz.end, label: '', kind: 'pause' })
      }
      p.markers = [...kept, ...added].sort((a, b) => a.time - b.time)
      return { project: p }
    })
    return ok.length
  },

  clearBeatMarkers: (range) => {
    const inRange = (t: number) => !range ||
      (t >= Math.min(range.start, range.end) - 1e-6 && t <= Math.max(range.start, range.end) + 1e-6)
    const doomed = (get().project.markers ?? []).filter((m) => isMusicMarker(m) && inRange(m.time)).length
    if (!doomed) return 0
    get().pushHistory('hBeatsClear')
    set((s) => {
      const p = cloneProject(s.project)
      p.markers = (p.markers ?? []).filter((m) => !isMusicMarker(m) || !inRange(m.time))
      return { project: p }
    })
    return doomed
  },

  setSceneMarkers: (times, range) => {
    const p0 = get().project
    const inRange = (t: number) => t >= range.start - 1e-6 && t <= range.end + 1e-6
    const next = [...new Set(times.map((t) => toFrame(t, p0.fps)))].filter((t) => t >= 0 && inRange(t)).sort((a, b) => a - b)
    const old = (p0.markers ?? []).filter((m) => m.kind === 'scene' && inRange(m.time)).map((m) => m.time)
    if (JSON.stringify(old) === JSON.stringify(next)) return
    get().pushHistory('hScenes')
    set((s) => {
      const p = cloneProject(s.project)
      const kept = (p.markers ?? []).filter((m) => m.kind !== 'scene' || !inRange(m.time))
      const added = next.map((time): TimelineMarker => ({ id: uid(), time, label: '', kind: 'scene' }))
      p.markers = [...kept, ...added].sort((a, b) => a.time - b.time)
      return { project: p }
    })
  },

  placeAudio: (asset, at, opts) => {
    get().pushHistory(opts?.history ?? 'hInsert')
    let result = { clipId: '', trackId: '', assetId: '' }
    set((s) => {
      const p = cloneProject(s.project)
      let a = p.assets.find((x) => x.path === asset.path)
      if (!a) {
        a = { ...asset, id: uid() } as MediaAsset
        p.assets = [...p.assets, a]
      }
      const start = Math.max(0, at)
      const end = start + Math.max(0.01, a.duration)
      let track = p.tracks.find((t) => t.kind === 'audio' && !t.locked &&
        !t.clips.some((c) => c.start < end - 1e-6 && c.start + c.duration > start + 1e-6))
      if (!track) {
        track = makeTrack(p, 'audio')
        p.tracks.push(track)
      }
      const defaults = newClipDefaults()
      const gain = opts?.gain
      const clip: Clip = {
        id: uid(),
        assetId: a.id,
        kind: 'media',
        start,
        duration: a.duration,
        inPoint: 0,
        label: opts?.label ?? a.name,
        ...defaults,
        gain: Number.isFinite(gain) ? { value: Math.min(2, Math.max(0, gain as number)) } : defaults.gain
      }
      track.clips.push(clip)
      result = { clipId: clip.id, trackId: track.id, assetId: a.id }
      return { project: p, selection: [clip.id] }
    })
    return result
  },

  addTrackNear: (refTrackId) => {
    const s = get()
    const idx = s.project.tracks.findIndex((t) => t.id === refTrackId)
    if (idx < 0) return
    const kind = s.project.tracks[idx].kind
    s.pushHistory('hTrack')
    set((st) => {
      const p = cloneProject(st.project)
      // video stacks above the clicked track, audio below it
      p.tracks.splice(kind === 'video' ? idx : idx + 1, 0, makeTrack(p, kind))
      return { project: p }
    })
  },

  removeTrack: (trackId) => {
    const s = get()
    if (!s.project.tracks.some((t) => t.id === trackId)) return
    s.pushHistory('hTrack')
    set((st) => {
      const p = cloneProject(st.project)
      p.tracks = p.tracks.filter((t) => t.id !== trackId)
      return { project: p, selection: [] }
    })
  },

  moveTrack: (trackId, toIndex) =>
    set((s) => {
      const p = cloneProject(s.project)
      const from = p.tracks.findIndex((t) => t.id === trackId)
      if (from < 0 || toIndex < 0 || toIndex >= p.tracks.length || from === toIndex) return s
      const [tr] = p.tracks.splice(from, 1)
      p.tracks.splice(toIndex, 0, tr)
      return { project: p }
    }),

  updateTrack: (trackId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const t = p.tracks.find((t) => t.id === trackId)
      if (t) Object.assign(t, patch)
      return { project: p }
    }),

  insertClipFromAsset: (assetId, trackId, at, ripple) =>
    get().insertClipsFromAssets([assetId], trackId, at, ripple),

  insertClipsFromAssets: (assetIds, trackId, at, ripple) => {
    const s = get()
    const found = assetIds
      .map((id) => s.project.assets.find((a) => a.id === id))
      .filter((a): a is MediaAsset => !!a)
    if (!found.length) return
    s.pushHistory('hInsert')
    set((st) => {
      const p = cloneProject(st.project)
      let cursor = Math.max(0, toFrame(at, p.fps))
      const ids: string[] = []
      for (const asset of found) {
        const wantKind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video'
        let track = trackId ? p.tracks.find((t) => t.id === trackId) : undefined
        if (!track || track.kind !== wantKind || track.locked) {
          track = p.tracks.find((t) => t.kind === wantKind && !t.locked)
        }
        if (!track) continue
        const raw = asset.kind === 'image' ? setting<number>('editing.stillDuration') : asset.duration
        // the last whole frame of the source, never past it
        const duration = frameEnd(p.fps, cursor, cursor + raw, Math.floor) - cursor
        const clip: Clip = {
          id: uid(),
          assetId: asset.id,
          kind: 'media',
          start: cursor,
          duration,
          inPoint: 0,
          label: asset.name,
          ...newClipDefaults(),
          ...(wantKind === 'audio' ? audioFade() : {})
        }
        track.clips.push(clip)
        ids.push(clip.id)
        // a video with sound also gets a linked audio clip on an audio track
        if (asset.kind === 'video' && asset.hasAudio) {
          const audioTrack = p.tracks.find((t) => t.kind === 'audio' && !t.locked)
          if (audioTrack) {
            const linkId = uid()
            clip.linkId = linkId
            clip.muted = true // sound comes from the audio-track twin
            const audioClip: Clip = {
              ...clone(clip),
              ...audioFade(),
              id: uid(),
              muted: false,
              linkId
            }
            audioTrack.clips.push(audioClip)
            ids.push(audioClip.id)
          }
        }
        cursor += duration // next dropped file starts where this one ends
      }
      if (!ids.length) return st
      if (ripple) {
        const t0 = Math.max(0, toFrame(at, p.fps))
        const mine = new Set(ids)
        openGap(p, t0, cursor - t0, p.tracks.filter((t) => t.clips.some((c) => mine.has(c.id))).map((t) => t.id), mine)
      }
      return { project: p, selection: ids }
    })
  },

  setClipSpeed: (clipId, speed, duration, start) =>
    get().setClipSpeeds([{ id: clipId, speed, duration, start }]),

  setClipSpeeds: (entries) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const { id, speed, duration, start } of entries) {
        // linked partners change tempo together
        for (const f of withLinked(p, [id])
          .map((cid) => findClip(p, cid))
          .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)) {
          const c = f.clip
          const oldSpeed = c.speed || 1
          rescaleClipAnims(c, oldSpeed / speed)
          c.speed = speed
          // the speed stays exact; the end is quantised from the raw end
          const s0 = start !== undefined ? Math.max(0, start) : c.start
          if (start !== undefined) c.start = Math.max(0, toFrame(s0, p.fps))
          c.duration = frameEnd(p.fps, c.start, s0 + duration) - c.start
        }
      }
      return { project: p }
    }),

  setClipDuration: (clipId, duration) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const f of withLinked(p, [clipId])
        .map((id) => findClip(p, id))
        .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)) {
        f.clip.duration = frameEnd(p.fps, f.clip.start, f.clip.start + Math.max(0.05, duration)) - f.clip.start
      }
      return { project: p }
    }),

  setTransition: (clipId, type) => {
    get().pushHistory('hTransition')
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      // duration is implicit: the transition spans the clip overlap
      if (f) f.clip.transitionIn = type ? { type, duration: 0 } : undefined
      return { project: p }
    })
  },

  setEdgeTransitions: (entries) => {
    get().pushHistory('hTransition')
    set((s) => {
      const p = cloneProject(s.project)
      for (const e of entries) {
        const f = findClip(p, e.clipId)
        if (!f || f.track.locked) continue
        const key = e.edge === 'in' ? 'transitionIn' : 'transitionOut'
        const prev = f.clip[key]
        // a previous overlap-style transition (duration 0) is not a tip length
        const keep = prev && prev.duration > 0.001 ? prev.duration : setting<number>('editing.edgeDuration')
        f.clip[key] = e.type
          ? { type: e.type, duration: Math.max(0.05, e.duration ?? keep) }
          : undefined
      }
      return { project: p }
    })
  },

  toggleLinkSelection: () => {
    const s = get()
    const sel = s.selection
    if (!sel.length) return
    const clips = sel
      .map((id) => findClip(s.project, id))
      .filter((x): x is NonNullable<typeof x> => !!x)
    const anyLinked = clips.some((f) => f.clip.linkId)
    s.pushHistory('hLink')
    set((st) => {
      const p = cloneProject(st.project)
      if (anyLinked) {
        const links = new Set(clips.map((f) => f.clip.linkId).filter(Boolean) as string[])
        for (const t of p.tracks) {
          for (const c of t.clips) if (c.linkId && links.has(c.linkId)) c.linkId = undefined
        }
      } else if (clips.length === 2 && clips[0].track.kind !== clips[1].track.kind) {
        const linkId = uid()
        for (const f of clips) {
          const fc = findClip(p, f.clip.id)
          if (fc) fc.clip.linkId = linkId
        }
      }
      return { project: p }
    })
  },

  insertTextClip: (at) => {
    const s = get()
    s.pushHistory('hInsert')
    set((st) => {
      const p = cloneProject(st.project)
      const track = p.tracks.find((t) => t.kind === 'video' && !t.locked)
      if (!track) return st
      const start = Math.max(0, toFrame(at, p.fps))
      const clip: Clip = {
        id: uid(),
        kind: 'text',
        text: tr('text'),
        textStyle: defaultTextStyle(),
        start,
        duration: frameEnd(p.fps, start, start + setting<number>('editing.textDuration')) - start,
        inPoint: 0,
        label: 'Text',
        ...newClipDefaults()
      }
      track.clips.push(clip)
      return { project: p, selection: [clip.id] }
    })
  },

  updateProjectSettings: (patch, session) => {
    const s = get()
    const keys = Object.keys(patch) as (keyof ProjectSettingsPatch)[]
    if (keys.every((k) => s.project[k] === patch[k])) return
    const top = s.past[s.past.length - 1]
    if (session === undefined || session !== settingsMark.session || top !== settingsMark.entry) {
      s.pushHistory('projectSettings')
      settingsMark.session = session
      settingsMark.entry = get().past[get().past.length - 1]
    }
    set((st) => ({ project: { ...st.project, ...patch } }))
  },

  updateClip: (clipId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      if (f) Object.assign(f.clip, patch)
      return { project: p }
    }),

  setClipProps: (ids, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const id of ids) {
        const f = findClip(p, id)
        if (f) Object.assign(f.clip, patch)
      }
      return { project: p }
    }),

  toggleDisabled: () => {
    const s = get()
    const own = s.project.tracks.filter((t) => !t.locked).flatMap((t) => t.clips)
      .filter((c) => s.selection.includes(c.id))
    if (!own.length) return
    const off = own.some((c) => !c.disabled)
    s.pushHistory('hEdit')
    s.setClipProps(own.map((c) => c.id), { disabled: off || undefined })
  },

  setClipStarts: (entries) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const e of entries) {
        const f = findClip(p, e.id)
        if (!f || f.track.locked) continue
        f.clip.start = Math.max(0, toFrame(e.start, p.fps))
        if (e.trackId && e.trackId !== f.track.id) {
          const dst = p.tracks.find((t) => t.id === e.trackId)
          if (dst && dst.kind === f.track.kind && !dst.locked) {
            f.track.clips = f.track.clips.filter((c) => c.id !== e.id)
            dst.clips.push(f.clip)
          }
        }
      }
      return { project: p }
    }),

  moveClip: (clipId, trackId, start) =>
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      const dst = p.tracks.find((t) => t.id === trackId)
      if (!f || !dst || dst.locked) return s
      if (dst.kind !== f.track.kind) return s
      f.track.clips = f.track.clips.filter((c) => c.id !== clipId)
      f.clip.start = Math.max(0, toFrame(start, p.fps))
      dst.clips.push(f.clip)
      return { project: p }
    }),

  trimClip: (clipId, edge, time) =>
    set((s) => {
      const p = cloneProject(s.project)
      return trimInPlace(p, clipId, edge, time) ? { project: p } : s
    }),

  rippleTrim: (clipId, edge, time) =>
    set((s) => {
      const p = cloneProject(s.project)
      const c0 = findClip(p, clipId)?.clip
      if (!c0) return s
      const start = c0.start
      const end = c0.start + c0.duration
      const targets = trimInPlace(p, clipId, edge, time)
      if (!targets) return s
      let dt = c0.start + c0.duration - end
      if (edge === 'in') {
        // the head came off the source; the clip keeps its place, the tail closes up
        dt = start - c0.start
        for (const f of targets) f.clip.start += dt
      }
      shiftAfter(p, end, dt, rippleTracks(p, targets.map((f) => f.track.id), end),
        new Set(targets.map((f) => f.clip.id)))
      return { project: p }
    }),

  rollEdit: (leftId, rightId, t) =>
    set((s) => {
      const p = cloneProject(s.project)
      const L = findClip(p, leftId)?.clip
      if (!L) return s
      const d = settle(p, toFrame(t, p.fps) - (L.start + L.duration), (q, d) => rollIn(q, leftId, rightId, d))
      if (!d) return s
      rollIn(p, leftId, rightId, d)
      return { project: p }
    }),

  slip: (clipId, dt) =>
    set((s) => {
      const p = cloneProject(s.project)
      const d = toFrame(dt, p.fps)
      let changed = false
      for (const id of withLinked(p, [clipId])) {
        const f = findClip(p, id)
        const asset = f?.clip.assetId ? p.assets.find((a) => a.id === f.clip.assetId) : undefined
        if (!f || f.track.locked || !asset || asset.kind === 'image') continue
        const c = f.clip
        const speed = c.speed || 1
        // a clip already longer than its source (looping) keeps what it has
        const hi = Math.max(asset.duration - c.duration * speed, c.inPoint)
        const ni = Math.min(hi, Math.max(0, c.inPoint + d * speed))
        if (ni !== c.inPoint) changed = true
        c.inPoint = ni
      }
      return changed ? { project: p } : s
    }),

  slide: (clipId, dt) =>
    set((s) => {
      const p = cloneProject(s.project)
      const d = settle(p, toFrame(dt, p.fps), (q, d) => slideIn(q, clipId, d))
      if (!d) return s
      slideIn(p, clipId, d)
      return { project: p }
    }),

  trimToPlayhead: (edge) => {
    const s = get()
    const t = toFrame(s.playhead, s.project.fps)
    const under = s.project.tracks.flatMap((tr) =>
      tr.locked ? [] : tr.clips.filter((c) => c.start < t - 1e-6 && c.start + c.duration > t + 1e-6))
    const c = under.find((x) => s.selection.includes(x.id)) ?? under[0]
    if (!c) return
    s.pushHistory('hRippleTrim')
    s.rippleTrim(c.id, edge, t)
    if (edge === 'in') s.setPlayhead(c.start)
  },

  splitAtPlayhead: () => {
    const s = get()
    const t = toFrame(s.playhead, s.project.fps) // the cut lands on a frame, wherever the playhead sits
    // «Разрез захватывает»: the selection (every track without one), or every unlocked track
    const selIds = s.selection.length && setting('editing.splitScope') === 'selection' ? withLinked(s.project, s.selection) : []
    const ids = splitTargets(s.project, t, (c) => selIds.length === 0 || selIds.includes(c.id))
    if (ids.length) set({ selection: splitClips(get, set, t, ids) })
  },

  splitAt: (time, trackIds) => {
    const s = get()
    const t = toFrame(time, s.project.fps)
    const on = new Set(trackIds ?? s.project.tracks.map((tr) => tr.id))
    const own = splitTargets(s.project, t, () => true, on)
    // a twin on another track goes too, or the pair's halves stop matching
    const ids = splitTargets(s.project, t, (c) => withLinked(s.project, own).includes(c.id))
    return ids.length ? splitClips(get, set, t, ids) : []
  },

  deleteSelection: () => {
    const s = get()
    if (!s.selection.length) return
    s.pushHistory('hDelete')
    set((st) => {
      const p = cloneProject(st.project)
      for (const tr of p.tracks) {
        if (tr.locked) continue
        tr.clips = tr.clips.filter((c) => !st.selection.includes(c.id))
      }
      return { project: p, selection: [] }
    })
  },

  closeGapAt: (trackId, time) => {
    const s = get()
    const track = s.project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked) return
    let prevEnd = 0
    let nextStart = Infinity
    for (const c of track.clips) {
      const end = c.start + c.duration
      if (end <= time && end > prevEnd) prevEnd = end
      if (c.start >= time && c.start < nextStart) nextStart = c.start
    }
    if (!isFinite(nextStart) || nextStart - prevEnd < 1e-6) return
    s.pushHistory('hCloseGap')
    set((st) => {
      const p = cloneProject(st.project)
      shiftAfter(p, nextStart, prevEnd - nextStart, [trackId])
      return { project: p }
    })
  },

  closeGaps: (which) => {
    const s = get()
    const tracks = s.project.tracks.filter((t) => !t.locked && (which === 'all' || which.includes(t.id)))
    if (!tracks.some((t) => gapsOf(t.clips).length)) return
    s.pushHistory('hCloseGaps')
    set((st) => {
      const p = cloneProject(st.project)
      for (const t of tracks) {
        for (const [a, b] of gapsOf(t.clips).reverse()) shiftAfter(p, b, a - b, [t.id])
      }
      return { project: p }
    })
  },

  rippleDelete: (ids) => {
    const s = get()
    const want = new Set(withLinked(s.project, ids ?? s.selection))
    if (!s.project.tracks.some((t) => !t.locked && t.clips.some((c) => want.has(c.id)))) return
    s.pushHistory('hRippleDelete')
    set((st) => {
      const p = cloneProject(st.project)
      // every freed span in ORIGINAL positions, rippling its track plus the twins'
      // tracks of what follows (or a pair desyncs); spans that overlap on shared
      // tracks (the two halves of a deleted pair) merge, so nothing moves twice
      const ev: Array<{ a: number; b: number; ids: Set<string> }> = []
      for (const tr of p.tracks) {
        if (tr.locked) continue
        const gone = tr.clips.filter((c) => want.has(c.id))
        if (!gone.length) continue
        tr.clips = tr.clips.filter((c) => !want.has(c.id))
        for (const [a, b] of freedSpans(gone, tr.clips)) ev.push({ a, b, ids: new Set([tr.id]) })
      }
      for (const e of ev) e.ids = new Set(rippleTracks(p, e.ids, e.b))
      ev.sort((x, y) => x.a - y.a)
      const merged: typeof ev = []
      for (const e of ev) {
        const m = merged.find((m) => e.a < m.b - 1e-6 && e.b > m.a + 1e-6 && [...e.ids].some((id) => m.ids.has(id)))
        if (m) { m.a = Math.min(m.a, e.a); m.b = Math.max(m.b, e.b); e.ids.forEach((id) => m.ids.add(id)) }
        else merged.push(e)
      }
      for (const e of merged.sort((x, y) => y.b - x.b)) shiftAfter(p, e.b, e.a - e.b, e.ids)
      return { project: p, selection: st.selection.filter((id) => !want.has(id)) }
    })
  },

  copySelection: () => {
    const s = get()
    if (!s.selection.length) return
    const items: ClipboardItem[] = []
    for (const track of s.project.tracks) {
      for (const c of track.clips) {
        if (s.selection.includes(c.id)) {
          items.push({ kind: track.kind, trackId: track.id, clip: clone(c) })
        }
      }
    }
    set({ clipboard: items })
  },

  copyRange: () => {
    const s = get()
    if (!s.range) return
    const items: ClipboardItem[] = []
    for (const track of s.project.tracks) {
      for (const c of track.clips) {
        const piece = clipIntersection(c, s.range.start, s.range.end)
        if (piece) items.push({ kind: track.kind, trackId: track.id, clip: piece })
      }
    }
    if (items.length) set({ clipboard: items })
  },

  deleteRange: () => {
    const s = get()
    const r = s.range
    if (!r) return
    s.pushHistory('hDeleteRange')
    set((st) => {
      const p = cloneProject(st.project)
      liftRange(p, r)
      return { project: p, selection: [] }
    })
  },

  extractRange: (range) => {
    const r = range ?? get().range
    if (r) get().extractRanges([r])
  },

  extractRanges: (ranges) => {
    // overlapping or touching ranges merge (cutting a shared stretch twice would
    // eat what follows it); then latest first: extracting one never moves the ranges still to come
    const rs: { start: number; end: number }[] = []
    for (const r of ranges.filter((r) => r.end - r.start >= 1e-6).sort((a, b) => a.start - b.start)) {
      const last = rs[rs.length - 1]
      if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end)
      else rs.push({ start: r.start, end: r.end })
    }
    rs.reverse()
    if (!rs.length) return
    get().pushHistory('hExtract')
    set((st) => {
      const p = cloneProject(st.project)
      for (const r of rs) {
        liftRange(p, r)
        const len = r.end - r.start
        shiftAfter(p, r.end, -len, p.tracks.filter((t) => !t.locked).map((t) => t.id))
        // a ripple over every track moves the markers too; inside the range they land on its start
        if (p.markers) {
          p.markers = p.markers.map((m) => m.time > r.start ? { ...m, time: Math.max(r.start, m.time - len) } : m)
        }
      }
      return { project: p, selection: [], range: null }
    })
  },

  pasteAtPlayhead: (ripple) => {
    const s = get()
    if (!s.clipboard.length) return
    s.pushHistory('hPaste')
    set((st) => {
      const p = cloneProject(st.project)
      const base = Math.min(...st.clipboard.map((i) => i.clip.start))
      const ids: string[] = []
      const linkMap = new Map<string, string>() // fresh linkIds for pasted pairs
      for (const item of st.clipboard) {
        const track =
          p.tracks.find((t) => t.id === item.trackId && !t.locked) ??
          p.tracks.find((t) => t.kind === item.kind && !t.locked)
        if (!track) continue
        let linkId: string | undefined
        if (item.clip.linkId) {
          if (!linkMap.has(item.clip.linkId)) linkMap.set(item.clip.linkId, uid())
          linkId = linkMap.get(item.clip.linkId)
        }
        const start = Math.max(0, toFrame(st.playhead + (item.clip.start - base), p.fps))
        const clip: Clip = {
          ...clone(item.clip),
          id: uid(),
          start,
          duration: frameEnd(p.fps, start, start + item.clip.duration) - start,
          linkId
        }
        track.clips.push(clip)
        ids.push(clip.id)
      }
      if (ripple && ids.length) {
        const mine = new Set(ids)
        const placed = p.tracks.flatMap((t) => t.clips.filter((c) => mine.has(c.id)))
        const t0 = Math.min(...placed.map((c) => c.start))
        openGap(p, t0, Math.max(...placed.map((c) => c.start + c.duration)) - t0,
          p.tracks.filter((t) => t.clips.some((c) => mine.has(c.id))).map((t) => t.id), mine)
      }
      return { project: p, selection: ids }
    })
  },

  duplicateInPlace: (ids) => {
    const out: string[] = []
    set((st) => {
      const p = cloneProject(st.project)
      out.push(...copyClips(p, ids, 0))
      return { project: p }
    })
    return out
  },

  duplicateSelection: () => {
    const s = get()
    const own = s.project.tracks.filter((t) => !t.locked).flatMap((t) => t.clips)
      .filter((c) => s.selection.includes(c.id))
    if (!own.length) return
    const a = Math.min(...own.map((c) => c.start))
    const b = Math.max(...own.map((c) => c.start + c.duration))
    s.pushHistory('hDuplicate')
    set((st) => {
      const p = cloneProject(st.project)
      return { project: p, selection: copyClips(p, own.map((c) => c.id), b - a) }
    })
  },

  pasteAttributes: (parts) => {
    const s = get()
    const src = (s.clipboard.find((i) => i.kind === 'video') ?? s.clipboard[0])?.clip
    const own = s.project.tracks.filter((t) => !t.locked).flatMap((t) => t.clips)
      .filter((c) => s.selection.includes(c.id))
    if (!src || !own.length || !parts.length) return
    const has = (k: AttrPart) => parts.includes(k)
    s.pushHistory('hPasteAttrs')
    set((st) => {
      const p = cloneProject(st.project)
      if (has('speed')) {
        // first, so the keyframes it rescales are the target's own; twins follow
        const sp = src.speed || 1
        for (const id of withLinked(p, own.map((c) => c.id))) {
          const f = findClip(p, id)
          if (!f || f.track.locked || f.clip.kind !== 'media') continue
          const c = f.clip
          const old = c.speed || 1
          rescaleClipAnims(c, old / sp)
          c.speed = sp
          c.duration = frameEnd(p.fps, c.start, c.start + (c.duration * old) / sp) - c.start
        }
      }
      for (const { id } of own) {
        const c = findClip(p, id)!.clip
        if (has('transform')) c.transform = clone(src.transform)
        if (has('effects')) c.effects = clone(src.effects ?? [])
        if (has('volume')) c.gain = clone(src.gain)
        if (has('masks')) {
          for (const k of ['mask', 'maskShape', 'maskShapes'] as const) {
            if (src[k] === undefined) delete c[k]
            else (c as unknown as Record<string, unknown>)[k] = clone(src[k])
          }
        }
      }
      return { project: p }
    })
  },

  freezeFrame: (len = 2) => {
    const s = get()
    const p0 = s.project
    const t = toFrame(s.playhead, p0.fps)
    const under = p0.tracks.flatMap((tr) => tr.locked || tr.kind !== 'video' ? [] : tr.clips.filter((c) =>
      c.kind === 'media' && !c.disabled && c.start <= t + 1e-6 && c.start + c.duration > t + 1e-6 &&
      p0.assets.find((a) => a.id === c.assetId)?.kind === 'video'))
    const c0 = under.find((c) => s.selection.includes(c.id)) ?? under[0]
    if (!c0) return
    s.pushHistory('hFreeze')
    set((st) => {
      const p = cloneProject(st.project)
      const f = findClip(p, c0.id)!
      const rel = t - f.clip.start
      const at = clipSourceTime(f.clip, p.assets.find((a) => a.id === f.clip.assetId), rel)
      const still: Clip = { ...clone(f.clip), id: uid(), start: t, inPoint: at, speed: 1, freezeAt: at, fadeIn: 0, fadeOut: 0 }
      for (const k of ['linkId', 'transitionIn', 'transitionOut', 'audioBake'] as const) delete still[k]
      // the look of that moment, held: every animated value taken at the frame
      forEachAnim(still, (a) => ({ value: evalAnim(a, rel) }))
      still.duration = frameEnd(p.fps, t, t + len) - t
      openGap(p, t, still.duration, [f.track.id], new Set())
      f.track.clips.push(still)
      return { project: p, selection: [still.id] }
    })
  },

  cut: () => {
    const s = get()
    if (s.selection.length) { s.copySelection(); s.deleteSelection() }
    else if (s.range) { s.copyRange(); s.deleteRange() }
  },
  markIn: () => {
    const { playhead: t, range, project } = get()
    get().setRange({ start: t, end: range && range.end > t ? range.end : projectDuration(project) })
  },
  markOut: () => {
    const { playhead: t, range } = get()
    get().setRange({ start: range && range.start < t ? range.start : 0, end: t })
  },
  markClip: () => {
    const s = get()
    const t = s.playhead
    const under = s.project.tracks.flatMap((tr) =>
      tr.locked ? [] : tr.clips.filter((c) => c.start <= t + 1e-6 && c.start + c.duration > t + 1e-6))
    const c = under.find((x) => s.selection.includes(x.id)) ?? under[0]
    if (c) s.setRange({ start: c.start, end: c.start + c.duration })
  },
  goToEdit: (dir) => {
    const s = get()
    const t = nextEdit(s.project.tracks, s.playhead, dir)
    if (t !== null) s.setPlayhead(t)
  },
  selectAll: () => set((s) => ({ selection: s.project.tracks.flatMap((tr) => tr.locked ? [] : tr.clips.map((c) => c.id)) })),

  select: (selection) => set({ selection }),
  toggleSelect: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id]
    })),
  setAnimClip: (animClipId) =>
    set((s) => ({ animClipId, motionTrackId: animClipId ? null : s.motionTrackId })),
  setMotionTrack: (motionTrackId) =>
    set((s) => ({ motionTrackId, animClipId: motionTrackId ? null : s.animClipId })),
  setKfMarker: (kfMarker) => set({ kfMarker }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set(playing ? { playing } : { playing, playRate: 1, playEnd: null }),
  shuttle: (dir) => {
    const { playing, playRate } = get()
    set({ playing: true, playEnd: null, playRate: playing && Math.sign(playRate) === dir ? dir * Math.min(8, Math.abs(playRate) * 2) : dir })
  },
  toggleLoop: () => set((s) => ({ loop: !s.loop })),
  playInOut: () => {
    const { range, project } = get()
    const [a, b] = range ? [range.start, range.end] : [0, projectDuration(project)]
    set({ playhead: a, playing: true, playRate: 1, playEnd: b })
  },
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  setPreviewGpuLost: (previewGpuLost) => set({ previewGpuLost }),
  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setRange: (range) => {
    const fps = get().project.fps
    const r = range && { start: toFrame(range.start, fps), end: toFrame(range.end, fps) }
    set({ range: r && r.end - r.start > 0.01 ? r : null })
  }
}))

function makeTrack(p: Project, kind: TrackKind): Track {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1
  return {
    id: uid(),
    kind,
    name: (kind === 'video' ? 'V' : 'A') + n,
    muted: false,
    locked: false,
    gain: 1,
    clips: []
  }
}

/** The part of a clip inside [from..to], or null if they don't overlap. */
function clipIntersection(c: Clip, from: number, to: number): Clip | null {
  const end = c.start + c.duration
  const a = Math.max(c.start, from)
  const b = Math.min(end, to)
  if (b - a < 0.01) return null
  const speed = c.speed || 1
  const piece: Clip = JSON.parse(JSON.stringify(c))
  piece.start = a
  piece.duration = b - a
  piece.inPoint = c.inPoint + (a - c.start) * speed
  if (a > c.start) {
    piece.fadeIn = 0
    shiftClipAnims(piece, -(a - c.start))
  }
  if (b < end) piece.fadeOut = 0
  return piece
}
