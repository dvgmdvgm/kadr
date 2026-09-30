// The settings schema: one entry per setting the user can change. Main owns
// the values (`userData/settings.json`, electron/settings.ts) and hands the
// renderer a synchronous copy on boot; `useSettings` in the store mirrors it.
//
// The file holds only the DIFFERENCES from these defaults, so a default that
// changes in a later version reaches everyone who never touched it.
// `env` names a variable that overrides the file (it wins, and is reported as
// the source); `legacy` is the localStorage key the value was migrated from.

export type SettingValue = boolean | number | string
export type SettingSection = 'general' | 'editing' | 'playback' | 'tools'

export interface SettingDef {
  type: 'boolean' | 'number' | 'string' | 'enum'
  default: SettingValue
  min?: number
  max?: number
  options?: readonly string[]
  section: SettingSection
  /** takes effect after a restart */
  restart?: boolean
  env?: string
  legacy?: string
}

export const SETTINGS = {
  'general.lang': { type: 'enum', options: ['ru', 'en'], default: 'ru', section: 'general', legacy: 'kadr.lang' },
  /** uniform lane height for all tracks, px */
  'editing.trackHeight': { type: 'number', min: 32, max: 140, default: 56, section: 'editing', legacy: 'kadr.trackh' },
  /** clips, the range and markers snap to detected beats */
  'editing.snapBeats': { type: 'boolean', default: true, section: 'editing', legacy: 'kadr.snapBeats' },
  /** «Подтверждать удаление»: deleting a track with clips asks first */
  'editing.confirmDelete': { type: 'boolean', default: true, section: 'editing', legacy: 'kadr.confirmDelete' },
  /** «Лимитер в превью»: the preview's master is limited at −1 dBFS like the export */
  'playback.previewLimiter': { type: 'boolean', default: true, section: 'playback', legacy: 'kadr.previewLimiter' },
  'tools.ffmpeg': { type: 'string', default: 'ffmpeg', section: 'tools', restart: true, env: 'KADR_FFMPEG' },
  'tools.ffprobe': { type: 'string', default: 'ffprobe', section: 'tools', restart: true, env: 'KADR_FFPROBE' }
} satisfies Record<string, SettingDef>

export type SettingKey = keyof typeof SETTINGS
export type SettingsDiff = Partial<Record<SettingKey, SettingValue>>
/** what main hands the renderer: the file's diff and the env overrides */
export interface SettingsSnapshot { user: SettingsDiff; env: SettingsDiff }
export type SettingSource = 'default' | 'user' | 'env'

const def = (key: string): SettingDef | undefined =>
  Object.prototype.hasOwnProperty.call(SETTINGS, key) ? (SETTINGS as Record<string, SettingDef>)[key] : undefined

/** A valid value for `key`, or undefined. Numbers are clamped into range. */
export function healValue(key: string, v: unknown): SettingValue | undefined {
  const d = def(key)
  if (!d) return undefined
  switch (d.type) {
    case 'boolean': return typeof v === 'boolean' ? v : undefined
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
      return Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, v))
    case 'enum': return typeof v === 'string' && d.options!.includes(v) ? v : undefined
    case 'string': return typeof v === 'string' && v !== '' ? v : undefined
  }
}

/** A value spelled as text (an env variable, a localStorage entry), healed. */
export function fromText(key: string, s: string): SettingValue | undefined {
  const d = def(key)
  if (!d) return undefined
  if (d.type === 'boolean') return s !== '0' && s !== 'false'
  if (d.type === 'number') return s.trim() === '' ? undefined : healValue(key, Number(s))
  return healValue(key, s)
}
export const fromLegacy = fromText

/**
 * Heal a parsed settings file into a diff: unknown keys and bad values are
 * dropped (`healed` counts them; a clamped number counts too), values equal to
 * the default are left out.
 */
export function sanitizeSettings(raw: unknown): { user: SettingsDiff; healed: number } {
  const user: SettingsDiff = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { user, healed: 1 }
  let healed = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const h = healValue(k, v)
    if (h === undefined || h !== v) healed++
    if (h !== undefined && h !== def(k)!.default) user[k as SettingKey] = h
  }
  return { user, healed }
}

/** The values the env overrides, parsed like the file's. */
export function envValues(env: Record<string, string | undefined>): SettingsDiff {
  const out: SettingsDiff = {}
  for (const [k, d] of Object.entries(SETTINGS as Record<string, SettingDef>)) {
    const s = d.env ? env[d.env] : undefined
    const v = s === undefined ? undefined : fromText(k, s)
    if (v !== undefined) out[k as SettingKey] = v
  }
  return out
}

export function effective(key: SettingKey, snap: SettingsSnapshot): { value: SettingValue; source: SettingSource } {
  if (snap.env[key] !== undefined) return { value: snap.env[key]!, source: 'env' }
  if (snap.user[key] !== undefined) return { value: snap.user[key]!, source: 'user' }
  return { value: SETTINGS[key].default, source: 'default' }
}
