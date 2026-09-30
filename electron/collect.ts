// «Собрать проект» (card H8): copy every file a project refers to into
// `<project folder>/media/` so the folder alone carries it to another machine.
// The plan is pure (shared/projectPaths.ts); this is the part that touches the
// disk. No electron import — `node scripts/check-collect.mjs` bundles it.
//
// Each file is copied to a `.part` sidecar and RENAMED on success (the app's
// cache rule), so a file in media/ always means "finished" — a cancelled or
// failed collect leaves no half file that the next run would take for a copy.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Project } from '../shared/types'
import { dirOf, planCollectItems, projectPaths, type CollectItem, type CollectPlan } from '../shared/projectPaths'

async function sizeOf(path: string): Promise<{ size: number; dir: boolean } | null> {
  const st = await fs.stat(path).catch(() => null)
  if (!st) return null
  if (!st.isDirectory()) return { size: st.size, dir: false }
  let size = 0
  for (const e of await fs.readdir(path, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) size += (await fs.stat(join(e.parentPath ?? e.path, e.name)).catch(() => null))?.size ?? 0
  }
  return { size, dir: true }
}

export async function planCollect(p: Project, projectFile: string): Promise<CollectPlan> {
  const dir = dirOf(projectFile)
  // proxies are a rebuildable cache keyed by their source — never collected
  const refs: { path: string; size: number | null; dir: boolean }[] = []
  for (const r of projectPaths(p)) {
    if (r.kind === 'proxy' || refs.some((x) => x.path === r.path)) continue
    const s = await sizeOf(r.path)
    refs.push({ path: r.path, size: s?.size ?? null, dir: s?.dir ?? r.kind === 'run' })
  }
  const existing: Record<string, number> = {}
  for (const e of await fs.readdir(join(dir, 'media'), { withFileTypes: true }).catch(() => [])) {
    if (e.name.includes('.part')) continue
    existing[e.name] = e.isFile() ? (await fs.stat(join(dir, 'media', e.name))).size : -1
  }
  const items = planCollectItems(refs, dir, existing)
  const st = await fs.statfs(dir).catch(() => null)
  return {
    items,
    copyBytes: items.reduce((s, i) => s + (i.action === 'copy' ? i.size : 0), 0),
    free: st ? st.bavail * st.bsize : null
  }
}

/**
 * Copies the plan's 'copy' items; resolves to old path → new path for every
 * item that now lives in media/ (copied or reused). `signal` stops between
 * files; what was already copied stays and is reused by the next collect.
 * ponytail: a cancel waits for the file in flight (copyFile cannot be aborted) —
 * stream the copy if single files of many GB make that wait felt.
 */
export async function copyCollect(
  items: CollectItem[],
  onProgress: (p: { done: number; total: number; file: string }) => void,
  signal?: { cancelled: boolean }
): Promise<Record<string, string>> {
  const total = items.reduce((s, i) => s + (i.action === 'copy' ? i.size : 0), 0)
  const map: Record<string, string> = {}
  let done = 0
  for (const i of items) {
    if (i.action === 'reuse') map[i.from] = i.to
    if (i.action !== 'copy') continue
    if (signal?.cancelled) throw new Error('cancelled')
    onProgress({ done, total, file: i.from })
    await fs.mkdir(dirOf(i.to), { recursive: true })
    const part = i.to + '.part'
    try {
      await fs.rm(part, { recursive: true, force: true })
      if (i.dir) await fs.cp(i.from, part, { recursive: true })
      else await fs.copyFile(i.from, part)
      await fs.rename(part, i.to)
    } catch (err) {
      await fs.rm(part, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    map[i.from] = i.to
    done += i.size
    onProgress({ done, total, file: i.from })
  }
  return map
}
