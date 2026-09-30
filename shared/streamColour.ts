// Which YUV matrix the preview's <video> uses for an H.264/HEVC stream — so the
// exporter's WebCodecs frames can be re-wrapped to match it (card J9).
// Pure — scripts/check-stream-colour.mjs runs it in plain node on real files.
// HEVC reaches the same path: WebCodecs decodes it on this machine even though
// the preview plays its proxy (src/engine/codecs.ts).
//
// The two decoders disagree on anything not fully described (Chromium 148,
// read in its source and measured on this app's own media table):
// - <video> (FFmpegDemuxer, media/ffmpeg/ffmpeg_common.cc
//   AVStreamToVideoDecoderConfig) takes the container's description (colr box,
//   or what ffmpeg read from the SPS), and when it is not `IsSpecified()` —
//   primaries, transfer AND matrix all set — guesses by height: under 720 →
//   BT.601, else BT.709. A matrix-only tag counts as NOT specified.
// - WebCodecs (media/base/mime_util_internal.cc ParseCodecHelper) starts from
//   REC709 for every codec string and only the SPS, when fully specified,
//   overrides it — it never guesses by height and never sees the colr box.
// Both decoders prefer a fully specified SPS over the container
// (media/gpu/h264_decoder.cc), so that case needs nothing.
//
// Media table (Windows, D3D11 decode; testsrc2, snapshot vs export before the
// fix): untagged, matrix-only 709/601 SD → preview BT.601, export BT.709,
// 24–28 dB; the same HD → both BT.709; full 709/601 in SPS+colr, SD and HD →
// equal. Linux is not measured here — the rule is Chromium's own code, not a
// platform guess.

export interface StreamColour {
  primaries: number
  transfer: number
  matrix: number
  fullRange: boolean
}

/** ISO/IEC 23091-2 code points: 0 = reserved, 2 = unspecified */
export function isSpecified(d: StreamColour | null): d is StreamColour {
  return !!d && d.primaries !== 0 && d.primaries !== 2 && d.transfer !== 0 && d.transfer !== 2 && d.matrix !== 2
}

/** Exp-Golomb reader over an RBSP (emulation-prevention bytes removed). */
class Bits {
  private pos = 0
  private b: Uint8Array
  constructor(nal: Uint8Array) {
    const out: number[] = []
    let zeros = 0
    for (const byte of nal) {
      if (zeros >= 2 && byte === 3) { zeros = 0; continue }
      zeros = byte === 0 ? zeros + 1 : 0
      out.push(byte)
    }
    this.b = Uint8Array.from(out)
  }
  u(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3]
      if (byte === undefined) throw new Error('SPS ended early')
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1)
      this.pos++
    }
    return v
  }
  ue(): number {
    let zeros = 0
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('bad Exp-Golomb')
    return 2 ** zeros - 1 + this.u(zeros)
  }
  se(): number {
    const k = this.ue()
    return k & 1 ? (k + 1) / 2 : -k / 2
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

/**
 * The colour description in an H.264 SPS NAL unit (header byte included, as
 * avcC carries it), or null when the VUI has none.
 */
export function avcSpsColour(nal: Uint8Array): StreamColour | null {
  const r = new Bits(nal)
  r.u(8) // NAL header
  const profile = r.u(8)
  r.u(16) // constraint flags, level
  r.ue() // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chroma = r.ue()
    if (chroma === 3) r.u(1)
    r.ue(); r.ue(); r.u(1) // bit depths, qpprime_y_zero_transform_bypass
    if (r.u(1)) { // seq_scaling_matrix_present
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!r.u(1)) continue
        let last = 8, next = 8
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256
          last = next === 0 ? last : next
        }
      }
    }
  }
  r.ue() // log2_max_frame_num_minus4
  const poc = r.ue()
  if (poc === 0) r.ue()
  else if (poc === 1) {
    r.u(1); r.se(); r.se()
    for (let n = r.ue(); n > 0; n--) r.se()
  }
  r.ue(); r.u(1); r.ue(); r.ue() // max_num_ref_frames, gaps, width, height
  if (!r.u(1)) r.u(1) // frame_mbs_only → mb_adaptive_frame_field
  r.u(1) // direct_8x8_inference
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue() } // frame cropping
  if (!r.u(1)) return null // no VUI
  if (r.u(1) && r.u(8) === 255) r.u(32) // aspect ratio (+ extended SAR)
  if (r.u(1)) r.u(1) // overscan
  if (!r.u(1)) return null // no video_signal_type
  r.u(3) // video_format
  const fullRange = r.u(1) === 1
  if (!r.u(1)) return null // no colour_description
  return { primaries: r.u(8), transfer: r.u(8), matrix: r.u(8), fullRange }
}

/** mp4box's view of a visual sample entry — only what is read here */
export interface SampleEntryLike {
  avcC?: { SPS?: { data: Uint8Array }[] }
  colr?: Colr
  colrs?: Colr[]
}
interface Colr { colour_type: string; colour_primaries?: number; transfer_characteristics?: number; matrix_coefficients?: number; full_range_flag?: number }

// WebCodecs spellings as TypeScript's DOM lib knows them (shared/ builds without
// DOM too); wider ones (bt2020, pq, hlg) belong to HDR sources, which reach the
// export through an ffmpeg intermediate (electron/hdr.ts) and never get here.
export interface ColourInit {
  primaries: 'bt709' | 'bt470bg' | 'smpte170m'
  transfer: 'bt709' | 'smpte170m' | 'iec61966-2-1'
  matrix: 'rgb' | 'bt709' | 'bt470bg' | 'smpte170m'
  fullRange: boolean
}
const PRIMARIES: Record<number, ColourInit['primaries']> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m' }
const TRANSFER: Record<number, ColourInit['transfer']> = { 1: 'bt709', 6: 'smpte170m', 13: 'iec61966-2-1' }
const MATRIX: Record<number, ColourInit['matrix']> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m' }

const BT601: ColourInit = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }
const BT709: ColourInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }

/** <video>'s guess for a stream that is not fully described */
export function heightGuess(height: number): ColourInit {
  return height < 720 ? BT601 : BT709
}

/**
 * The colour space the preview shows an H.264/HEVC stream in, as the frames
 * must be re-wrapped for the export — or null when WebCodecs already decodes
 * it that way (a fully specified SPS, which both decoders obey) or the colr
 * description has no WebCodecs spelling (left to the decoder, as before).
 */
// ponytail: an HEVC SPS is not parsed (its VUI sits behind profile_tier_level
// and the short-term ref sets) — HEVC is judged by its colr box alone, so a
// fully tagged HEVC stream with no colr box is guessed by height. ffmpeg and
// phones write colr; parse hvcC's SPS if footage without one turns up.
export function previewColour(entry: SampleEntryLike, height: number): ColourInit | null {
  for (const s of entry.avcC?.SPS ?? []) {
    try {
      if (isSpecified(avcSpsColour(s.data))) return null
    } catch { /* unparsable SPS — treat as undescribed */ }
  }
  const c = [entry.colr, ...(entry.colrs ?? [])].find((x) => x?.colour_type === 'nclx')
  const d = c && { primaries: c.colour_primaries ?? 2, transfer: c.transfer_characteristics ?? 2, matrix: c.matrix_coefficients ?? 2, fullRange: !!c.full_range_flag }
  if (isSpecified(d ?? null)) {
    const p = PRIMARIES[d!.primaries], t = TRANSFER[d!.transfer], m = MATRIX[d!.matrix]
    return p && t && m ? { primaries: p, transfer: t, matrix: m, fullRange: d!.fullRange } : null
  }
  return heightGuess(height)
}
