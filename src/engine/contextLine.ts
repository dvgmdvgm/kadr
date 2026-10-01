// «Выделение — в запрос агенту» (card I2): one line naming what the user has
// selected, typed into claude's prompt WITHOUT Enter — the user finishes the
// sentence and sends it, so nothing reaches the model (or costs a token) until
// then. The panel registers the target; the action and the header button call
// sendContext.
//
// Times are PROJECT seconds, the unit every kadr_* tool takes, so the agent
// never converts a timecode; each clip carries its id for kadr_move/kadr_trim.
// The line goes through xterm's paste (bracketed when claude asks for it), so a
// newline or an ESC in a clip name would submit the prompt or end the paste
// early: every control character is folded into a space.
import type { Project } from '@shared/types'
import { tr, trPlural } from '../i18n'
import { useEditor, type TimeRange } from '../state/store'

type Ctx = { project: Project; selection: string[]; playhead: number; range: TimeRange | null }

const SHOWN = 6
const NAME_MAX = 40
const sec = (t: number) => `${t.toFixed(2)}s`
const span = (a: number, b: number) => `${a.toFixed(2)}–${sec(b)}`
const flat = (s: string) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim()
const cut = (s: string) => (s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s)

export function contextLine({ project, selection, playhead, range }: Ctx): string {
  const want = new Set(selection)
  const names = new Map(project.assets.map((a) => [a.id, a.name]))
  const clips = project.tracks.flatMap((t) => t.clips.filter((c) => want.has(c.id))).sort((a, b) => a.start - b.start)
  const parts: string[] = []
  if (clips.length) {
    const shown = clips.slice(0, SHOWN).map((c) => {
      // every text clip is labelled «Text»: its words are what tells them apart
      const name = cut(flat((c.kind === 'text' && c.text) || c.label || (c.assetId && names.get(c.assetId)) || c.fragmentId || c.kind))
      return `${name} #${c.id} ${span(c.start, c.start + c.duration)}`
    })
    if (clips.length > SHOWN) shown.push(`+${clips.length - SHOWN}`)
    parts.push(`${tr('ctxSel')}: ${clips.length} ${trPlural('ctxClips', clips.length)} (${shown.join(', ')})`)
  }
  parts.push(`${tr('ctxPlayhead')} ${sec(playhead)}`)
  if (range) parts.push(`${tr('ctxRange')} ${span(range.start, range.end)}`)
  return `[kadr] ${parts.join(' · ')} `
}

let target: ((line: string) => void) | null = null

/** the Claude panel's paste; returns its own unhook (a stale cleanup never unhooks a newer panel) */
export function setContextTarget(fn: (line: string) => void): () => void {
  target = fn
  return () => { if (target === fn) target = null }
}

export const contextTargetOpen = (): boolean => target !== null

/** type the line into the open panel's prompt; false when no panel is open */
export function sendContext(): boolean {
  if (!target) return false
  target(contextLine(useEditor.getState()))
  return true
}
