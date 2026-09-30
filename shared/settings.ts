// The settings schema: one entry per setting the user can change. Main owns
// the values (`userData/settings.json`, electron/settings.ts) and hands the
// renderer a synchronous copy on boot; `useSettings` in the store mirrors it.
//
// The file holds only the DIFFERENCES from these defaults, so a default that
// changes in a later version reaches everyone who never touched it.
// `env` names a variable that overrides the file (it wins, and is reported as
// the source); `legacy` is the localStorage key the value was migrated from.

export type SettingValue = boolean | number | string
export type SettingSection =
  | 'general' | 'newProject' | 'editing' | 'mouse' | 'playback' | 'save' | 'export'
  | 'storage' | 'tools' | 'speech' | 'claude'

/** `claude.permissionMode`'s choices (electron/claudeArgs.ts re-checks them) */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'] as const

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
  /** the page's zoom factor, % (webFrame.setZoomFactor) */
  'general.uiScale': { type: 'number', min: 90, max: 150, default: 100, section: 'general' },
  /** the two-note signal when a render finishes (src/engine/chime.ts) */
  'general.chime': { type: 'boolean', default: true, section: 'general' },
  /** % of the chime's own peak */
  'general.chimeVolume': { type: 'number', min: 0, max: 100, default: 100, section: 'general' },
  // copied into a project when it is created (store.ts newProject); the open project keeps its own
  'newProject.width': { type: 'number', min: 16, max: 8192, default: 1920, section: 'newProject' },
  'newProject.height': { type: 'number', min: 16, max: 8192, default: 1080, section: 'newProject' },
  'newProject.fps': { type: 'number', min: 1, max: 240, default: 30, section: 'newProject' },
  'newProject.background': { type: 'string', default: '#000000', section: 'newProject' },
  'newProject.videoTracks': { type: 'number', min: 1, max: 10, default: 2, section: 'newProject' },
  'newProject.audioTracks': { type: 'number', min: 0, max: 10, default: 1, section: 'newProject' },
  /** seconds an image lands on the timeline for */
  'editing.stillDuration': { type: 'number', min: 0.1, max: 3600, default: 5, section: 'editing' },
  'editing.textDuration': { type: 'number', min: 0.1, max: 3600, default: 4, section: 'editing' },
  /** the overlap blend a NEW clip carries (stamped into the clip, so the project looks the same everywhere) */
  'editing.transition': { type: 'string', default: 'crossfade', section: 'editing' },
  /** the first length of an edge (tip) transition, s */
  'editing.edgeDuration': { type: 'number', min: 0.05, max: 10, default: 0.5, section: 'editing' },
  /** fade-in/out of a new clip on an audio track, s */
  'editing.fade': { type: 'number', min: 0, max: 10, default: 0, section: 'editing' },
  /** snapping distance, screen px */
  'editing.snapRadius': { type: 'number', min: 0, max: 50, default: 10, section: 'editing' },
  /** S: 'selection' = the selection, or every track when nothing is selected; 'all' = every unlocked track */
  'editing.splitScope': { type: 'enum', options: ['selection', 'all'], default: 'selection', section: 'editing' },
  /** uniform lane height for all tracks, px */
  'editing.trackHeight': { type: 'number', min: 32, max: 140, default: 56, section: 'editing', legacy: 'kadr.trackh' },
  /** the timeline magnet (N): off = nothing snaps */
  'editing.snap': { type: 'boolean', default: true, section: 'editing' },
  /** snap targets: clip edges (and the timeline start), the playhead, the user's markers */
  'editing.snapEdges': { type: 'boolean', default: true, section: 'editing' },
  'editing.snapPlayhead': { type: 'boolean', default: true, section: 'editing' },
  'editing.snapMarkers': { type: 'boolean', default: true, section: 'editing' },
  /** clips, the range and markers snap to detected beats */
  'editing.snapBeats': { type: 'boolean', default: true, section: 'editing', legacy: 'kadr.snapBeats' },
  /** «Подтверждать удаление»: deleting a track with clips asks first */
  'editing.confirmDelete': { type: 'boolean', default: true, section: 'editing', legacy: 'kadr.confirmDelete' },
  /** «Лимитер в превью»: the preview's master is limited at −1 dBFS like the export */
  'playback.previewLimiter': { type: 'boolean', default: true, section: 'playback', legacy: 'kadr.previewLimiter' },
  /** the preview decodes the 540p proxy of a heavy source */
  'playback.proxies': { type: 'boolean', default: true, section: 'playback' },
  /** sources at or above this short side get a proxy, px */
  'playback.proxyMinSide': { type: 'number', min: 240, max: 4320, default: 720, section: 'playback' },
  /** the timeline view during playback: 'page' turns a page at the edge, 'smooth' keeps the playhead centred */
  'playback.follow': { type: 'enum', options: ['off', 'page', 'smooth'], default: 'page', section: 'playback' },
  // the preview's view menu (TransportBar → Preview.tsx); never reaches the export
  /** the canvas backing store: full, ½ or ¼ of the project size per side */
  'playback.previewQuality': { type: 'enum', options: ['full', 'half', 'quarter'], default: 'full', section: 'playback' },
  /** action-safe (90 %) and title-safe (80 %) frames over the preview */
  'playback.safeGuides': { type: 'boolean', default: false, section: 'playback' },
  /** the rule-of-thirds grid over the preview */
  'playback.thirds': { type: 'boolean', default: false, section: 'playback' },
  /** the preview's frame rate and dropped frames while playing */
  'playback.frameStats': { type: 'boolean', default: false, section: 'playback' },
  // the timeline's mouse (Timeline.tsx)
  /** 'zoom': the wheel zooms, Shift scrolls; 'scroll': the wheel scrolls, Ctrl zooms */
  'mouse.wheel': { type: 'enum', options: ['zoom', 'scroll'], default: 'zoom', section: 'mouse' },
  /** × the wheel's zoom step */
  'mouse.zoomSpeed': { type: 'number', min: 0.25, max: 4, default: 1, section: 'mouse' },
  /** the modifier that turns an edge drag into a speed change */
  'mouse.speedModifier': { type: 'enum', options: ['ctrlOrAlt', 'ctrl', 'alt'], default: 'ctrlOrAlt', section: 'mouse' },
  /** how close to a clip's edge a drag trims, px */
  'mouse.edgeZone': { type: 'number', min: 2, max: 24, default: 8, section: 'mouse' },
  // autosave and backups (src/engine/autosave.ts, electron/backups.ts)
  /** minutes */
  'save.interval': { type: 'number', min: 1, max: 60, default: 5, section: 'save' },
  /** history moves between two backups */
  'save.ops': { type: 'number', min: 1, max: 500, default: 25, section: 'save' },
  'save.keep': { type: 'number', min: 1, max: 100, default: 10, section: 'save' },
  /** MB per project */
  'save.capMB': { type: 'number', min: 10, max: 100000, default: 500, section: 'save' },
  // the export dialog's starting values (ExportDialog.tsx), written back by it: the last export's choices
  'export.preset': { type: 'string', default: 'yt1080', section: 'export' },
  'export.motionBlur': { type: 'boolean', default: true, section: 'export' },
  'export.frameBlending': { type: 'boolean', default: true, section: 'export' },
  'export.fastEncoder': { type: 'boolean', default: false, section: 'export' },
  /** x264 rate control (shared/rawEncode.ts): the preset's bitrate, or constant quality (decision 3) */
  'export.quality': { type: 'enum', options: ['abr', 'crf'], default: 'abr', section: 'export' },
  'export.crf': { type: 'number', min: 0, max: 51, default: 18, section: 'export' },
  'export.x264Preset': { type: 'enum', options: ['faster', 'fast', 'medium', 'slow'], default: 'faster', section: 'export' },
  /** H.264 on x264 or a hardware encoder (G5; shared/rawEncode.ts rawCodec) — one missing here falls back to x264 */
  'export.videoEncoder': { type: 'enum', options: ['x264', 'nvenc', 'qsv', 'amf'], default: 'x264', section: 'export' },
  /** the dialog's own output size, fps and bitrate (Mbit/s) over the preset's; 0 = the preset's (G4) */
  'export.width': { type: 'number', min: 0, max: 8192, default: 0, section: 'export' },
  'export.height': { type: 'number', min: 0, max: 8192, default: 0, section: 'export' },
  'export.fps': { type: 'number', min: 0, max: 240, default: 0, section: 'export' },
  'export.bitrate': { type: 'number', min: 0, max: 400, default: 0, section: 'export' },
  /** a size other than the project's: bars, crop or stretch (shared/rawEncode.ts outputRect) */
  'export.fit': { type: 'enum', options: ['fit', 'fill', 'stretch'], default: 'fit', section: 'export' },
  /** the name the save dialog proposes: {project} {preset} {date} (shared/exportPresets.ts fileNameFrom) */
  'export.fileName': { type: 'string', default: '{project}', section: 'export' },
  /** where the REBUILDABLE caches live (proxies, decoded, fragment renders, LUTs); empty = userData */
  'storage.cacheRoot': { type: 'string', default: '', section: 'storage', restart: true },
  /** decoded intermediates, GB */
  'storage.decodedCapGB': { type: 'number', min: 1, max: 1000, default: 10, section: 'storage' },
  /** the export's temp files; empty = the system temp folder */
  'storage.tempDir': { type: 'string', default: '', section: 'storage' },
  'tools.ffmpeg': { type: 'string', default: 'ffmpeg', section: 'tools', restart: true, env: 'KADR_FFMPEG' },
  'tools.ffprobe': { type: 'string', default: 'ffprobe', section: 'tools', restart: true, env: 'KADR_FFPROBE' },
  /** empty = found automatically (electron/speechPython.ts) */
  'tools.speechPython': { type: 'string', default: '', section: 'tools', env: 'KADR_PYTHON' },
  /** empty = the speech interpreter if it has torch, else python3.11 (electron/voice.ts) */
  'tools.detectorPython': { type: 'string', default: '', section: 'tools', env: 'KADR_TTSQC_PYTHON' },
  /** empty = ~/kadr-fragments */
  'tools.fragmentsDir': { type: 'string', default: '', section: 'tools', restart: true, env: 'KADR_FRAGMENTS_DIR' },
  'tools.fragmentsPort': { type: 'number', min: 1024, max: 65535, default: 5621, section: 'tools', restart: true, env: 'KADR_FRAGMENTS_PORT' },
  // the transcribe and captions dialogs' starting values
  'speech.model': { type: 'enum', options: ['large-v3', 'medium', 'base'], default: 'large-v3', section: 'speech' },
  'speech.language': { type: 'enum', options: ['auto', 'ru', 'en'], default: 'auto', section: 'speech' },
  /** 0 = whole phrases */
  'speech.wordsPerCue': { type: 'number', min: 0, max: 4, default: 3, section: 'speech' },
  // the panel's claude (electron/claudeArgs.ts); each takes effect on the next panel open
  /** the CLI to run; wins over claude-env.json `command`; empty = `claude` */
  'claude.command': { type: 'string', default: '', section: 'claude', env: 'KADR_CLAUDE_CMD' },
  /** one line, APPENDED after Kadr's flags (`splitArgs`) */
  'claude.extraArgs': { type: 'string', default: '', section: 'claude' },
  /** `--model`; empty = the user's own default */
  'claude.model': { type: 'string', default: '', section: 'claude' },
  /** `--permission-mode`; 'default' adds no flag. No bypassPermissions: the agent has a shell */
  'claude.permissionMode': { type: 'enum', options: PERMISSION_MODES, default: 'default', section: 'claude' },
  /** `--strict-mcp-config`: only Kadr's bridge and claude-mcp.json, not the user's global servers */
  'claude.strictMcp': { type: 'boolean', default: true, section: 'claude' },
  /** transcripts travel inside the .kadr (off: sending the file sends no conversations) */
  'claude.embedChats': { type: 'boolean', default: true, section: 'claude' }
} satisfies Record<string, SettingDef>

export type SettingKey = keyof typeof SETTINGS
export type SettingsDiff = Partial<Record<SettingKey, SettingValue>>
/** what main hands the renderer: the file's diff and the env overrides */
export interface SettingsSnapshot {
  user: SettingsDiff
  env: SettingsDiff
  /** the file as this run started: a `restart` setting keeps that value until the next launch */
  boot?: SettingsDiff
}
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

/** The value in force for this run: a `restart` setting is read as the file was at launch. */
export function running(key: SettingKey, snap: SettingsSnapshot): SettingValue {
  const d: SettingDef = SETTINGS[key]
  return effective(key, d.restart && snap.boot ? { ...snap, user: snap.boot } : snap).value
}

/** A restart setting whose new value waits for the next launch. */
export const awaitsRestart = (key: SettingKey, snap: SettingsSnapshot): boolean =>
  running(key, snap) !== effective(key, snap).value
