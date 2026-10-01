// Every file path a project holds, and how it is written to disk (card H8).
//
// In memory a path is ALWAYS absolute — the renderer, the preview, kadr:// and
// the MCP tools never see anything else. Only the .kadr file on disk carries a
// path RELATIVE to its own folder, for whatever lies inside that folder, so a
// collected project («Собрать проект») opens wherever its folder is copied.
// Relative paths are written with '/' whatever the OS, so a project collected on
// Windows opens on Linux and back. Pure strings, no node imports: main uses it
// for project:read/write and the collect, the check runs it in plain node.
import type { Project, Track } from './types'

export type PathKind = 'media' | 'proxy' | 'text' | 'script' | 'run' | 'lut'

/** absolute on either OS: `/x`, `\\x`, `C:\x`, `C:/x`, `\\server\share` */
const isAbs = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p)
const winLike = (p: string) => /^[a-zA-Z]:|\\/.test(p)
const trimSep = (d: string) => d.replace(/[\\/]+$/, '')

/** the folder a project file lives in */
export function dirOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return i <= 0 ? file.slice(0, i + 1) : file.slice(0, i)
}

/** `path` relative to `dir` with '/' when it lies inside `dir`, else `path` unchanged */
export function relPath(path: string, dir: string): string {
  if (!path || !dir || !isAbs(path)) return path
  const norm = (s: string) => (winLike(dir) ? s.replace(/\\/g, '/').toLowerCase() : s)
  const d = norm(trimSep(dir)) + '/'
  return norm(path).startsWith(d) ? path.slice(d.length).replace(/\\/g, '/') : path
}

/** a relative `path` joined onto `dir` in `dir`'s own separator; an absolute one unchanged */
export function absPath(path: string, dir: string): string {
  if (!path || !dir || isAbs(path)) return path
  const sep = winLike(dir) ? '\\' : '/'
  return trimSep(dir) + sep + path.replace(/[\\/]/g, sep)
}

/** every path the project refers to, with its kind (duplicates kept) */
export function projectPaths(p: Project): { path: string; kind: PathKind }[] {
  const out: { path: string; kind: PathKind }[] = []
  mapPaths(p, (path, kind) => { out.push({ path, kind }); return path })
  return out
}

/** a copy with every path passed through `fn` — the input is never touched */
export function mapPaths(p: Project, fn: (path: string, kind: PathKind) => string): Project {
  const f = (v: string | undefined, kind: PathKind) => (v ? fn(v, kind) : v)
  const luts = (tracks: Track[]) => tracks.map((t) => !t.clips?.some((c) => c.lut) ? t : {
    ...t,
    clips: t.clips.map((c) => { if (!c.lut) return c; const path = f(c.lut.path, 'lut')!; return path === c.lut.path ? c : { ...c, lut: { ...c.lut, path } } })
  })
  return {
    ...p,
    assets: (p.assets ?? []).map((a) => {
      const path = f(a.path, 'media')!, proxyPath = f(a.proxyPath, 'proxy')
      return path === a.path && proxyPath === a.proxyPath ? a
        : { ...a, path, ...(a.proxyPath !== undefined ? { proxyPath } : {}) }
    }),
    ...(p.tracks ? { tracks: luts(p.tracks) } : {}),
    // L6: the clips of the other timelines carry LUTs too
    ...(p.timelines ? { timelines: p.timelines.map((tl) => (tl.tracks ? { ...tl, tracks: luts(tl.tracks) } : tl)) } : {}),
    ...(p.texts ? { texts: p.texts.map((t) => { const path = f(t.path, 'text')!; return path === t.path ? t : { ...t, path } }) } : {}),
    ...(p.voiceRuns ? {
      voiceRuns: p.voiceRuns.map((r) => {
        const scriptPath = f(r.scriptPath, 'script')!, runDir = f(r.runDir, 'run')
        return scriptPath === r.scriptPath && runDir === r.runDir ? r
          : { ...r, scriptPath, ...(r.runDir !== undefined ? { runDir } : {}) }
      })
    } : {})
  }
}

/** what goes into the .kadr at `file`: paths inside its folder made relative */
export function saveRelative(p: Project, file: string | null): Project {
  if (!file) return p
  const dir = dirOf(file)
  return mapPaths(p, (path) => relPath(path, dir))
}

/** what a .kadr read from `file` means: relative paths resolved against its folder */
export function loadResolved(p: Project, file: string): Project {
  const dir = dirOf(file)
  return mapPaths(p, (path) => absPath(path, dir))
}

export interface CollectItem {
  from: string
  /** absolute target (the same path for 'inside' and 'missing') */
  to: string
  size: number
  /** a voice-over run is a folder, copied whole */
  dir: boolean
  /** copy it · an equal file of that name is already in media/ · already in the project folder · not on disk */
  action: 'copy' | 'reuse' | 'inside' | 'missing'
}

/**
 * Where each referenced file goes: `<project folder>/media/<its name>`, a
 * second file of the same name gets `name-2.ext`. A file of that name and size
 * already in media/ (an earlier collect) is reused, so collecting again copies
 * only what is missing. Proxies are a rebuildable cache and are never collected.
 */
export function planCollectItems(
  refs: { path: string; size: number | null; dir: boolean }[],
  projectDir: string,
  /** what media/ holds now: name → size */
  existing: Record<string, number>
): CollectItem[] {
  const sep = winLike(projectDir) ? '\\' : '/'
  const media = trimSep(projectDir) + sep + 'media'
  const taken = new Map(Object.entries(existing).map(([n, s]) => [n.toLowerCase(), s]))
  const out: CollectItem[] = []
  const done = new Set<string>()
  for (const r of refs) {
    if (done.has(r.path)) continue
    done.add(r.path)
    if (relPath(r.path, projectDir) !== r.path) { out.push({ from: r.path, to: r.path, size: r.size ?? 0, dir: r.dir, action: 'inside' }); continue }
    if (r.size === null) { out.push({ from: r.path, to: r.path, size: 0, dir: false, action: 'missing' }); continue }
    const base = r.path.slice(Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\')) + 1)
    const dot = r.dir ? -1 : base.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${stem}-${i}${ext}`
      const had = taken.get(name.toLowerCase())
      if (had === undefined || (had === r.size && !r.dir)) {
        taken.set(name.toLowerCase(), r.size)
        out.push({ from: r.path, to: media + sep + name, size: r.size, dir: r.dir, action: had === undefined ? 'copy' : 'reuse' })
        break
      }
    }
  }
  return out
}

export interface CollectPlan {
  items: CollectItem[]
  /** bytes the copy will write */
  copyBytes: number
  /** free bytes on the project's drive (null when it could not be read) */
  free: number | null
}
