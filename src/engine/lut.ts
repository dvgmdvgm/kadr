// J2: the clips' LUT files, read and parsed once per path for the session.
// The preview asks `lutFor` while drawing (sync: the first frames draw without
// the LUT, the idle redraw picks it up); the export and snapshots `await
// loadLuts` first, so they never draw a frame before the look is there.
import type { Project } from '@shared/types'
import { parseCube, type CubeLut } from '@shared/lut'
import { logError } from './log'
import { tr } from '../i18n'

// ponytail: a file that failed stays failed, and an edited file is not re-read,
// until the window reloads — watch the file if LUTs get edited in place
const tables = new Map<string, Promise<CubeLut | null>>()
const ready = new Map<string, CubeLut | null>()

export function loadLut(path: string): Promise<CubeLut | null> {
  let p = tables.get(path)
  if (!p) {
    p = window.kadr.readTextFile(path).then((text) => {
      if (text === null) throw new Error('the file cannot be read')
      return parseCube(text)
    }).catch((e) => {
      logError(tr('lgLut'), `${path}: ${e instanceof Error ? e.message : e}`)
      return null
    }).then((t) => { ready.set(path, t); return t })
    tables.set(path, p)
  }
  return p
}

/** the parsed table if it is loaded; starts the load otherwise */
export function lutFor(path: string): CubeLut | undefined {
  if (!ready.has(path)) void loadLut(path)
  return ready.get(path) ?? undefined
}

/** every LUT the project's clips use, loaded */
export const loadLuts = (p: Project) =>
  Promise.all(p.tracks.flatMap((t) => t.clips).flatMap((c) => (c.lut?.path ? [loadLut(c.lut.path)] : [])))
