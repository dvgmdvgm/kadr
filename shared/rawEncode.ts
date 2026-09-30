// ffmpeg argument builder for the raw-RGBA video encode, shared by the
// preload direct encoder (frames never leave the renderer process) and the
// main-process fallback. Input is WebGL readPixels output: bottom-up RGBA.
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
  bitrate: number
  /** x264 and hardware: 'abr' (default, the built-in presets) or constant quality */
  rateControl?: 'abr' | 'crf'
  /** x264 CRF / the hardware encoder's CQ, 0–51; default 18 (decision 3) */
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

/** `ffmpeg -hide_banner -encoders` → the hardware encoders it lists (table order).
    Listed is not usable: a missing driver fails only at encode time (probeEncodeArgs). */
export function parseEncoders(text: string): string[] {
  const listed = new Set(text.split('\n').map((l) => /^\s*V\S{5}\s+(\S+)/.exec(l)?.[1]).filter(Boolean))
  return HW_ENCODERS.filter((n) => listed.has(n))
}

/** one black frame through the encoder, output discarded — exit 0 = it opens here */
export const probeEncodeArgs = (name: string): string[] => [
  '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
  '-frames:v', '1', '-pix_fmt', pixFmt(name), '-c:v', name, '-f', 'null', '-'
]

/** which encoder the raw path runs: a preset's own codec, else H.264 on the chosen encoder */
export const rawCodec = (p: { ffmpegVideo: string; videoEncoder?: VideoEncoder }): string =>
  p.ffmpegVideo !== 'copy' ? p.ffmpegVideo
    : p.videoEncoder && p.videoEncoder !== 'x264' ? `h264_${p.videoEncoder}` : 'libx264'

// QSV takes nv12, not planar yuv420p; the rest take yuv420p
const pixFmt = (codec: string) => (codec.endsWith('_qsv') ? 'nv12' : 'yuv420p')

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
  const crf = Math.min(51, Math.max(0, Math.round(o.crf ?? 18)))
  const ow = o.outWidth ?? o.width
  const oh = o.outHeight ?? o.height
  const abr = ['-b:v', String(b), '-maxrate', String(Math.round(b * 1.6)), '-bufsize', String(b * 3)]
  const scale = `vflip,scale=${ow}:${oh}:out_color_matrix=bt709:out_range=tv`
  const vf = ow === o.width && oh === o.height
    ? 'vflip,scale=out_color_matrix=bt709:out_range=tv'
    : o.fit === 'fill'
      // cover the output, crop the overflow (crop centres by default)
      ? `${scale}:force_original_aspect_ratio=increase,crop=${ow}:${oh},setsar=1`
      : o.fit === 'stretch'
        ? `${scale},setsar=1`
        // aspect-preserving fit, centered on black bars, even dims for yuv420p
        : `${scale}:force_original_aspect_ratio=decrease:force_divisible_by=2` +
          `,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
  return [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${o.width}x${o.height}`, '-r', String(o.fps),
    '-i', 'pipe:0',
    '-vf', vf,
    ...(o.codec === 'libx264'
      ? ['-c:v', 'libx264', '-preset', speed, ...(o.rateControl === 'crf' ? ['-crf', String(crf)] : abr)]
      : (HW_ENCODERS as readonly string[]).includes(o.codec)
        ? hwArgs(o.codec, crf, abr, o.rateControl === 'crf')
        : ['-c:v', o.codec, '-b:v', String(b),
           ...(o.codec === 'libvpx-vp9' ? ['-row-mt', '1', '-cpu-used', '4'] : [])]),
    '-pix_fmt', pixFmt(o.codec),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    o.out
  ]
}
