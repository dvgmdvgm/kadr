// K9: the preview side of denoise. A denoised clip PLAYS its source's cached
// denoised copy (main's `audio:denoise`, electron/main.ts ensureDenoised — the
// same file the export mixes). Until the copy exists the clip plays the
// original; the Inspector says it is being prepared. Runtime only: the paths
// are never written into the project, so a cleared cache is simply rebuilt.
import { create } from 'zustand'
import { logWarn } from './log'
import { tr } from '../i18n'
import type { Clip, Track, MediaAsset } from '@shared/types'
import { denoiseOf } from '@shared/audioFx'

interface DenoiseState {
  /** `path|nr` → the denoised file */
  files: Record<string, string>
  /** `path|nr` → 'busy' while it is built, or the error that stopped it (not retried this session) */
  status: Record<string, string>
}
export const useDenoise = create<DenoiseState>(() => ({ files: {}, status: {} }))

const keyOf = (path: string, nr: number) => `${path}|${nr}`

/** the denoised file for a source at a strength — null until it is built (the first ask starts it) */
export function denoisedPath(path: string, nr: number): string | null {
  const k = keyOf(path, nr)
  const s = useDenoise.getState()
  if (s.files[k]) return s.files[k]
  if (s.status[k]) return null
  useDenoise.setState({ status: { ...s.status, [k]: 'busy' } })
  window.kadr.audioDenoise(path, nr).then(
    (file) => useDenoise.setState((st) => {
      const { [k]: _, ...status } = st.status
      return { files: { ...st.files, [k]: file }, status }
    }),
    (err) => {
      useDenoise.setState((st) => ({ status: { ...st.status, [k]: String(err?.message ?? err) } }))
      logWarn(tr('lgSound'), tr('lmDenoiseFail'), `${path}: ${String(err)}`)
    }
  )
  return null
}

/** the file a clip plays in the preview instead of its source — its denoised copy once built (audio tracks only: a video clip's element is its picture); playback and the scrub alike */
export function denoisedFor(clip: Clip, track: Track, asset: MediaAsset): string | null {
  const nr = track.kind === 'audio' ? denoiseOf(clip.audioFx) : null
  return nr !== null ? denoisedPath(asset.path, nr) : null
}

/** what the Inspector shows: 'ready' | 'busy' | an error */
export function denoiseState(path: string, nr: number): string {
  const k = keyOf(path, nr)
  const s = useDenoise.getState()
  return s.files[k] ? 'ready' : s.status[k] ?? 'busy'
}
