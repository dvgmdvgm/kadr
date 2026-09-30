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
  /** 'libx264' or a preset ffmpegVideo codec such as 'libvpx-vp9' */
  codec: string
  bitrate: number
  /** x264 only: 'abr' (default, the built-in presets) or constant quality */
  rateControl?: 'abr' | 'crf'
  /** x264 CRF, 0–51; default 18 (decision 3) */
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

export function rawEncodeArgs(o: RawEncodeOpts): string[] {
  const b = Math.max(1_000_000, o.bitrate || 10_000_000)
  const speed = (X264_PRESETS as readonly string[]).includes(o.x264Preset ?? '') ? o.x264Preset! : 'faster'
  const crf = Math.min(51, Math.max(0, Math.round(o.crf ?? 18)))
  const ow = o.outWidth ?? o.width
  const oh = o.outHeight ?? o.height
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
      ? ['-c:v', 'libx264', '-preset', speed,
         ...(o.rateControl === 'crf'
           ? ['-crf', String(crf)]
           : ['-b:v', String(b), '-maxrate', String(Math.round(b * 1.6)), '-bufsize', String(b * 3)])]
      : ['-c:v', o.codec, '-b:v', String(b),
         ...(o.codec === 'libvpx-vp9' ? ['-row-mt', '1', '-cpu-used', '4'] : [])]),
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    o.out
  ]
}
