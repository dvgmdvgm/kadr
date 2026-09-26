// Speed change for a GROUP of clips (Alt/Ctrl edge drag, the speed dial).
// Pure numbers, no imports: scripts/check-speedlayout.mjs loads it in node.

export const SPEED_MIN = 0.02
export const SPEED_MAX = 100

export interface SpeedItem {
  id: string
  trackId: string
  start: number
  duration: number
  speed: number
}

export interface SpeedEntry {
  id: string
  speed: number
  duration: number
  start: number
}

/** Every clip keeps its source span at its new speed. Per track the clips
    stay a chain: the gap (or the overlap, i.e. a transition) between two
    neighbours keeps its length, and the anchored edge — the first start
    for 'start', the last end for 'end' — stays where it was. */
export function layoutSpeeds(
  items: SpeedItem[],
  speedOf: (it: SpeedItem) => number,
  anchor: 'start' | 'end'
): SpeedEntry[] {
  const out: SpeedEntry[] = []
  const tracks = new Map<string, SpeedItem[]>()
  for (const it of items) tracks.set(it.trackId, [...(tracks.get(it.trackId) ?? []), it])
  for (const list of tracks.values()) {
    list.sort((a, b) => a.start - b.start)
    const next = list.map((it) => {
      const speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speedOf(it)))
      return { id: it.id, speed, duration: (it.duration * (it.speed || 1)) / speed, start: it.start }
    })
    if (anchor === 'start') {
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].start - (list[i - 1].start + list[i - 1].duration)
        next[i].start = next[i - 1].start + next[i - 1].duration + gap
      }
    } else {
      const last = list.length - 1
      next[last].start = list[last].start + list[last].duration - next[last].duration
      for (let i = last - 1; i >= 0; i--) {
        const gap = list[i + 1].start - (list[i].start + list[i].duration)
        next[i].start = next[i + 1].start - gap - next[i].duration
      }
    }
    // ponytail: the left wall clamps each clip on its own, so a chain pushed
    // past t=0 piles up there; bound the drag instead if that ever matters
    for (const e of next) e.start = Math.max(0, e.start)
    out.push(...next)
  }
  return out
}
