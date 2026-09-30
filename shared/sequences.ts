// Folder import and image sequences (card H6) — the pure half: what a file
// is by its extension, and which numbered stills are one run of frames.
// electron/mediaScan.ts walks folders with it; the import summary reads it.

const VIDEO = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mts'])
const AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'])
/** stills Chromium cannot show — they come in only as frames of a run (transcoded) */
const FRAME_ONLY = new Set(['exr', 'tif', 'tiff', 'dpx', 'tga'])
/** extensions ffmpeg's image2 demuxer reads as numbered frames (not gif: it is a video) */
const SEQ_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', ...FRAME_ONLY])

export type ScanKind = 'video' | 'audio' | 'image' | 'frame'

export function mediaKindOfPath(path: string): ScanKind | null {
  const m = /\.([^.\\/]+)$/.exec(path)
  const ext = m ? m[1].toLowerCase() : ''
  return VIDEO.has(ext) ? 'video' : AUDIO.has(ext) ? 'audio' : IMAGE.has(ext) ? 'image' : FRAME_ONLY.has(ext) ? 'frame' : null
}

/** fewer numbered stills than this stay stills */
export const SEQ_MIN = 3

export interface SeqRun {
  /** ffmpeg image2 pattern: the folder, the stem with % doubled, %0Nd or %d, the extension */
  pattern: string
  first: number
  count: number
  /** zero-padded width; 0 = unpadded (%d) */
  width: number
  /** shown in the bin: name_0001-0240.png */
  name: string
  /** the frames, in number order */
  files: string[]
}

/** what `media:scan` found (electron/mediaScan.ts) */
export interface MediaScan {
  /** media to import one file each, in the order given, a folder in place of itself */
  files: string[]
  sequences: SeqRun[]
  /** files inside the folders that are not media (or hidden, or a lone EXR/TIFF/DPX/TGA) */
  skipped: number
  /** how many of the given paths were folders */
  folders: number
}

/**
 * Numbered stills that are one run: same folder, stem and extension, one
 * numbering style (a leading zero fixes the width), numbers without a gap
 * (image2 stops at the first missing frame), at least SEQ_MIN long.
 * Everything else comes back in `rest`, in input order.
 */
export function detectSequences(paths: string[], min = SEQ_MIN): { sequences: SeqRun[]; rest: string[] } {
  const groups = new Map<string, { dir: string; stem: string; ext: string; items: { path: string; digits: string }[] }>()
  for (const path of paths) {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
    const m = /^(.*?)(\d{1,9})\.([^.]+)$/.exec(path.slice(cut))
    if (!m || !SEQ_EXT.has(m[3].toLowerCase())) continue
    const dir = path.slice(0, cut)
    const key = `${dir}\0${m[1]}\0${m[3]}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { dir, stem: m[1], ext: m[3], items: [] }))
    g.items.push({ path, digits: m[2] })
  }
  const sequences: SeqRun[] = []
  const merged = new Set<string>()
  for (const g of groups.values()) {
    // no leading zero anywhere → one unpadded run (%d); otherwise each width is its own numbering
    const padded = g.items.some((x) => x.digits.length > 1 && x.digits[0] === '0')
    const parts = new Map<number, { path: string; n: number }[]>()
    for (const x of g.items) {
      const w = padded ? x.digits.length : 0
      if (!parts.has(w)) parts.set(w, [])
      parts.get(w)!.push({ path: x.path, n: Number(x.digits) })
    }
    for (const [width, list] of parts) {
      list.sort((a, b) => a.n - b.n)
      let i = 0
      while (i < list.length) {
        let j = i + 1
        while (j < list.length && list[j].n === list[j - 1].n + 1) j++
        if (j - i >= min) {
          const run = list.slice(i, j)
          const num = (n: number) => String(n).padStart(width, '0')
          sequences.push({
            pattern: g.dir + g.stem.replace(/%/g, '%%') + (width ? `%0${width}d` : '%d') + '.' + g.ext,
            first: run[0].n,
            count: run.length,
            width,
            name: `${g.stem}${num(run[0].n)}-${num(run[run.length - 1].n)}.${g.ext}`,
            files: run.map((x) => x.path)
          })
          for (const x of run) merged.add(x.path)
        }
        i = j
      }
    }
  }
  return { sequences, rest: paths.filter((p) => !merged.has(p)) }
}

/** the file of frame `n` of an image2 pattern */
export const frameOf = (pattern: string, n: number): string =>
  pattern.replace(/%(?:0(\d+))?d|%%/g, (m, w) => (m === '%%' ? '%' : String(n).padStart(Number(w ?? 0), '0')))
