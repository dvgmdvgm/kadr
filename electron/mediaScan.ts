// Folder import (card H6), the main-process half: a dropped or picked folder
// is walked HERE, not in the renderer — a folder of 10 000 frames must not
// freeze the editor. Picked files pass as they are (srt, 3D models, …);
// inside a folder only known media is taken, and numbered stills are
// gathered into runs (shared/sequences.ts).
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { detectSequences, mediaKindOfPath, type MediaScan } from '@shared/sequences'

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export async function scanMedia(paths: string[]): Promise<MediaScan> {
  const all: string[] = []
  let skipped = 0
  let folders = 0
  for (const p of paths) {
    let dir = false
    try { dir = (await fs.stat(p)).isDirectory() } catch { /* missing: the probe will say so */ }
    if (!dir) { all.push(p); continue }
    folders++
    const found: string[] = []
    for (const e of await fs.readdir(p, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue
      const full = join(e.parentPath, e.name)
      if (relative(p, full).split(sep).some((s) => s.startsWith('.')) || !mediaKindOfPath(e.name)) skipped++
      else found.push(full)
    }
    all.push(...found.sort(natural.compare))
  }
  const { sequences, rest } = detectSequences(all)
  // a lone EXR/TIFF/DPX/TGA cannot be shown as a still — it only comes in as a frame of a run
  const files = rest.filter((f) => mediaKindOfPath(f) !== 'frame')
  skipped += rest.length - files.length
  return { files, sequences, skipped, folders }
}
