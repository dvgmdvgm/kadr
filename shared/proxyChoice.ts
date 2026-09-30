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
