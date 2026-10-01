// The export's progress read-out (G8): fps and time left from a moving
// average of the progress events, and the size a bitrate promises.
// Test: node scripts/check-eta.mjs
import type { ExportPreset } from './types'

export interface EtaSample {
  /** seconds, any origin */
  t: number
  /** 0..1 within the phase */
  p: number
}

/** the moving average's span: short enough to forget a slow start, long enough to ride out hiccups */
export const ETA_WINDOW = 5

/**
 * Time left in the phase and, when the phase counts `frames`, frames per second —
 * from the progress over the last ETA_WINDOW seconds. null until that span has
 * at least a second in it and progress moved.
 */
export function etaOf(samples: readonly EtaSample[], frames?: number): { eta: number; fps: number | null } | null {
  const last = samples[samples.length - 1]
  if (!last) return null
  let i = samples.length - 1
  while (i > 0 && last.t - samples[i - 1].t <= ETA_WINDOW) i--
  const first = samples[i]
  const dt = last.t - first.t
  if (dt < 1 || last.p <= first.p) return null
  const rate = (last.p - first.p) / dt
  return { eta: (1 - last.p) / rate, fps: frames ? rate * frames : null }
}

/** 83 → «1:23», 3725 → «1:02:05» */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** '192k' → 192000 bit/s; null when it is not a rate */
const bps = (r: string) => {
  const m = /^(\d+(?:\.\d+)?)(k|M)?$/i.exec(r.trim())
  return m ? Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1) : null
}

/**
 * Bytes the file will take: bitrate × duration. null where no bitrate rules the
 * size — constant quality, ProRes, a PNG sequence.
 */
export function estimateBytes(
  p: Pick<ExportPreset, 'videoBitrate' | 'audioBitrate' | 'container' | 'audioOnly' | 'rateControl' | 'videoCodec'>,
  duration: number
): number | null {
  const audio = bps(p.audioBitrate) ?? 0
  if (p.audioOnly) return (audio * duration) / 8
  if (p.rateControl === 'crf' || p.container === 'png' || p.videoCodec?.startsWith('prores')) return null
  return ((p.videoBitrate + audio) * duration) / 8
}
