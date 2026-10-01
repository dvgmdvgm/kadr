// Main's one settings store (electron/settings.ts over userData/settings.json),
// opened on first use. Every consumer reads it at USE time, never at module
// load: imports evaluate before main.ts applies KADR_USER_DATA, so a module-load
// read would open the wrong folder.
import { app } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSettings, type SettingsStore } from './settings'
import type { SettingKey, SettingValue } from '@shared/settings'

let store: SettingsStore | null = null
export const appSettings = (): SettingsStore => (store ??= openSettings(app.getPath('userData')))

/** the value in force for this run (a restart setting as it was at launch) */
export const setting = <T extends SettingValue = SettingValue>(key: SettingKey): T => appSettings().running(key) as T

/** a REBUILDABLE cache folder (proxies, decoded, fragment renders, LUTs) under the cache root */
export const cacheDir = (name: string): string =>
  join(setting<string>('storage.cacheRoot') || app.getPath('userData'), name)

/** where the export writes its temp files */
export const tempDir = (): string => setting<string>('storage.tempDir') || tmpdir()
