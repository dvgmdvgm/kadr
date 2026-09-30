// The user's export presets (`userData/export-presets.json`, through the user
// store IPC) and the export file-name template. Pure: no window, no i18n —
// scripts/check-export-presets.mjs runs it in node.
//
// A user preset is a built-in's fields plus the three render options, under a
// name of the user's. The file is read back field by field: a hand-edited or
// half-written entry is dropped rather than handed to the exporter, and a file
// that is not a list at all means «no user presets» — the built-ins remain.
import type { ExportPreset } from './types'

export interface ExportOptions {
  motionBlur: boolean
  frameBlending: boolean
  fastEncoder: boolean
}

export type UserExportPreset = ExportPreset & ExportOptions & { user: true }

export const userPreset = (base: ExportPreset, opts: ExportOptions, name: string, id: string): UserExportPreset => ({
  ...base, id, name, motionBlur: opts.motionBlur, frameBlending: opts.frameBlending, fastEncoder: opts.fastEncoder, user: true
})

const str = (v: unknown) => typeof v === 'string'
const bool = (v: unknown) => typeof v === 'boolean'
const dim = (v: unknown) => v === 'project' || (typeof v === 'number' && Number.isFinite(v) && v > 0)
const FIELDS: Record<keyof UserExportPreset, (v: unknown) => boolean> = {
  id: (v) => str(v) && (v as string).length > 0,
  name: (v) => str(v) && (v as string).trim().length > 0,
  container: (v) => ['mp4', 'webm', 'mkv', 'mp3'].includes(v as string),
  codec: str,
  ffmpegVideo: str,
  width: dim,
  height: dim,
  fps: dim,
  videoBitrate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  audioCodec: str,
  audioBitrate: str,
  audioOnly: (v) => v === undefined || bool(v),
  motionBlur: bool,
  frameBlending: bool,
  fastEncoder: bool,
  user: (v) => v === true
}

/** the file's content → the valid user presets, in file order; never throws */
export function sanitizeUserPresets(raw: unknown, builtinIds: readonly string[]): UserExportPreset[] {
  if (!Array.isArray(raw)) return []
  const out: UserExportPreset[] = []
  const seen = new Set(builtinIds)
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (!(Object.keys(FIELDS) as (keyof UserExportPreset)[]).every((k) => FIELDS[k](r[k]))) continue
    if (seen.has(r.id as string)) continue
    seen.add(r.id as string)
    const p = {} as Record<string, unknown>
    for (const k of Object.keys(FIELDS)) if (r[k] !== undefined) p[k] = r[k]
    out.push(p as unknown as UserExportPreset)
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * `{project}`, `{preset}` and `{date}` (YYYY-MM-DD, local) filled in; the
 * characters Windows refuses in a file name become `_`, and trailing dots and
 * spaces go (Windows drops them silently). Empty template = `{project}`.
 */
export function fileNameFrom(template: string, v: { project: string; preset: string; date: Date }): string {
  const tpl = template.trim() || '{project}'
  const date = `${v.date.getFullYear()}-${pad(v.date.getMonth() + 1)}-${pad(v.date.getDate())}`
  const name = tpl
    .replace(/\{(project|preset|date)\}/g, (_, k: string) => (k === 'project' ? v.project : k === 'preset' ? v.preset : date))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  return name || 'export'
}
