// K7: the audio scrub on the live project — src/engine/scrub.ts's core with
// real elements. One <audio> per clip, routed element → gain → pan → master
// like the pool's (so the fader, the limiter, the meter and the output device
// apply), at the level the clip plays at that moment, at its speed.
import { useEditor } from '@/state/store'
import { flattenProject } from './nesting'
import { createScrub, type Grain } from './scrub'
import { audibleClipsAt, audioLevelAt, panAt } from './player'
import { clipSourceTime } from './timelineMath'
import { attachAudio, detachAudio, resumeAudio, setElementGain, setElementPan } from './audio'
import { AUDIO_SPEED_MIN, AUDIO_SPEED_MAX } from '@shared/audioSpeed'
import { speedAt } from '@shared/speedRamp'

interface ClipGrain extends Grain { path: string; level: number; pan: number; rate: number }

/** clip id → its scrub element; the oldest goes past VOICES_MAX */
const voices = new Map<string, { el: HTMLAudioElement; path: string }>()
const VOICES_MAX = 16
/** for tests and the embedded Claude: grains started, and voices sounding right now */
export const scrubStats = { grains: 0, playing: () => [...voices.values()].filter((v) => !v.el.paused).length }

function voice(g: ClipGrain): HTMLAudioElement {
  let v = voices.get(g.key)
  if (v && v.path !== g.path) drop(g.key)
  v = voices.get(g.key)
  if (!v) {
    const el = new Audio()
    el.preload = 'auto'
    el.crossOrigin = 'anonymous' // kadr:// is CORS-enabled; without it WebAudio hears silence
    el.src = window.kadr.fileUrl(g.path)
    attachAudio(el)
    v = { el, path: g.path }
    voices.set(g.key, v)
    if (voices.size > VOICES_MAX) drop(voices.keys().next().value!)
  }
  voices.delete(g.key) // re-insert: the map's order is the LRU
  voices.set(g.key, v)
  setElementGain(v.el, g.level)
  setElementPan(v.el, g.pan)
  v.el.playbackRate = g.rate
  scrubStats.grains++
  return v.el
}

function drop(key: string) {
  const v = voices.get(key)
  if (!v) return
  v.el.pause()
  detachAudio(v.el)
  v.el.removeAttribute('src')
  v.el.load()
  voices.delete(key)
}

export const scrub = createScrub<ClipGrain>({
  now: () => performance.now(),
  grains: (t) => {
    resumeAudio()
    const project = flattenProject(useEditor.getState().project)
    return audibleClipsAt(project, t).map(({ clip, track, asset }) => {
      const rel = t - clip.start
      return {
        key: clip.id, path: asset!.path, at: clipSourceTime(clip, asset, rel),
        level: audioLevelAt(clip, track, rel), pan: panAt(clip, track, t),
        rate: Math.min(AUDIO_SPEED_MAX, Math.max(AUDIO_SPEED_MIN, speedAt(clip, rel)))
      }
    })
  },
  voice,
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
})
