// The transcript panel (card I10, canvas I): the edit as a script. Words come
// from I4 (`placeWords`, project seconds, timeline order); deleting words is a
// ripple cut over their span (`extractRange`) whose edges are snapped to the
// middle of the real silence on each side — `python/kadr_phrases.py`'s
// `cut_point` rule (longest run under max(−45 dB, the noise floor + 6 dB), else
// the quietest point), read off the same `audio:envelope` the pauses use.
// Whisper's word edges are off by tens of ms: a cut at t0/t1 clips phonemes.
// The agent's proposals (I5/I8/I11) survive the panel's own cut, shifted.
// Test: node scripts/check-word-cut.mjs
import { create } from 'zustand'
import type { Project } from '@shared/types'
import { useEditor, withLinked, projectDuration } from '@/state/store'
import { collectRangeAudio } from './subtitles'
import type { PlacedWord } from './words'
import { useSilences, type Silence } from './silences'
import { toFrame } from './timelineMath'

// ------------------------------------------------------------------ the cut

const CUT_FPS = 200 // 5 ms, as kadr_phrases' RMS hop
const SEAM_PAD = 0.05 // a little wider than the gap: word edges are imprecise
const SILENCE_FLOOR_DB = -45
const FLOOR_MARGIN_DB = 6
/** a word with no neighbour: how far past it the cut may look for silence */
const EDGE_REACH = 0.5

/**
 * The cut point in the gap [lo, hi] (seconds) of an envelope sampled at `fps`
 * from `base`: the middle of the longest quiet run inside the gap ± SEAM_PAD,
 * else the quietest sample. Quiet = under max(−45 dB, p5 of the envelope + 6 dB).
 */
export function cutPoint(env: number[], fps: number, base: number, lo: number, hi: number): number {
  const a = Math.min(lo, hi) - SEAM_PAD, b = Math.max(lo, hi) + SEAM_PAD
  const i0 = Math.max(0, Math.floor((a - base) * fps)), i1 = Math.min(env.length, Math.ceil((b - base) * fps))
  if (i1 - i0 < 2) return (lo + hi) / 2
  const db = env.map((v) => 20 * Math.log10(v + 1e-12))
  const floor = [...db].sort((x, y) => x - y)[Math.floor(0.05 * (db.length - 1))]
  const thr = Math.max(SILENCE_FLOOR_DB, floor + FLOOR_MARGIN_DB)
  let best: [number, number] = [-1, -1]
  for (let i = i0; i < i1;) {
    if (db[i] >= thr) { i++; continue }
    let j = i
    while (j < i1 && db[j] < thr) j++
    if (j - i > best[1] - best[0]) best = [i, j]
    i = j
  }
  if (best[0] >= 0) return base + (best[0] + best[1] - 1) / 2 / fps
  let k = i0
  for (let i = i0; i < i1; i++) if (db[i] < db[k]) k = i
  return base + k / fps
}

const mid = (w: PlacedWord) => (w.t0 + w.t1) / 2

/** The project span deleting words[i..j] takes out, both edges snapped into silence and onto frames. */
export async function wordCutRange(p: Project, words: PlacedWord[], i: number, j: number): Promise<{ start: number; end: number }> {
  const dur = projectDuration(p)
  const first = words[i], last = words[j], prev = words[i - 1], next = words[j + 1]
  const near = [prev, first, last, next].filter(Boolean) as PlacedWord[]
  const clipIds = near.every((w) => w.clipId) ? withLinked(p, [...new Set(near.map((w) => w.clipId!))]) : undefined
  const seam = async (lo: number, hi: number, from: number, to: number) => {
    from = Math.max(0, Math.min(from, lo - SEAM_PAD)); to = Math.min(dur, Math.max(to, hi + SEAM_PAD))
    const segs = to > from ? collectRangeAudio(p, from, to, clipIds ? { clipIds } : undefined) : []
    if (!segs.length) return (lo + hi) / 2
    const env = await window.kadr.audioEnvelope({ audioSegments: segs, duration: to - from, fps: CUT_FPS, attack: 0.005, release: 0.005 })
    return cutPoint(env, CUT_FPS, from, lo, hi)
  }
  const [a, b] = await Promise.all([
    prev ? seam(prev.t1, first.t0, mid(prev), mid(first)) : seam(Math.max(0, first.t0 - EDGE_REACH), first.t0, 0, mid(first)),
    next ? seam(last.t1, next.t0, mid(last), mid(next)) : seam(last.t1, Math.min(dur, last.t1 + EDGE_REACH), mid(last), dur)
  ])
  return { start: toFrame(Math.max(0, a), p.fps), end: toFrame(Math.min(dur, b), p.fps) }
}

/** Proposals after a ripple cut of `r`: inside it gone, across it clipped, after it moved up. */
export function shiftProposals(items: Silence[], r: { start: number; end: number }): Silence[] {
  const len = r.end - r.start
  const at = (t: number) => (t <= r.start ? t : t >= r.end ? t - len : r.start)
  return items.map((x) => ({ ...x, start: at(x.start), end: at(x.end) })).filter((x) => x.end - x.start > 1e-6)
}

/** Where the panel cut, for the scissors marks and «Вырезано: N мест»; any other edit forgets them. */
export const useWordCuts = create<{ marks: { at: number; len: number }[] }>(() => ({ marks: [] }))
let cutting = false
useEditor.subscribe((s, prev) => {
  if (!cutting && s.project.tracks !== prev.project.tracks && useWordCuts.getState().marks.length) useWordCuts.setState({ marks: [] })
})

/** Delete words[i..j] from the timeline: ONE undo step, the proposals carried over. */
export async function cutWords(words: PlacedWord[], i: number, j: number): Promise<{ start: number; end: number } | null> {
  const s = useEditor.getState()
  const r = await wordCutRange(s.project, words, i, j)
  if (!(r.end > r.start)) return null
  const items = useSilences.getState().items
  const len = r.end - r.start
  cutting = true
  try { useEditor.getState().extractRange(r) } finally { cutting = false }
  // extractRange cleared the proposals (any tracks edit does); ours is a known shift
  if (items.length) useSilences.setState({ items: shiftProposals(items, r) })
  useWordCuts.setState((u) => ({
    marks: [...u.marks.map((m) => ({ ...m, at: m.at <= r.start ? m.at : Math.max(r.start, m.at - len) })), { at: r.start, len }]
  }))
  return r
}

// ------------------------------------------------------------------ the text

export interface Para { a: number; b: number; t0: number; t1: number }

/** A new paragraph at a pause ≥ 1 s, at a sentence end followed by ≥ 0.5 s, or where another doc speaks. */
export function paragraphs(words: PlacedWord[]): Para[] {
  const out: Para[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k], pw = words[k - 1]
    const gap = pw ? w.t0 - pw.t1 : Infinity
    if (!pw || gap >= 1 || (gap >= 0.5 && /[.!?…]["»”)]*$/.test(pw.w)) || w.docId !== pw.docId) {
      out.push({ a: k, b: k, t0: w.t0, t1: w.t1 })
    }
    const last = out[out.length - 1]
    last.b = k
    last.t1 = Math.max(last.t1, w.t1)
  }
  return out
}

/** The word under the playhead: the last one started at or before t, while it lasts or until the next. */
export function nowIndex(words: PlacedWord[], t: number): number {
  let lo = 0, hi = words.length - 1, k = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (words[m].t0 <= t + 1e-6) { k = m; lo = m + 1 } else hi = m - 1
  }
  return k >= 0 && t < Math.max(words[k].t1, words[k + 1]?.t0 ?? words[k].t1) ? k : -1
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/^[^\p{L}\p{N}]+/u, '')
/** Words matching the query by prefix, any case, ё = е. */
export function searchHits(words: PlacedWord[], q: string): number[] {
  const n = norm(q.trim())
  if (!n) return []
  const out: number[] = []
  words.forEach((w, k) => { if (norm(w.w).startsWith(n)) out.push(k) })
  return out
}

/** Paragraph time: m:ss.d, h:mm:ss past an hour. */
export function fmtT(t: number): string {
  const s = Math.max(0, t)
  if (s >= 3600) {
    const x = Math.floor(s)
    return `${Math.floor(x / 3600)}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
  }
  const d = Math.floor(s * 10) / 10
  return `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, '0')}`
}

/** The left side panel's tab — here so the palette's «Открыть транскрипт» can switch it. */
export const useSideTab = create<{ tab: 'media' | 'markers' | 'transcript' | 'scopes' | 'anim' | 'motion' }>(() => ({ tab: 'media' }))
