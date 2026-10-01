// J6: the colour section's view state — never part of the project.
// «До и после» (the selected clip drawn without its colour left of a divider,
// preview only: snapshots and the export never see it), the key's pipette,
// and which groups of the section are open (remembered across clips).
import { create } from 'zustand'
import type { Clip, Project } from '@shared/types'
import type { CurveCh } from '@shared/curves'
import { useEditor, findClip } from '@/state/store'
import { stripColour, hasColour } from './colourEdit'

const OPEN_KEY = 'kadr.colourGroups'
const readOpen = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null'); return Array.isArray(v) ? v : ['prim'] } catch { return ['prim'] }
}

export const useColourUi = create<{
  compare: boolean
  /** the divider, 0…1 of the frame's width from the left */
  split: number
  /** the clip whose key colour the next preview click sets */
  picking: string | null
  open: string[]
  /** J7: the channel the curve graph edits */
  curveCh: CurveCh
  toggleGroup(g: string): void
}>((set, get) => ({
  curveCh: 'y',
  compare: false,
  split: 0.5,
  picking: null,
  open: readOpen(),
  toggleGroup: (g) => {
    const open = get().open.includes(g) ? get().open.filter((x) => x !== g) : [...get().open, g]
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)) } catch { /* a layout convenience */ }
    set({ open })
  }
}))

/** a clip the section applies to: a picture — whatever sits on a video track,
    but a compound clip (L6): flattenProject draws its contents, not it */
export function isVisualClip(p: Project, c: Clip) {
  return c.kind !== 'timeline' && p.tracks.some((t) => t.kind === 'video' && t.clips.some((x) => x.id === c.id))
}

/** the selected visual clip, or null */
export function colourTarget(): Clip | null {
  const s = useEditor.getState()
  const id = s.selection[0]
  const f = id ? findClip(s.project, id) : null
  return f && isVisualClip(s.project, f.clip) ? f.clip : null
}

/** what the preview draws left of the divider: the project with the selected
    clip's colour off — null when before/after is off or has nothing to show */
export function compareProject(p: Project): Project | null {
  const ui = useColourUi.getState()
  const selected = useEditor.getState().selection[0]
  if (!ui.compare || !selected) return null
  let hit = false
  const tracks = p.tracks.map((t) => t.clips.some((c) => c.id === selected && hasColour(c))
    ? (hit = true, { ...t, clips: t.clips.map((c) => (c.id === selected ? stripColour(c) : c)) })
    : t)
  return hit ? { ...p, tracks } : null
}
