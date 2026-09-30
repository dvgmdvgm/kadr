// The action registry's data and key logic. Every editor action has an id, a
// label, a context and its default keys; src/engine/actions.ts attaches what
// each one does. The user's rebindings are a DIFF from these defaults
// (`userData/keymap.json`): an action the user never touched follows a changed
// default. Pure — scripts/check-keymap.mjs drives it without the app.
//
// Keys are PHYSICAL codes (`KeyD`, not 'd'), so a binding works the same in
// the ru and en layouts, and modifiers match EXACTLY: the old if/else ignored
// them, and Ctrl+D, Shift+D and Cmd+D all deleted clips.

export interface KeyChord { code: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
/** where a binding applies; two actions may share keys only in different contexts */
export type ActionContext = 'global'

export interface ActionSpec {
  id: string
  /** i18n key (src/i18n.ts); actions.ts checks it against TKey */
  labelKey: string
  context: ActionContext
  defaultKeys: KeyChord[]
  /** the key's browser default is cancelled (page scroll, the browser's own Ctrl+S) */
  prevent?: boolean
}

const k = (code: string, mods: Omit<KeyChord, 'code'> = {}): KeyChord => ({ code, ...mods })
const ctrl = { ctrl: true }
const g = 'global' as const

export const ACTIONS = [
  { id: 'transport.play', labelKey: 'actPlay', context: g, defaultKeys: [k('Space')], prevent: true },
  { id: 'edit.split', labelKey: 'actSplit', context: g, defaultKeys: [k('KeyS')] },
  { id: 'file.save', labelKey: 'save', context: g, defaultKeys: [k('KeyS', ctrl)], prevent: true },
  { id: 'file.saveAs', labelKey: 'saveAs', context: g, defaultKeys: [k('KeyS', { ctrl: true, shift: true })], prevent: true },
  { id: 'edit.delete', labelKey: 'actDelete', context: g, defaultKeys: [k('KeyD'), k('Delete'), k('Backspace')] },
  { id: 'edit.rippleDelete', labelKey: 'actRippleDelete', context: g, defaultKeys: [k('Delete', { shift: true })] },
  { id: 'edit.undo', labelKey: 'undoShort', context: g, defaultKeys: [k('KeyZ', ctrl)], prevent: true },
  { id: 'edit.redo', labelKey: 'redoShort', context: g, defaultKeys: [k('KeyZ', { ctrl: true, shift: true }), k('KeyY', ctrl)], prevent: true },
  { id: 'edit.copy', labelKey: 'actCopy', context: g, defaultKeys: [k('KeyC', ctrl)] },
  { id: 'edit.paste', labelKey: 'actPaste', context: g, defaultKeys: [k('KeyV', ctrl)] },
  { id: 'edit.pasteInsert', labelKey: 'actPasteInsert', context: g, defaultKeys: [k('KeyV', { ctrl: true, shift: true })] },
  { id: 'edit.trimStart', labelKey: 'actTrimStart', context: g, defaultKeys: [k('KeyQ')] },
  { id: 'edit.trimEnd', labelKey: 'actTrimEnd', context: g, defaultKeys: [k('KeyW')] },
  { id: 'edit.link', labelKey: 'actLink', context: g, defaultKeys: [k('KeyU')] },
  { id: 'marker.add', labelKey: 'actMarker', context: g, defaultKeys: [k('KeyM')] },
  { id: 'playhead.prevFrame', labelKey: 'actPrevFrame', context: g, defaultKeys: [k('ArrowLeft')], prevent: true },
  { id: 'playhead.nextFrame', labelKey: 'actNextFrame', context: g, defaultKeys: [k('ArrowRight')], prevent: true },
  { id: 'playhead.back1s', labelKey: 'actBack1s', context: g, defaultKeys: [k('ArrowLeft', { shift: true })], prevent: true },
  { id: 'playhead.fwd1s', labelKey: 'actFwd1s', context: g, defaultKeys: [k('ArrowRight', { shift: true })], prevent: true },
  { id: 'playhead.start', labelKey: 'toStart', context: g, defaultKeys: [k('Home')], prevent: true },
  { id: 'edit.escape', labelKey: 'actEscape', context: g, defaultKeys: [k('Escape')] },
  { id: 'app.settings', labelKey: 'setTitle', context: g, defaultKeys: [k('Comma', ctrl)], prevent: true },
  { id: 'app.palette', labelKey: 'actPalette', context: g, defaultKeys: [k('KeyK', ctrl)], prevent: true },
  // no key yet — listed so the command palette can find them
  { id: 'file.new', labelKey: 'newProject', context: g, defaultKeys: [] },
  { id: 'file.open', labelKey: 'actOpen', context: g, defaultKeys: [] },
  { id: 'file.export', labelKey: 'actExport', context: g, defaultKeys: [] },
  { id: 'tools.transcribe', labelKey: 'actTranscribe', context: g, defaultKeys: [] },
  { id: 'tools.captions', labelKey: 'actCaptions', context: g, defaultKeys: [] },
  { id: 'tools.beats', labelKey: 'beatsTitle', context: g, defaultKeys: [] },
  { id: 'tools.sounds', labelKey: 'actSounds', context: g, defaultKeys: [] },
  { id: 'tools.checks', labelKey: 'actChecks', context: g, defaultKeys: [] },
  { id: 'preview.snapshot', labelKey: 'actSnapshot', context: g, defaultKeys: [] },
  { id: 'preview.popout', labelKey: 'actPopout', context: g, defaultKeys: [] },
  { id: 'edit.closeGaps', labelKey: 'actCloseGaps', context: g, defaultKeys: [] }
] as const satisfies readonly ActionSpec[]

export type ActionId = (typeof ACTIONS)[number]['id']
/** the keymap file: only actions whose keys differ from the defaults; [] = unbound */
export type KeymapDiff = Partial<Record<ActionId, KeyChord[]>>

const byId = new Map<string, ActionSpec>(ACTIONS.map((a) => [a.id, a]))
const MODS = ['ctrl', 'shift', 'alt', 'meta'] as const

/** a chord with every modifier spelled out — the one shape compared */
const norm = (c: KeyChord) => ({ code: c.code, ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt, meta: !!c.meta })
export const sameChord = (a: KeyChord, b: KeyChord) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
const sameKeys = (a: KeyChord[], b: KeyChord[]) => a.length === b.length && a.every((c, i) => sameChord(c, b[i]))

export interface KeyEventLike { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }
export const chordOf = (e: KeyEventLike): KeyChord =>
  ({ code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })

export function keysOf(id: string, diff: KeymapDiff): KeyChord[] {
  return (diff as Record<string, KeyChord[]>)[id] ?? byId.get(id)?.defaultKeys ?? []
}

/** the action bound to exactly this key and these modifiers, in `context` */
export function actionFor(e: KeyEventLike, diff: KeymapDiff, context: ActionContext = 'global') {
  const c = chordOf(e)
  return ACTIONS.find((a) => a.context === context && keysOf(a.id, diff).some((b) => sameChord(b, c)))
}

/** The keys differing from the defaults, for the file. */
export function keymapDiff(map: Partial<Record<string, KeyChord[]>>): KeymapDiff {
  const out: Record<string, KeyChord[]> = {}
  for (const a of ACTIONS) {
    const keys = map[a.id]
    if (keys && !sameKeys(keys, a.defaultKeys)) out[a.id] = keys.map(compact)
  }
  return out
}

/** only the modifiers that are on — what the file holds */
const compact = (c: KeyChord): KeyChord => {
  const out: KeyChord = { code: c.code }
  for (const m of MODS) if (c[m]) out[m] = true
  return out
}

/** A keymap file as read: unknown actions and malformed chords are dropped, the rest kept. */
export function sanitizeKeymap(raw: unknown): KeymapDiff {
  const out: Record<string, KeyChord[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, keys] of Object.entries(raw)) {
    if (!byId.has(id) || !Array.isArray(keys)) continue
    out[id] = keys.filter((c): c is KeyChord =>
      !!c && typeof c === 'object' && typeof c.code === 'string' && c.code !== '' &&
      MODS.every((m) => c[m] === undefined || typeof c[m] === 'boolean')
    ).map(compact)
  }
  return out
}

/** Keys bound to more than one action in the same context. */
export function findConflicts(diff: KeymapDiff): { chord: KeyChord; context: ActionContext; ids: string[] }[] {
  const seen = new Map<string, { chord: KeyChord; context: ActionContext; ids: string[] }>()
  for (const a of ACTIONS) for (const c of keysOf(a.id, diff)) {
    const key = a.context + JSON.stringify(norm(c))
    const hit = seen.get(key) ?? { chord: compact(c), context: a.context, ids: [] }
    if (!hit.ids.includes(a.id)) hit.ids.push(a.id)
    seen.set(key, hit)
  }
  return [...seen.values()].filter((h) => h.ids.length > 1)
}

// ------------------------------------------------------------------ the shortcut editor

const LONE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|NumLock|ScrollLock|Fn|FnLock|AltGraph)$/
/** The chord a key press binds; null for a lone modifier (Ctrl pressed on the way to Ctrl+B). */
export const capturedChord = (e: KeyEventLike): KeyChord | null =>
  !e.code || LONE.test(e.code) ? null : compact(chordOf(e))

const ctxOf = (id: string) => byId.get(id)?.context
/** the other action holding `chord` where `id` lives — the one a rebinding takes it from */
export const holderOf = (diff: KeymapDiff, id: string, chord: KeyChord) =>
  ACTIONS.find((a) => a.id !== id && a.context === ctxOf(id) && keysOf(a.id, diff).some((c) => sameChord(c, chord)))

/** `id` bound to exactly `chord`; an action that held it in the same context loses that key only. */
export function bindChord(diff: KeymapDiff, id: string, chord: KeyChord): KeymapDiff {
  return keymapDiff(Object.fromEntries(ACTIONS.map((a) => [a.id,
    a.id === id ? [chord]
      : a.context === ctxOf(id) ? keysOf(a.id, diff).filter((c) => !sameChord(c, chord))
        : keysOf(a.id, diff)])))
}

const NAMES: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Escape: 'Esc',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', PageUp: 'PgUp', PageDown: 'PgDn'
}
/** «Ctrl+Shift+Z», «Shift+←» — `space` is the Space key's name in the UI language */
export function chordLabel(c: KeyChord, space = 'Space'): string {
  const key = c.code === 'Space' ? space
    : NAMES[c.code] ?? c.code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ')
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Meta', key].filter(Boolean).join('+')
}

interface TargetLike { tagName?: string; isContentEditable?: boolean; closest?(sel: string): unknown }
/**
 * Whether the focused element keeps the keys to itself: a text field, a
 * contenteditable, or the Claude terminal (xterm types every key into the pty).
 */
export function ownsKeys(t: TargetLike | null | undefined): boolean {
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable || !!t.closest?.('.xterm')
}

// ------------------------------------------------------------------ the command palette

export interface PaletteItem { id: string; /** [current language, the other one] */ labels: string[] }
export interface PaletteHit {
  id: string
  /** 0 = a word of the label starts with the query, 1 = somewhere inside a word */
  rank: 0 | 1
  /** which label matched: 0 = the current language, 1 = the other */
  via: number
  /** where in that label, for the bold letters */
  at: number
  len: number
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
const WORD = /[\p{L}\p{N}]/u

/** [rank, at] of the best place `q` sits in `label`, or null */
function place(label: string, q: string): [0 | 1, number] | null {
  const l = fold(label)
  let first = -1
  for (let i = l.indexOf(q); i >= 0; i = l.indexOf(q, i + 1)) {
    if (i === 0 || !WORD.test(l[i - 1])) return [0, i]
    if (first < 0) first = i
  }
  return first < 0 ? null : [1, first]
}

/**
 * The palette's search: an action matches when either language's label
 * contains the query (an English word finds a Russian label). Word-prefix
 * matches come first, then substrings; the current language wins a tie
 * between labels; the given order (the registry's) breaks ties between
 * actions. An empty query returns every item in order.
 */
export function paletteMatch(items: PaletteItem[], query: string): PaletteHit[] {
  const q = fold(query.trim())
  const hits: PaletteHit[] = []
  for (const it of items) {
    if (!q) { hits.push({ id: it.id, rank: 0, via: 0, at: 0, len: 0 }); continue }
    let best: PaletteHit | null = null
    it.labels.forEach((label, via) => {
      const p = place(label, q)
      if (p && (!best || p[0] < best.rank)) best = { id: it.id, rank: p[0], via, at: p[1], len: q.length }
    })
    if (best) hits.push(best)
  }
  // Array.prototype.sort is stable: equal ranks keep the registry's order
  return hits.sort((a, b) => a.rank - b.rank)
}
