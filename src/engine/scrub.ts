// K7: audio scrub. While the playhead is dragged with playback stopped, every
// clip that sounds at the scrub position plays a short grain from an element
// of its OWN — the pool's elements are muted when paused and belong to the
// resync (player.ts syncMedia), which would fight a second master.
// The core is DOM-free (scripts/check-scrub-grains.mjs): the rate limit, and
// the guarantee that nothing sounds after the drag — a seek landing after the
// mouse is up is dropped, and every grain stops itself even if `end` never comes.

export const SCRUB_GAP_MS = 60
export const SCRUB_GRAIN_MS = 80

/** what one clip plays at the scrub position */
export interface Grain { key: string; at: number }
/** the slice of an HTMLMediaElement a grain needs */
export interface GrainEl {
  currentTime: number
  paused: boolean
  onseeked: ((ev: Event) => unknown) | null
  play(): unknown
  pause(): void
}

export function createScrub<G extends Grain>(o: {
  now: () => number
  /** the grains at timeline time t */
  grains: (t: number) => G[]
  /** the element that plays a grain (created once per key; its level set by the caller) */
  voice: (g: G) => GrainEl
  later: (fn: () => void, ms: number) => unknown
  cancel: (h: unknown) => void
}) {
  let live = false
  let last = -Infinity
  /** per element: its stop timer and the token of its newest grain */
  const active = new Map<GrainEl, { stop: unknown; token: number }>()
  let tokens = 0

  const silence = (el: GrainEl) => {
    const a = active.get(el)
    if (a) o.cancel(a.stop)
    active.delete(el)
    el.onseeked = null
    el.pause()
  }

  const grain = (g: G) => {
    const el = o.voice(g)
    const prev = active.get(el)
    if (prev) o.cancel(prev.stop)
    const token = ++tokens
    // the grain is timed from the seek landing (a software decode can take
    // longer than the grain); a stop timer from NOW caps a seek that never lands
    const a = { token, stop: o.later(() => silence(el), SCRUB_GRAIN_MS * 3) }
    active.set(el, a)
    el.onseeked = () => {
      if (!live || active.get(el)?.token !== token) return
      el.onseeked = null
      o.cancel(a.stop)
      a.stop = o.later(() => silence(el), SCRUB_GRAIN_MS)
      void Promise.resolve(el.play()).catch(() => { /* not ready */ })
    }
    el.currentTime = g.at
  }

  return {
    /** a drag starts: moves emit grains until `end` */
    begin() { live = true; last = -Infinity },
    move(t: number) {
      if (!live) return
      const n = o.now()
      if (n - last < SCRUB_GAP_MS) return
      last = n
      for (const g of o.grains(t)) grain(g)
    },
    /** the drag is over: every voice stops now, and a seek still in flight never plays */
    end() {
      live = false
      for (const el of [...active.keys()]) silence(el)
    }
  }
}
