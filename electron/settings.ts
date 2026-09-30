// Main's settings store: `userData/settings.json`, the diff from the defaults
// in shared/settings.ts. Read synchronously before the window exists, so every
// consumer in main and the renderer's boot copy see the same values. No
// electron import — main.ts wires the IPC, and scripts/check-settings.mjs
// drives this module directly.
import { readFileSync } from 'fs'
import { join } from 'path'
import { atomicWrite } from './atomicWrite'
import {
  effective, envValues, healValue, sanitizeSettings, SETTINGS,
  type SettingKey, type SettingsDiff, type SettingsSnapshot, type SettingValue
} from '@shared/settings'

export type SettingsPatch = Partial<Record<string, SettingValue | null>>

export function openSettings(
  dir: string,
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => console.warn('[kadr]', m)
) {
  const path = join(dir, 'settings.json')
  let user: SettingsDiff = {}
  let text: string | null = null
  try { text = readFileSync(path, 'utf8') } catch { /* no file yet: all defaults */ }
  if (text !== null) {
    // a broken file must never keep the editor from starting: defaults, one warning
    let healed = 1
    try { ({ user, healed } = sanitizeSettings(JSON.parse(text))) } catch { /* torn or not JSON */ }
    if (healed) warn(`${path}: ${healed} unreadable value(s) replaced by defaults`)
  }
  const envVals = envValues(env)
  let chain: Promise<unknown> = Promise.resolve()

  const snapshot = (): SettingsSnapshot => ({ user: { ...user }, env: { ...envVals } })

  return {
    snapshot,
    effective: (key: SettingKey) => effective(key, snapshot()),
    /** Merge a patch (null = back to the default); unknown keys and bad values are ignored. Writes serialize. */
    set(patch: SettingsPatch): Promise<SettingsSnapshot> {
      const next = { ...user }
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in SETTINGS)) continue
        const key = k as SettingKey
        const h = v === null ? undefined : healValue(key, v)
        if (v !== null && h === undefined) continue
        if (h === undefined || h === SETTINGS[key].default) delete next[key]
        else next[key] = h
      }
      user = next
      const json = JSON.stringify(next, null, 1)
      const write = chain.then(() => atomicWrite(path, json))
      chain = write.catch(() => {})
      return write.then(snapshot)
    }
  }
}

export type SettingsStore = ReturnType<typeof openSettings>
