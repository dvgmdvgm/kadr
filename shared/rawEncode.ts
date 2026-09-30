// ffmpeg argument builder for the raw-RGBA video encode, shared by the
// preload direct encoder (frames never leave the renderer process) and the
// main-process fallback. Input is WebGL readPixels output: bottom-up RGBA,
// PREMULTIPLIED where it carries alpha (the compositor blends SRC_ALPHA over a
// (0,0,0,0) clear), so an alpha export unpremultiplies before the encoder.
import type { ExportPreset } from './types'

export interface RawEncodeOpts {
  /** raw input frame size — the compositor always renders at project size */
  width: number
  height: number
  /** target size when the preset differs from the project;
      omitted or equal → no resampling, output stays bit-identical to before */
  outWidth?: number
  outHeight?: number
  /** how the project frame meets a different output size; default 'fit' */
  fit?: OutputFit
  fps: number
  /** 'libx264', a hardware encoder (HW_ENCODERS) or a preset ffmpegVideo codec such as 'libvpx-vp9' */
  codec: string
  /** which ProRes profile prores_ks writes; the rest is told by `codec` */
  videoCodec?: VideoCodec
  /** keep the framebuffer's alpha (a transparent background on an alpha codec) */
  alpha?: boolean
  bitrate: number
  /** x264 and hardware: 'abr' (default, the built-in presets) or constant quality */
  rateControl?: 'abr' | 'crf'
  /** CRF / the hardware encoder's CQ: 0–51, VP9 and AV1 0–63; default 18 (decision 3) */
  crf?: number
  /** x264 speed preset; default 'faster' */
  x264Preset?: string
  out: string
}

/** fit: whole frame, black bars · fill: covers the output, the overflow is
    cropped (centred) · stretch: both axes scaled to the output */
export type OutputFit = 'fit' | 'fill' | 'stretch'

/** where the project frame (iw×ih) lands inside the output (ow×oh), centred —
    the fast encoder's canvas blit; ffmpeg's filters below do the same */
export function outputRect(fit: OutputFit | undefined, iw: number, ih: number, ow: number, oh: number) {
  if (fit === 'stretch') return { dx: 0, dy: 0, dw: ow, dh: oh }
  const s = (fit === 'fill' ? Math.max : Math.min)(ow / iw, oh / ih)
  const dw = Math.round(iw * s)
  const dh = Math.round(ih * s)
  return { dx: Math.floor((ow - dw) / 2), dy: Math.floor((oh - dh) / 2), dw, dh }
}

/** frames an export of `duration` seconds renders at the OUTPUT fps — the
    duration holds whatever the rate, the frame count follows it */
export const exportFrameCount = (duration: number, fps: number) => Math.max(1, Math.round(duration * fps))

/** the x264 speed presets the export dialog offers, fastest first */
export const X264_PRESETS = ['faster', 'fast', 'medium', 'slow'] as const

/** the hardware encoders the raw path knows, in the order they are offered */
export const HW_ENCODERS = [
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc',
  'h264_qsv', 'hevc_qsv', 'av1_qsv',
  'h264_amf', 'hevc_amf', 'av1_amf'
] as const
/** the export dialog's encoder choice for H.264 presets */
export type VideoEncoder = 'x264' | 'nvenc' | 'qsv' | 'amf'
export const VIDEO_ENCODERS: readonly VideoEncoder[] = ['x264', 'nvenc', 'qsv', 'amf']

/** `ffmpeg -hide_banner -encoders` → the hardware, then the optional CPU, encoders it lists (table order).
    Listed is not usable: a missing driver fails only at encode time (probeEncodeArgs). */
export function parseEncoders(text: string): string[] {
  const listed = new Set(text.split('\n').map((l) => /^\s*V\S{5}\s+(\S+)/.exec(l)?.[1]).filter(Boolean))
  return [...HW_ENCODERS, ...OPTIONAL_ENCODERS].filter((n) => listed.has(n))
}

/** one black frame through the encoder, output discarded — exit 0 = it opens here */
export const probeEncodeArgs = (name: string): string[] => [
  '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
  '-frames:v', '1', '-pix_fmt', pixFmt(name, false), '-c:v', name, '-f', 'null', '-'
]

/** the codecs the export offers (G6); H.264 is the built-ins' own */
export type VideoCodec = NonNullable<ExportPreset['videoCodec']>
interface CodecSpec {
  container: ExportPreset['container']
  audioCodec: string
  audioBitrate: string
  /** CPU encoders, preferred first; one in OPTIONAL_ENCODERS only when this ffmpeg has it */
  cpu: string[]
  /** a GPU family can encode it (`<codec>_nvenc` …) */
  hw?: boolean
  /** carries a transparent background */
  alpha?: boolean
}
export const VIDEO_CODECS: Record<VideoCodec, CodecSpec> = {
  h264: { container: 'mp4', audioCodec: 'aac', audioBitrate: '192k', cpu: ['libx264'], hw: true },
  hevc: { container: 'mp4', audioCodec: 'aac', audioBitrate: '192k', cpu: ['libx265'], hw: true },
  av1: { container: 'mp4', audioCodec: 'aac', audioBitrate: '192k', cpu: ['libsvtav1', 'libaom-av1'], hw: true },
  vp9: { container: 'webm', audioCodec: 'libopus', audioBitrate: '160k', cpu: ['libvpx-vp9'], alpha: true },
  prores422: { container: 'mov', audioCodec: 'pcm_s16le', audioBitrate: '1536k', cpu: ['prores_ks'] },
  prores4444: { container: 'mov', audioCodec: 'pcm_s16le', audioBitrate: '1536k', cpu: ['prores_ks'], alpha: true },
  // frames only: no audio track to put anywhere
  png: { container: 'png', audioCodec: '', audioBitrate: '0k', cpu: ['png'], alpha: true }
}
/** CPU encoders not every ffmpeg build carries (gyan.dev essentials: libx265 and libaom, no SVT) — detected like the GPU ones */
export const OPTIONAL_ENCODERS = ['libx265', 'libsvtav1', 'libaom-av1'] as const

/** a preset's codec: its own field, else what its ffmpegVideo says (VP9 or H.264) */
export const videoCodecOf = (p: { videoCodec?: VideoCodec; ffmpegVideo: string }): VideoCodec =>
  p.videoCodec ?? (p.ffmpegVideo === 'libvpx-vp9' ? 'vp9' : 'h264')

/** the preset in another codec: container and audio follow it, size and rate stay; '' = as it is */
export function withCodec(p: ExportPreset, c: VideoCodec | ''): ExportPreset {
  if (!c || p.audioOnly || !VIDEO_CODECS[c]) return p
  const k = VIDEO_CODECS[c]
  return {
    ...p, videoCodec: c, container: k.container,
    ffmpegVideo: c === 'h264' ? 'copy' : k.cpu[0],
    audioCodec: k.audioCodec, audioBitrate: k.audioCodec === p.audioCodec ? p.audioBitrate : k.audioBitrate
  }
}

/**
 * The encoder that runs `codec` here: the chosen GPU family when it opens, else
 * the first CPU encoder this ffmpeg has, else any GPU one that opens; null = none.
 * `available` is detectEncoders()'s list (the GPU and OPTIONAL_ENCODERS that work).
 */
export function pickEncoder(codec: VideoCodec, family: VideoEncoder | undefined, available: readonly string[]): string | null {
  const k = VIDEO_CODECS[codec]
  const want = k.hw && family && family !== 'x264' ? `${codec}_${family}` : null
  if (want && available.includes(want)) return want
  const cpu = k.cpu.find((n) => !(OPTIONAL_ENCODERS as readonly string[]).includes(n) || available.includes(n))
  if (cpu) return cpu
  return (k.hw && HW_ENCODERS.find((n) => n.startsWith(`${codec}_`) && available.includes(n))) || null
}

/** a PNG sequence is numbered beside the chosen name: clip.png → clip_000001.png … */
export const seqPattern = (path: string) => path.replace(/\.png$/i, '') + '_%06d.png'

/** the raw encode's temp file: a container that holds the codec (ProRes and VP9 alpha do not fit mp4) */
export const rawTempExt = (codec: string) =>
  codec === 'prores_ks' ? 'mov' : codec === 'libvpx-vp9' ? 'webm' : 'mp4'

/** which encoder the raw path runs: a preset's own codec, else H.264 on the chosen encoder */
export const rawCodec = (p: { ffmpegVideo: string; videoEncoder?: VideoEncoder }): string =>
  p.ffmpegVideo !== 'copy' ? p.ffmpegVideo
    : p.videoEncoder && p.videoEncoder !== 'x264' ? `h264_${p.videoEncoder}` : 'libx264'

// QSV takes nv12, not planar yuv420p; ProRes is 10-bit 4:2:2 / 4:4:4; the rest take yuv420p
function pixFmt(codec: string, alpha: boolean, v?: VideoCodec): string {
  if (codec === 'prores_ks') return v === 'prores4444' ? (alpha ? 'yuva444p10le' : 'yuv444p10le') : 'yuv422p10le'
  if (codec === 'png') return alpha ? 'rgba' : 'rgb24'
  if (codec === 'libvpx-vp9') return alpha ? 'yuva420p' : 'yuv420p'
  return codec.endsWith('_qsv') ? 'nv12' : 'yuv420p'
}

/** a hardware encoder's rate control: ABR at the bitrate, or its own constant quality («CQ») */
function hwArgs(codec: string, crf: number, abr: string[], quality: boolean): string[] {
  const fam = codec.slice(codec.indexOf('_') + 1)
  const q = String(crf)
  const rc = fam === 'nvenc'
    ? ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...(quality ? ['-cq', q, '-b:v', '0'] : abr)]
    : fam === 'qsv'
      ? ['-preset', 'medium', ...(quality ? ['-global_quality', q] : abr)]
      : ['-quality', 'quality', ...(quality ? ['-rc', 'cqp', '-qp_i', q, '-qp_p', q] : ['-rc', 'vbr_peak', ...abr])]
  return ['-c:v', codec, ...rc, ...(codec.startsWith('h264_') ? ['-profile:v', 'high'] : [])]
}

export function rawEncodeArgs(o: RawEncodeOpts): string[] {
  const b = Math.max(1_000_000, o.bitrate || 10_000_000)
  const speed = (X264_PRESETS as readonly string[]).includes(o.x264Preset ?? '') ? o.x264Preset! : 'faster'
  // VP9 and AV1 count quality 0–63; x264, x265 and the GPU encoders 0–51
  const crf = Math.min(/vp9|av1/.test(o.codec) ? 63 : 51, Math.max(0, Math.round(o.crf ?? 18)))
  const quality = o.rateControl === 'crf'
  const alpha = !!o.alpha && (o.codec === 'png' || o.codec === 'libvpx-vp9' ||
    (o.codec === 'prores_ks' && o.videoCodec === 'prores4444'))
  const ow = o.outWidth ?? o.width
  const oh = o.outHeight ?? o.height
  const abr = ['-b:v', String(b), '-maxrate', String(Math.round(b * 1.6)), '-bufsize', String(b * 3)]
  // straight alpha for the encoder, divided in planar RGB (in YUV it would shift the chroma)
  const flip = alpha ? 'vflip,format=gbrap,unpremultiply=inplace=1' : 'vflip'
  const scale = `${flip},scale=${ow}:${oh}:out_color_matrix=bt709:out_range=tv`
  const vf = ow === o.width && oh === o.height
    ? `${flip},scale=out_color_matrix=bt709:out_range=tv`
    : o.fit === 'fill'
      // cover the output, crop the overflow (crop centres by default)
      ? `${scale}:force_original_aspect_ratio=increase,crop=${ow}:${oh},setsar=1`
      : o.fit === 'stretch'
        ? `${scale},setsar=1`
        // aspect-preserving fit, centered on black bars, even dims for yuv420p
        : `${scale}:force_original_aspect_ratio=decrease:force_divisible_by=2` +
          `,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:${alpha ? 'black@0' : 'black'},setsar=1`
  return [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${o.width}x${o.height}`, '-r', String(o.fps),
    '-i', 'pipe:0',
    '-vf', vf,
    ...(o.codec === 'libx264' || o.codec === 'libx265'
      ? ['-c:v', o.codec, '-preset', speed, ...(quality ? ['-crf', String(crf)] : abr),
         // hvc1: the tag QuickTime and Apple devices play an HEVC mp4 by
         ...(o.codec === 'libx265' ? ['-x265-params', 'log-level=error', '-tag:v', 'hvc1'] : [])]
      : (HW_ENCODERS as readonly string[]).includes(o.codec)
        ? [...hwArgs(o.codec, crf, abr, quality), ...(o.codec.startsWith('hevc_') ? ['-tag:v', 'hvc1'] : [])]
        : o.codec === 'prores_ks'
          // 3 = 422 HQ, 4 = 4444; the quality is the profile's own, no bitrate
          ? ['-c:v', 'prores_ks', '-profile:v', o.videoCodec === 'prores4444' ? '4' : '3', '-vendor', 'apl0']
          : o.codec === 'png'
            ? ['-c:v', 'png']
            : ['-c:v', o.codec, ...(quality ? ['-crf', String(crf), '-b:v', '0'] : ['-b:v', String(b)]),
               ...(o.codec === 'libvpx-vp9' ? ['-row-mt', '1', '-cpu-used', '4'] : []),
               ...(o.codec === 'libaom-av1' ? ['-row-mt', '1', '-cpu-used', '6'] : []),
               ...(o.codec === 'libsvtav1' ? ['-preset', '8'] : [])]),
    '-pix_fmt', pixFmt(o.codec, alpha, o.videoCodec),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    o.out
  ]
}

/** a file of the sequence `pattern` (seqPattern's): its own base name and six digits — nothing else in the folder */
export function isSeqFrame(pattern: string, name: string): boolean {
  const base = pattern.replace(/^.*[\/]/, '').replace('%06d.png', '')
  return name.length === base.length + 10 && name.startsWith(base) && /^\d{6}\.png$/.test(name.slice(base.length))
}
