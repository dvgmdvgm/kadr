// Long → shorts (card I11): the agent proposes ranges of kind 'short'
// (kadr_propose), the user confirms them on the timeline flags, and
// «Экспортировать выбранные» in the export dialog renders each confirmed one
// to its own file, named from the reason, with the dialog's preset (9:16 fill
// included). ONE EXPORT AT A TIME (CLAUDE.md): the next starts only when the
// previous one is done. A short is exported, never cut (silences.cuttable).
// Test: node scripts/check-batch-ranges.mjs
import type { ExportHandle, TimeRange } from './exporter'
import { safeFileName } from '@shared/exportPresets'
import { useSilences } from './silences'

export const SHORT = 'short'

export interface ShortJob { id: string; start: number; end: number; path: string }

/** the confirmed shorts */
export const confirmedShorts = () => useSilences.getState().items.filter((x) => x.kind === SHORT && x.state === 'confirmed')

/** One job per confirmed short, in timeline order, each with a path of its own in `dir`:
    a name taken by another short of the batch or by a file already there gets « (2)», « (3)»… */
export async function shortJobs(dir: string, ext: string, stat: (paths: string[]) => Promise<(number | null)[]> = (p) => window.kadr.statMany(p)): Promise<ShortJob[]> {
  const sep = dir.includes('\\') ? '\\' : '/'
  const base = dir.replace(/[\\/]+$/, '') + sep
  const items = [...confirmedShorts()].sort((a, b) => a.start - b.start)
  const names = items.map((x) => safeFileName((x.reason ?? '').slice(0, 80)))
  // every candidate a short could take, asked of the disk once
  const cands = names.map((n) => Array.from({ length: items.length + 1 }, (_, k) => `${base}${k ? `${n} (${k + 1})` : n}.${ext}`))
  const flat = [...new Set(cands.flat())]
  const sizes = await stat(flat)
  const taken = new Set(flat.filter((_, i) => sizes[i] !== null).map((p) => p.toLowerCase()))
  return items.map((x, i) => {
    // ponytail: n+1 candidates per name; with every one of them on disk the last is reused — widen if that ever happens
    const path = cands[i].find((p) => !taken.has(p.toLowerCase())) ?? cands[i][cands[i].length - 1]
    taken.add(path.toLowerCase())
    return { id: x.id, start: x.start, end: x.end, path }
  })
}

/** Run the jobs one after another through `start` (the exporter's startExport over a range);
    a failure or a cancel stops the batch. */
export function exportShorts(jobs: ShortJob[], start: (range: TimeRange, path: string) => ExportHandle, onItem?: (i: number) => void): ExportHandle {
  let cur: ExportHandle | null = null
  let cancelled = false
  const done = (async () => {
    for (let i = 0; i < jobs.length; i++) {
      if (cancelled) throw new Error('cancelled')
      onItem?.(i)
      cur = start({ start: jobs[i].start, end: jobs[i].end }, jobs[i].path)
      await cur.done
    }
  })()
  return { cancel: () => { cancelled = true; cur?.cancel() }, done }
}
