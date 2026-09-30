import { create } from 'zustand'
import type { ExportPreset } from '@shared/types'
import { sanitizeUserPresets, userPreset, type ExportOptions, type UserExportPreset } from '@shared/exportPresets'
import { tr, type TKey } from './i18n'
import { saveUserStore } from './engine/userStore'

/** The name shown for a preset: the three that describe themselves in words are translated. */
const NAME_KEY: Record<string, TKey> = { source: 'presetSource', webm: 'presetWebm', mp3: 'presetMp3' }
export const presetName = (p: ExportPreset): string => (NAME_KEY[p.id] ? tr(NAME_KEY[p.id]) : p.name)

const AUDIO_CODEC: Record<string, string> = { aac: 'AAC', libopus: 'Opus', libmp3lame: 'MP3' }
/** the export dialog's read-only codec lines: «H.264 · 10 Mbit/s», «AAC · 192 kbit/s» */
const HW_LABEL = { nvenc: 'NVENC', qsv: 'Quick Sync', amf: 'AMF' } as const
/** «H.264 · CRF 18», «H.264 · NVENC · CQ 18»: a hardware encoder's quality is its own CQ, not CRF */
export const videoCodecLabel = (p: ExportPreset): string => {
  const hw = p.ffmpegVideo === 'copy' && p.videoEncoder && p.videoEncoder !== 'x264' ? HW_LABEL[p.videoEncoder] : ''
  return `${p.ffmpegVideo === 'libvpx-vp9' ? 'VP9' : 'H.264'}${hw ? ` · ${hw}` : ''} · ${p.rateControl === 'crf'
    ? `${hw ? 'CQ' : 'CRF'} ${p.crf ?? 18}` : `${+(p.videoBitrate / 1e6).toFixed(1)} ${tr('mbpsUnit')}`}`
}
export const audioCodecLabel = (p: ExportPreset): string =>
  `${AUDIO_CODEC[p.audioCodec] ?? p.audioCodec} · ${parseInt(p.audioBitrate)} ${tr('kbpsUnit')}`

export const PRESETS: ExportPreset[] = [
  {
    id: 'yt1080',
    name: 'YouTube 1080p (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1920,
    height: 1080,
    fps: 'project',
    videoBitrate: 10_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'yt4k',
    name: 'YouTube 4K (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 3840,
    height: 2160,
    fps: 'project',
    videoBitrate: 40_000_000,
    audioCodec: 'aac',
    audioBitrate: '256k'
  },
  {
    id: 'vertical',
    name: 'Shorts/Reels 1080×1920',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1080,
    height: 1920,
    fps: 'project',
    videoBitrate: 9_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'hd720',
    name: '720p (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 1280,
    height: 720,
    fps: 'project',
    videoBitrate: 5_000_000,
    audioCodec: 'aac',
    audioBitrate: '160k'
  },
  {
    id: 'source',
    name: 'Project size (MP4 H.264)',
    container: 'mp4',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 12_000_000,
    audioCodec: 'aac',
    audioBitrate: '192k'
  },
  {
    id: 'webm',
    name: 'WebM VP9 (re-encode)',
    container: 'webm',
    codec: 'avc',
    ffmpegVideo: 'libvpx-vp9',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 4_000_000,
    audioCodec: 'libopus',
    audioBitrate: '160k'
  },
  {
    id: 'mp3',
    name: 'MP3 (audio only)',
    container: 'mp3',
    codec: 'avc',
    ffmpegVideo: 'copy',
    width: 'project',
    height: 'project',
    fps: 'project',
    videoBitrate: 0,
    audioCodec: 'libmp3lame',
    audioBitrate: '320k',
    audioOnly: true
  }
]

// ---- the user's presets: userData/export-presets.json, newest first --------
// Built-ins stay read-only; a user preset is a built-in's fields plus the
// three render options (shared/exportPresets.ts reads the file back).

const FILE = 'export-presets'
export const useExportPresets = create<{ presets: UserExportPreset[] }>(() => ({ presets: [] }))
/** what the dialog, the settings screen and kadr_export choose from: the user's first */
export const allPresets = (): ExportPreset[] => [...useExportPresets.getState().presets, ...PRESETS]
export const isUserPreset = (p: ExportPreset): p is UserExportPreset => (p as UserExportPreset).user === true

function persist(presets: UserExportPreset[]) {
  useExportPresets.setState({ presets })
  void saveUserStore(FILE, presets)
}
export function saveExportPreset(base: ExportPreset, opts: ExportOptions, name: string): UserExportPreset {
  const p = userPreset(base, opts, name.trim(), `user-${crypto.randomUUID()}`)
  persist([p, ...useExportPresets.getState().presets])
  return p
}
export const renameExportPreset = (id: string, name: string) =>
  persist(useExportPresets.getState().presets.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)))
export const deleteExportPreset = (id: string) =>
  persist(useExportPresets.getState().presets.filter((p) => p.id !== id))

if (typeof window !== 'undefined' && window.kadr) {
  window.kadr.readUserStore(FILE).then(
    (raw) => useExportPresets.setState({ presets: sanitizeUserPresets(raw, PRESETS.map((p) => p.id)) }),
    () => { /* no file yet: the built-ins */ }
  )
}
