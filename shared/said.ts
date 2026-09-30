// Text main hands the renderer to say in the user's language.
//
// Main has no i18n table and does not know the UI language, so an error it
// throws (or a warning it returns) carries a key and its args instead of words:
// the message is SAID_MARK + the JSON of a `Said`. Electron wraps a handler's
// error as «Error invoking remote method 'x': Error: <message>», so the mark is
// looked for anywhere in the text. The renderer's `spoken()` (src/i18n.ts)
// turns it into words; every window.kadr call gets that for its rejections.
import type { Said } from './types'

export const SAID_MARK = '⁣said:'

/** The text form of a Said: what an Error's message or a warning string carries. */
export const said = (key: string, args?: Said['args']): string => SAID_MARK + JSON.stringify(args ? { key, args } : { key })

/** An Error main throws instead of a literal in one language. */
export const saidError = (key: string, args?: Said['args']): Error => new Error(said(key, args))

/** The Said inside a text, or null for plain text (or a mark that does not parse). */
export function parseSaid(text: string): Said | null {
  const at = text.indexOf(SAID_MARK)
  if (at < 0) return null
  try {
    const s = JSON.parse(text.slice(at + SAID_MARK.length)) as Said
    return typeof s?.key === 'string' ? s : null
  } catch {
    return null
  }
}
