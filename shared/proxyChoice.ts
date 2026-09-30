// Which video assets get a preview proxy and which play it (card H7).
// Pure — scripts/check-proxy-choice.mjs runs it in plain node.
//
// `MediaAsset.proxyMode` overrides the global «Прокси при воспроизведении»
// and its short-side threshold, both ways. The one thing it cannot override:
// a codec Chromium does not decode has no original to show (a 0×0 black
// <video>), so its proxy stays whatever the choice says.
import type { MediaAsset } from './types'

export type ProxyMode = NonNullable<MediaAsset['proxyMode']> | 'auto'

export interface ProxyEnv {
  /** the global «Прокси при воспроизведении» */
  proxies: boolean
  /** its short-side threshold, px */
  minSide: number
  /** Chromium decodes the asset's codec (src/engine/codecs.ts) */
  canDecode: boolean
  /** snapshots decode originals at full quality */
  sourceQuality?: boolean
}

type Asset = Pick<MediaAsset, 'kind' | 'width' | 'height' | 'hdr' | 'proxyMode'>

/** a proxy should exist for this asset */
export function buildsProxy(a: Asset, env: ProxyEnv): boolean {
  if (a.kind !== 'video') return false
  if (!env.canDecode) return true
  if (a.proxyMode === 'never') return false
  if (a.proxyMode === 'always') return true
  // an HDR source looks flat played as it is: its proxy is the tone-mapped one
  if (a.hdr) return true
  return env.proxies && Math.min(a.width, a.height) >= env.minSide
}

/** the preview plays the proxy (when one is built) rather than the original */
export function playsProxy(a: Asset, env: Omit<ProxyEnv, 'minSide'>): boolean {
  if (a.kind !== 'video') return false
  if (!env.canDecode) return true
  if (a.proxyMode === 'never') return false
  if (a.hdr) return true
  if (env.sourceQuality) return false
  return a.proxyMode === 'always' || env.proxies
}

const ALWAYS = new Set(['h264', 'vp8', 'vp9', 'av1'])
/** HEVC profiles by pixel format — the codec string the platform is asked about */
const HEVC: Record<string, string> = { yuv420p: 'hvc1.1.6.L93.B0', yuvj420p: 'hvc1.1.6.L93.B0', yuv420p10le: 'hvc1.2.4.L93.B0' }

/**
 * The preview can show this video's original (card J11). HEVC used to be a
 * static «no», so every HEVC clip — the snapshot too — played its crf-23 540p
 * proxy while the export read the original. Now the platform is asked for the
 * stream's profile; a format outside Main/Main10 (4:2:2, 4:4:4) or an asset
 * probed before `pixFmt` existed keeps its proxy, as before (the platform
 * answers «probably» for Rext too, so its word alone is not enough).
 * Unknown codec (old projects probed before the field existed) → assume yes.
 */
export function chromiumDecodes(a: { codec?: string; pixFmt?: string }, canPlay: (mime: string) => boolean): boolean {
  if (!a.codec || ALWAYS.has(a.codec)) return true
  const profile = a.codec === 'hevc' && a.pixFmt ? HEVC[a.pixFmt] : undefined
  return !!profile && canPlay(`video/mp4; codecs="${profile}"`)
}
