// Silence removal (card I5): find the quiet runs of a clip or a range, show
// them on the timeline as proposals (the defect-flag UI: click confirms, right
// click rejects, double click plays), and cut the chosen ones out of every
// unlocked track as ONE undo step (store.extractRanges).
//
// Driven by the loudness envelope main already computes over the export mix
// (audio:envelope, shared/envelope.ts) with a fast release, so the quiet run
// starts where the sound stops rather than 200 ms later. The threshold is
// relative to the loudest point of what was analysed, so a quiet recording
// finds its pauses as well as a loud one. Transcript words (card I4) stand in
// for a VAD: a quiet run that carries a word keeps that word's time.
// Music under speech hides the pauses from the mix — aim at the voice track
// (trackIds) or the clip (clipId) instead.
// The same store carries the agent's proposals (card I8, kadr_propose): any
// `kind` of range with a reason, shown and decided with the same flags, cut
// by the same applySilences — only when the USER confirmed them.
// Test: node scripts/check-silences.mjs, node scripts/check-proposals.mjs
import { create } from 'zustand'
import { useEditor, projectDuration, withLinked } from '@/state/store'
import { collectRangeAudio } from './subtitles'
import { placeWords } from './words'
import { toFrame } from './timelineMath'
import { logError } from './log'
import { tr } from '@/i18n'

export interface SilenceOpts {
  /** dB below the loudest point of the analysed audio (default −35) */
  thresholdDb?: number
  /** shortest pause worth a proposal, s (default 0.5) */
  minSilence?: number
  /** sound kept on each side of a cut, s (default 0.1) */
  pad?: number
}

export interface Silence {
  id: string
  /** 'silence' (found here), else the agent's kind ('retake', …) */
  kind: string
  /** the agent's words, shown on the flag */
  reason?: string
  /** project seconds, on frames */
  start: number
  end: number
  state: 'proposed' | 'confirmed' | 'rejected'
}

const DEFAULTS = { thresholdDb: -35, minSilence: 0.5, pad: 0.1 }
/** envelope resolution: 10 ms */
const ENV_FPS = 100

/**
 * Quiet runs of an envelope (one value per 1/fps s from 0) as [start, end] in
 * the same seconds: below `thresholdDb` of its peak for at least `minSilence`
 * once `speech` spans are taken out, then shrunk by `pad` on each side.
 */
export function silenceSpans(env: number[], fps: number, opts: SilenceOpts = {}, speech: [number, number][] = []): [number, number][] {
  const { thresholdDb, minSilence, pad } = { ...DEFAULTS, ...opts }
  let peak = 0
  for (const v of env) if (v > peak) peak = v
  const thr = peak * Math.pow(10, thresholdDb / 20)
  let runs: [number, number][] = []
  for (let k = 0; k < env.length;) {
    if (peak > 0 && env[k] >= thr) { k++; continue }
    const a = k
    while (k < env.length && (peak === 0 || env[k] < thr)) k++
    runs.push([a / fps, k / fps])
  }
  for (const [w0, w1] of speech) {
    runs = runs.flatMap(([a, b]): [number, number][] =>
      w1 <= a || w0 >= b ? [[a, b]] : [...(w0 > a ? [[a, w0] as [number, number]] : []), ...(w1 < b ? [[w1, b] as [number, number]] : [])])
  }
  return runs
    .filter(([a, b]) => b - a >= minSilence - 1e-9)
    .map(([a, b]): [number, number] => [a + pad, b - pad])
    .filter(([a, b]) => b > a)
}

/** the proposals on the timeline; `none` = the last search found nothing */
export const useSilences = create<{ items: Silence[]; busy: boolean; none: boolean }>(() => ({ items: [], busy: false, none: false }))

/** the confirmed proposals «Удалить подтверждённые» cuts — a 'short' (card I11) is exported, never cut */
export const cuttable = () => useSilences.getState().items.filter((x) => x.state === 'confirmed' && x.kind !== 'short')

export const clearSilences = () => useSilences.setState({ items: [], none: false })

export const confirmAllSilences = () =>
  useSilences.setState((u) => ({ items: u.items.map((x) => ({ ...x, state: 'confirmed' as const })) }))

/** The toolbar button and the palette: the one selected clip, else the range, else everything. */
export async function findSilencesHere(): Promise<void> {
  if (useSilences.getState().busy) return
  const sel = useEditor.getState().selection
  useSilences.setState({ busy: true, none: false })
  try {
    const found = await findSilences(sel.length === 1 ? { clipId: sel[0] } : {})
    useSilences.setState({ none: !found.length })
  } catch (e) {
    logError(tr('silButton'), `${tr('silFailed')}: ${(e as Error)?.message ?? e}`)
  } finally {
    useSilences.setState({ busy: false })
  }
}

// a proposal is in project seconds: any edit of the tracks makes it stale
useEditor.subscribe((s, prev) => {
  if (s.project.tracks !== prev.project.tracks && useSilences.getState().items.length) clearSilences()
})

export function setSilenceState(id: string, state: Silence['state']) {
  useSilences.setState((u) => ({ items: u.items.map((x) => x.id === id ? { ...x, state } : x) }))
}

export interface FindSilencesArgs extends SilenceOpts {
  /** a clip (its linked twins heard too); default: the range, else the whole timeline */
  clipId?: string
  start?: number
  end?: number
  /** only these tracks are heard (the voice track under music) */
  trackIds?: string[]
}

/** Analyse, replace the shown proposals with the new ones and return them. */
export async function findSilences(a: FindSilencesArgs = {}): Promise<Silence[]> {
  const s = useEditor.getState()
  const p = s.project
  let start: number, end: number
  let clipIds: string[] | undefined
  if (a.clipId) {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === a.clipId)
    if (!c) throw new Error(`no clip ${a.clipId}`)
    start = c.start; end = c.start + c.duration
    clipIds = withLinked(p, [c.id])
  } else if (a.start !== undefined && a.end !== undefined) {
    start = a.start; end = a.end
  } else if (s.range) {
    start = s.range.start; end = s.range.end
  } else {
    start = 0; end = projectDuration(p)
  }
  if (!(end - start > 0)) throw new Error('nothing to analyse: empty range')
  const filter = clipIds ? { clipIds } : a.trackIds ? { trackIds: a.trackIds } : undefined
  const segments = collectRangeAudio(p, start, end, filter)
  if (!segments.length) throw new Error('no audible audio there')
  const env = await window.kadr.audioEnvelope({ audioSegments: segments, duration: end - start, fps: ENV_FPS, attack: 0.005, release: 0.005 })
  // words heard in what was analysed: every one in the mix, else those of its clips
  const heard = clipIds ?? (a.trackIds ? p.tracks.filter((t) => a.trackIds!.includes(t.id)).flatMap((t) => t.clips.map((c) => c.id)) : undefined)
  const speech = placeWords(p)
    .filter((w) => !heard || !w.clipId || heard.includes(w.clipId))
    .map((w): [number, number] => [w.t0 - start, w.t1 - start])
  const items = silenceSpans(env, ENV_FPS, a, speech)
    .map(([a0, b0]) => [toFrame(start + a0, p.fps), toFrame(start + b0, p.fps)])
    .filter(([a0, b0]) => b0 > a0)
    .map(([a0, b0], i): Silence => ({ id: `s${i + 1}`, kind: 'silence', start: a0, end: b0, state: 'proposed' }))
  useSilences.setState((u) => ({ items: [...u.items.filter((x) => x.kind !== 'silence'), ...items] }))
  return items
}

/** The agent's proposals (kadr_propose): replace those of `kind`, keep the rest. */
export function proposeRanges(kind: string, ranges: { start: number; end: number; reason: string }[]): Silence[] {
  const p = useEditor.getState().project
  const len = projectDuration(p)
  const bad = ranges.find((r) => !(r.end > r.start) || r.start < 0 || r.end > len + 1e-6)
  if (bad) throw new Error(`range ${bad.start}–${bad.end} is outside the timeline (0–${len.toFixed(3)} s)`)
  const items = ranges.map((r, i): Silence => ({
    id: `${kind}${i + 1}`, kind, reason: r.reason, start: toFrame(r.start, p.fps), end: toFrame(r.end, p.fps), state: 'proposed'
  }))
  useSilences.setState((u) => ({ items: [...u.items.filter((x) => x.kind !== kind), ...items], none: false }))
  return items
}

/** Cut proposals out of every unlocked track (ripple) as one undo step:
    'confirmed', 'all' that are not rejected, or these ids — of `kind` when
    given. Overlaps merge (store.extractRanges). Returns what went. */
export function applySilences(which: 'confirmed' | 'all' | string[], kind?: string): Silence[] {
  const items = useSilences.getState().items.filter((x) => x.kind !== 'short' && (!kind || x.kind === kind))
  const chosen = Array.isArray(which)
    ? items.filter((x) => which.includes(x.id))
    : items.filter((x) => (which === 'all' ? x.state !== 'rejected' : x.state === 'confirmed'))
  if (Array.isArray(which) && chosen.length !== which.length) {
    throw new Error(`unknown proposal ids: ${which.filter((id) => !items.some((x) => x.id === id)).join(', ')}`)
  }
  if (!chosen.length) return []
  useEditor.getState().extractRanges(chosen)
  clearSilences()
  return chosen
}
