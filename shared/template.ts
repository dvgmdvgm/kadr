// Project templates (card H3): «Сохранить как шаблон» keeps a project's
// STRUCTURE — settings, tracks, text clips, the user's own markers — and
// nothing that came from someone's media. Stored as userData/templates/<name>.kadr.
import type { Project } from './types'

const uid = () => Math.random().toString(36).slice(2, 10)

/**
 * The structure of `p`, as a new object (`p` is not touched). Dropped: assets
 * and every clip that plays one; fragment clips too — their id names a folder
 * owned by THIS project, so a new project would edit (and «Удалить» would
 * delete) the old project's composition; transcripts, voice-over runs and
 * defects (all bound to assets); the chats; beat/section/pause markers (an
 * analysis of music that is no longer there).
 */
export function templateOf(p: Project): Project {
  return {
    version: p.version,
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    background: p.background,
    tracks: p.tracks.map((t) => ({
      ...structuredClone(t),
      clips: structuredClone(t.clips.filter((c) => c.kind === 'text'))
    })),
    assets: [],
    markers: structuredClone((p.markers ?? []).filter((m) => !m.kind))
  }
}

/** A new project from a template: fresh ids everywhere, named like `newProject()`. */
export function projectFromTemplate(t: Project): Project {
  const p = structuredClone(t)
  p.id = uid()
  p.name = 'Untitled'
  for (const tr of p.tracks) {
    tr.id = uid()
    for (const c of tr.clips) c.id = uid()
  }
  for (const m of p.markers ?? []) m.id = uid()
  return p
}

/** A template's name as a file name (no extension): no separators, no reserved characters, never empty. */
export function templateFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|\.+$/g, '').slice(0, 80).trim()
  // Windows device names are not files, extension or not
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? `_${s}` : s || 'Template'
}
