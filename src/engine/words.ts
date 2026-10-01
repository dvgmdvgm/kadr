// Transcript words kept in the project (card I4). Whisper's word timestamps
// used to live only for the length of a transcription run; now the SRT doc
// keeps them, in the doc's own cue time — SOURCE seconds for a doc bound to an
// asset, exactly like voice defects, so a move/trim/split never stales them.
import type { Project, TextDoc, TextWord, TranscribeSegment } from '@shared/types'
import { clipsForAsset, spanToProject } from './voiceDefects'

/** A segment's words with whisper's continuation tokens glued back on
    ("мини" + "-программами"): no leading space = the same word. */
export function glueWords(seg: TranscribeSegment): { start: number; end: number; word: string; p: number }[] {
  const out: { start: number; end: number; word: string; p: number }[] = []
  for (const w of seg.words ?? []) {
    if (w.word.trim() === '') continue
    const prev = out[out.length - 1]
    if (prev && !w.word.startsWith(' ')) {
      prev.word += w.word
      prev.end = w.end
      prev.p = Math.min(prev.p, w.probability)
    } else {
      out.push({ start: w.start, end: w.end, word: w.word, p: w.probability })
    }
  }
  return out
}

const ms = (t: number) => Math.round(t * 1000) / 1000

/** whisper segments → TextDoc.words, shifted by `offset` like the cues */
export function docWords(segments: TranscribeSegment[], offset = 0): TextWord[] {
  return segments.flatMap((s) => glueWords(s).map((w) => ({
    t0: ms(Math.max(0, w.start + offset)),
    t1: ms(Math.max(0, w.end + offset)),
    w: w.word.trim(),
    p: Math.round(w.p * 100) / 100
  })))
}

export interface PlacedWord extends TextWord {
  docId: string
  /** the clip it is heard on (asset-bound docs); none for range docs */
  clipId?: string
}

/**
 * Every doc's words in PROJECT seconds, in timeline order. An asset-bound word
 * shows once per clip showing that part of the file (clipped to the clip, as
 * `placeDefects` does; nothing for a trimmed-away word), once per linked A/V
 * pair; a range doc maps by its offset.
 */
export function placeWords(project: Project, docs: TextDoc[] = project.texts ?? []): PlacedWord[] {
  const out: PlacedWord[] = []
  for (const doc of docs) {
    if (!doc.words?.length) continue
    if (!doc.assetId) {
      const off = doc.offset ?? 0
      for (const w of doc.words) out.push({ ...w, t0: off + w.t0, t1: off + w.t1, docId: doc.id })
      continue
    }
    const links = new Set<string>()
    for (const { clip } of clipsForAsset(project, doc.assetId)) {
      // a video and its audio twin show the same words: one set. Clips linked
      // by hand but cut differently are not twins.
      if (clip.linkId) {
        const key = `${clip.linkId}|${clip.start}|${clip.duration}|${clip.inPoint}|${clip.speed || 1}|${JSON.stringify(clip.speedRamp ?? null)}`
        if (links.has(key)) continue
        links.add(key)
      }
      for (const w of doc.words) {
        const s = spanToProject(clip, w.t0, w.t1)
        if (s) out.push({ ...w, t0: s.start, t1: s.end, docId: doc.id, clipId: clip.id })
      }
    }
  }
  return out.sort((a, b) => a.t0 - b.t0)
}
