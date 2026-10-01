// Which video codecs this Chromium can decode by itself. Everything else
// (mpeg4, prores, HEVC the platform will not play, …) renders 0×0 black in a
// <video> element and is rejected by WebCodecs — those sources go through a
// cached full-res ffmpeg H.264 intermediate for export, and always get a
// preview proxy regardless of size. The rule is shared/proxyChoice.ts.
import { chromiumDecodes } from '@shared/proxyChoice'
import type { MediaAsset } from '@shared/types'

let probe: HTMLVideoElement | undefined
const said = new Map<string, boolean>()
// only a «yes» is kept: an answer asked before the GPU process is up may be «no» for now
const canPlay = (mime: string) => {
  if (said.get(mime)) return true
  probe ??= document.createElement('video')
  const yes = probe.canPlayType(mime) !== ''
  if (yes) said.set(mime, true)
  return yes
}

export function chromiumCanDecode(a: Pick<MediaAsset, 'codec' | 'pixFmt'>): boolean {
  return chromiumDecodes(a, canPlay)
}
