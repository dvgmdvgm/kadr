// The recent-projects list (userData/recent-projects.json): newest first,
// one entry per path, at most RECENT_CAP. The storage panel reads it to
// attribute caches to projects; «Открыть»'s dropdown and the empty-project
// start state show it. Test: `node scripts/check-recent.mjs`.

export interface Recent { path: string; at: number }

export const RECENT_CAP = 20

/** heal whatever is on disk: junk dropped, newest first, duplicates folded into their newest */
export function normalizeRecent(raw: unknown): Recent[] {
  if (!Array.isArray(raw)) return []
  const valid = raw
    .filter((r): r is Recent => !!r && typeof r.path === 'string')
    .map((r) => ({ path: r.path, at: Number.isFinite(r.at) ? r.at : 0 }))
    .sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  return valid.filter((r) => !seen.has(r.path) && !!seen.add(r.path)).slice(0, RECENT_CAP)
}

/** `path` was just opened or saved */
export function pushRecent(list: Recent[], path: string, at: number): Recent[] {
  return normalizeRecent([{ path, at }, ...list])
}
