// Auto-ducking (card I7): music under a voice dips while someone speaks and
// comes back in the gaps. Speech spans come from the loudness envelope of the
// voice (every track but the music's by default, or the tracks/clips named)
// — the same `audio:envelope` pass silence removal uses, with transcript
// words (I4) counted as speech — and become gain keyframes on the music
// clips, ONE undo step. The curve is MULTIPLIED into the gain the clip
// already had (a fade the user drew survives; ducking twice ducks twice),
// and the undo label says so. The export mixes the keys through
// shared/gainKeys.ts. Test: node scripts/check-duck.mjs
import type { Anim, Keyframe } from '@shared/types'
import { gainKeys } from '@shared/gainKeys'
import { useEditor, findClip, withLinked } from '@/state/store'
import { collectRangeAudio } from './subtitles'
import { placeWords } from './words'
import { silenceSpans } from './silences'
import { evalAnim } from './anim'
import { logError } from './log'
import { tr } from '@/i18n'

export interface DuckOpts {
  /** gain under speech, dB (default −12) */
  depthDb?: number
  /** ramp down before speech starts, s (default 0.3) */
  attack?: number
  /** ramp up after speech ends, s (default 0.5) */
  release?: number
}

const DEFAULTS = { depthDb: -12, attack: 0.3, release: 0.5 }
/** a recovery shorter than this between two ducks is pumping: stay down */
const MIN_UP = 0.5
const ENV_FPS = 100
/** the defaults under what was given (an absent MCP field arrives as undefined) */
const withDefaults = (o: DuckOpts) => ({
  depthDb: o.depthDb ?? DEFAULTS.depthDb, attack: o.attack ?? DEFAULTS.attack, release: o.release ?? DEFAULTS.release
})

export interface DuckPoint { t: number; v: number }

/** The ducking gain over speech spans (project s, any order) as straight-line
    points: 1 outside, the depth during speech, `attack` down before and
    `release` up after; spans whose recovery would be under MIN_UP merge. */
export function duckCurve(spans: [number, number][], opts: DuckOpts = {}): DuckPoint[] {
  const { depthDb, attack, release } = withDefaults(opts)
  const g = Math.pow(10, depthDb / 20)
  const merged: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1]
    if (last && a - attack - (last[1] + release) < MIN_UP) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged.flatMap(([a, b]) => [{ t: a - attack, v: 1 }, { t: a, v: g }, { t: b, v: g }, { t: b + release, v: 1 }])
}

const curveAt = (c: DuckPoint[], t: number) => {
  if (!c.length || t <= c[0].t) return 1
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1]
    if (t < b.t) return b.t - a.t < 1e-9 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
  }
  return c[c.length - 1].v
}

/** A clip's gain (clip at `start`, `duration` long) multiplied by the curve,
    or null when the curve never touches the clip. Eased stretches of the old
    gain are sampled the way the export samples them (gainKeys). */
export function duckGain(gain: Anim, start: number, duration: number, curve: DuckPoint[]): Anim | null {
  const inside = curve.filter((p) => p.t > start && p.t < start + duration).map((p) => p.t - start)
  if (curveAt(curve, start) === 1 && curveAt(curve, start + duration) === 1 && !inside.length) return null
  const old = gainKeys(gain, 0, duration, (t) => evalAnim(gain, t))?.map((k) => k.t) ?? []
  const times = [...new Set([0, duration, ...inside, ...old].map((t) => +t.toFixed(6)))].sort((a, b) => a - b)
  const keyframes: Keyframe[] = times.map((t) => ({ time: t, value: evalAnim(gain, t) * curveAt(curve, start + t), easing: 'linear' }))
  return { value: keyframes[0].value, keyframes }
}

export interface AutoDuckArgs extends DuckOpts {
  /** the music clips to duck (their linked twins too) */
  musicClipIds: string[]
  /** where the speech is: these tracks, or these clips; default every track the music is not on */
  speechTrackIds?: string[]
  speechClipIds?: string[]
  /** speech detection: dB below the voice's loudest point (default −35) */
  thresholdDb?: number
}

/** Duck the music under the speech: one undo step. Returns the speech spans
    (project s) and the clips that got keys. */
export async function autoDuck(a: AutoDuckArgs): Promise<{ speech: [number, number][]; clipIds: string[] }> {
  const p = useEditor.getState().project
  const opts = withDefaults(a)
  const ids = withLinked(p, a.musicClipIds).filter((id) => {
    const f = findClip(p, id)
    if (!f) throw new Error(`no clip ${id}`)
    return !f.track.locked
  })
  const clips = ids.map((id) => findClip(p, id)!.clip)
  if (!clips.length) throw new Error('the music is on locked tracks')
  const start = Math.max(0, Math.min(...clips.map((c) => c.start)) - opts.attack)
  const end = Math.max(...clips.map((c) => c.start + c.duration)) + opts.release
  const musicTracks = new Set(ids.map((id) => findClip(p, id)!.track.id))
  const speechClips = a.speechClipIds ? withLinked(p, a.speechClipIds) : undefined
  const speechTracks = a.speechTrackIds ?? p.tracks.filter((t) => !musicTracks.has(t.id)).map((t) => t.id)
  const segments = collectRangeAudio(p, start, end, speechClips ? { clipIds: speechClips } : { trackIds: speechTracks })
  if (!segments.length) throw new Error('no speech audio to duck under')
  const env = await window.kadr.audioEnvelope({ audioSegments: segments, duration: end - start, fps: ENV_FPS, attack: 0.005, release: 0.005 })
  const heard = speechClips ?? p.tracks.filter((t) => speechTracks.includes(t.id)).flatMap((t) => t.clips.map((c) => c.id))
  const words = placeWords(p).filter((w) => !w.clipId || heard.includes(w.clipId)).map((w): [number, number] => [w.t0 - start, w.t1 - start])
  // speech = what is not silence (pauses under minSilence count as speech)
  const quiet = silenceSpans(env, ENV_FPS, { pad: 0, ...(a.thresholdDb !== undefined ? { thresholdDb: a.thresholdDb } : {}) }, words)
  const speech: [number, number][] = []
  let from = 0
  for (const [q0, q1] of [...quiet, [env.length / ENV_FPS, env.length / ENV_FPS]]) {
    if (q0 - from > 1e-9) speech.push([+(start + from).toFixed(3), +(start + q0).toFixed(3)])
    from = q1
  }
  const curve = duckCurve(speech, opts)
  const patches = clips.map((c) => [c.id, duckGain(c.gain, c.start, c.duration, curve)] as const).filter(([, g]) => g)
  if (!patches.length) throw new Error('no speech under the music')
  const s = useEditor.getState()
  s.pushHistory('hDuck')
  for (const [id, gain] of patches) s.updateClip(id, { gain: gain! })
  return { speech, clipIds: patches.map(([id]) => id) }
}

/** audio-carrying media clips of the selection (the clip menu's clip when it is outside it) */
export function duckTargets(clipId?: string): string[] {
  const s = useEditor.getState()
  const ids = clipId && !s.selection.includes(clipId) ? [clipId] : s.selection
  return ids.filter((id) => {
    const c = findClip(s.project, id)?.clip
    return c?.kind === 'media' && !!s.project.assets.find((x) => x.id === c.assetId)?.hasAudio
  })
}

/** The clip menu and the palette. */
export async function duckHere(clipId?: string): Promise<void> {
  const ids = duckTargets(clipId)
  if (!ids.length) return
  try {
    await autoDuck({ musicClipIds: ids })
  } catch (e) {
    logError(tr('actDuck'), `${tr('duckFailed')}: ${(e as Error)?.message ?? e}`)
  }
}
