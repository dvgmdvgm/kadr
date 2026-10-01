// What the media bin shows and in which order (card H4). Pure: the grid and
// the list render the same list. Test: node scripts/check-bin-filter.mjs
import type { MediaAsset } from './types'

export type BinSort = 'added' | 'name' | 'duration' | 'type'
export const BIN_SORTS: readonly BinSort[] = ['added', 'name', 'duration', 'type']

export interface BinViewOpts {
  query: string
  sort: BinSort
  desc: boolean
  unusedOnly: boolean
}

/** the file extension of the asset's path, lower case, without the dot */
export function assetExt(a: Pick<MediaAsset, 'path'>): string {
  const base = a.path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** placements per asset id: clips referencing it, an A/V pair (one linkId) counted once */
export function usageCounts(tracks: { clips: { assetId?: string; linkId?: string }[] }[]): Map<string, number> {
  const seen = new Set<string>()
  const n = new Map<string, number>()
  for (const tr of tracks) {
    for (const c of tr.clips) {
      if (!c.assetId) continue
      if (c.linkId) {
        const key = c.assetId + '\n' + c.linkId
        if (seen.has(key)) continue
        seen.add(key)
      }
      n.set(c.assetId, (n.get(c.assetId) ?? 0) + 1)
    }
  }
  return n
}

const KIND_ORDER = { video: 0, image: 1, audio: 2 } as const
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** filtered (every word of the query in the name or «.ext», any case) and stably sorted —
    equal items keep the order they were added in, in either direction */
export function binView<A extends MediaAsset>(assets: A[], o: BinViewOpts, uses: Map<string, number>): A[] {
  const words = o.query.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => {
      if (o.unusedOnly && uses.get(a.id)) return false
      if (!words.length) return true
      const hay = `${a.name} .${assetExt(a)}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  const key: (x: A) => number | string =
    o.sort === 'duration' ? (x) => x.duration
      : o.sort === 'type' ? (x) => KIND_ORDER[x.kind] ?? 3
        : o.sort === 'name' ? (x) => x.name
          : () => 0
  const dir = o.desc ? -1 : 1
  rows.sort((p, q) => {
    const kp = key(p.a), kq = key(q.a)
    const c = typeof kp === 'string' ? byName.compare(kp, kq as string) : (kp as number) - (kq as number)
    if (c) return c * dir
    // ties: the order added; only «added» itself turns round with the direction
    return o.sort === 'added' ? (p.i - q.i) * dir : p.i - q.i
  })
  return rows.map((r) => r.a)
}
