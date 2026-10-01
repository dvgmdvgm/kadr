// The media bin's folders (card H5): `Project.bins` + `MediaAsset.binId`.
// A folder only GROUPS assets — nothing here ever removes one. Pure: the store
// runs these on its copy of the project, sanitizeProject runs `healBins`.
// Test: node scripts/check-bins.mjs
import type { BinFolder, MediaAsset } from './types'

type WithBins = { bins?: BinFolder[]; assets: MediaAsset[] }

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** is `id` the folder `target` or one of its ancestors */
function isAtOrAbove(bins: BinFolder[], target: string | null, id: string): boolean {
  const seen = new Set<string>()
  for (let cur = target; cur !== null && !seen.has(cur); cur = bins.find((b) => b.id === cur)?.parentId ?? null) {
    if (cur === id) return true
    seen.add(cur)
  }
  return false
}

/** load-time repair of a foreign or hand-edited project: junk and duplicate folders
    dropped, unknown parents and parentId cycles cut to the root, assets in a missing
    folder put at the root. Never drops an asset. */
export function healBins(p: WithBins): void {
  const seen = new Set<string>()
  const bins = (Array.isArray(p.bins) ? p.bins : []).filter((b) => {
    if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id || seen.has(b.id)) return false
    seen.add(b.id)
    return true
  })
  for (const b of bins) {
    if (typeof b.name !== 'string' || !b.name.trim()) b.name = '•'
    if (typeof b.parentId !== 'string' || !seen.has(b.parentId) || b.parentId === b.id) b.parentId = null
  }
  // a cycle: walk up from each folder; the step that closes the loop goes to the root
  const byId = new Map(bins.map((b) => [b.id, b]))
  for (const b of bins) {
    const path = new Set<string>()
    for (let cur: BinFolder | undefined = b; cur && cur.parentId !== null; cur = byId.get(cur.parentId)) {
      path.add(cur.id)
      if (path.has(cur.parentId)) { cur.parentId = null; break }
    }
  }
  p.bins = bins
  for (const a of p.assets) {
    if (a && 'binId' in a && (typeof a.binId !== 'string' || !seen.has(a.binId))) delete a.binId
  }
}

/** delete a folder: what it held (assets and subfolders) moves to the root */
export function dissolveBin(p: WithBins, id: string): boolean {
  if (!p.bins?.some((b) => b.id === id)) return false
  p.bins = p.bins.filter((b) => b.id !== id)
  for (const b of p.bins) if (b.parentId === id) b.parentId = null
  for (const a of p.assets) if (a.binId === id) delete a.binId
  return true
}

/** put assets and folders into `target` (null = the root); a folder never goes into
    itself or below itself. true when anything moved */
export function moveInto(p: WithBins, assetIds: string[], binIds: string[], target: string | null): boolean {
  const bins = p.bins ?? []
  if (target !== null && !bins.some((b) => b.id === target)) return false
  let moved = false
  const as = new Set(assetIds)
  for (const a of p.assets) {
    if (!as.has(a.id) || (a.binId ?? null) === target) continue
    if (target === null) delete a.binId
    else a.binId = target
    moved = true
  }
  for (const id of binIds) {
    const b = bins.find((x) => x.id === id)
    if (!b || b.parentId === target || isAtOrAbove(bins, target, id)) continue
    b.parentId = target
    moved = true
  }
  return moved
}

/** «Name», or «Name 2», «Name 3»… — the first not taken */
export function newBinName(bins: BinFolder[], base: string): string {
  const taken = new Set(bins.map((b) => b.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export type BinRow<A> =
  | { kind: 'bin'; bin: BinFolder; depth: number; count: number; open: boolean }
  | { kind: 'asset'; asset: A; depth: number }

/** what the bin draws, top to bottom: at each level the folders (natural name order),
    then its assets in the SHOWN order (binView's filter and sort). `count` is every
    asset in the folder's subtree. While filtering, only folders holding a shown asset
    appear, all open; otherwise a collapsed folder hides its subtree. */
export function binRows<A extends MediaAsset>(
  bins: BinFolder[], shown: A[], all: MediaAsset[],
  o: { collapsed: Set<string>; filtering: boolean }
): BinRow<A>[] {
  const known = new Set(bins.map((b) => b.id))
  const home = (a: MediaAsset) => (a.binId && known.has(a.binId) ? a.binId : null)
  const kids = new Map<string | null, BinFolder[]>()
  for (const b of bins) {
    const k = b.parentId !== null && known.has(b.parentId) ? b.parentId : null
    kids.set(k, [...(kids.get(k) ?? []), b])
  }
  for (const list of kids.values()) list.sort((x, y) => byName.compare(x.name, y.name))
  const held = new Map<string | null, A[]>()
  for (const a of shown) held.set(home(a), [...(held.get(home(a)) ?? []), a])
  // per folder: every asset below it, and whether a shown one is below it
  const count = new Map<string, number>()
  const hit = new Set<string>()
  const up = (id: string | null, f: (id: string) => void) => {
    const seen = new Set<string>()
    for (let cur = id; cur !== null && !seen.has(cur); cur = bins.find((b) => b.id === cur)?.parentId ?? null) {
      seen.add(cur)
      f(cur)
    }
  }
  for (const a of all) up(home(a), (id) => count.set(id, (count.get(id) ?? 0) + 1))
  for (const a of shown) up(home(a), (id) => hit.add(id))
  const rows: BinRow<A>[] = []
  const done = new Set<string>()
  const emit = (parent: string | null, depth: number) => {
    for (const b of kids.get(parent) ?? []) {
      if (done.has(b.id) || (o.filtering && !hit.has(b.id))) continue
      done.add(b.id)
      const open = o.filtering || !o.collapsed.has(b.id)
      rows.push({ kind: 'bin', bin: b, depth, count: count.get(b.id) ?? 0, open })
      if (open) emit(b.id, depth + 1)
    }
    for (const a of held.get(parent) ?? []) rows.push({ kind: 'asset', asset: a, depth })
  }
  emit(null, 0)
  return rows
}
