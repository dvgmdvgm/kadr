// The action registry: what each action in shared/keymap.ts does, the user's
// keymap (`userData/keymap.json`, the diff from the defaults) and the one
// keydown handler App.tsx installs. Every hotkey used to be a branch of one
// if/else in App.tsx that ignored modifiers (Ctrl+D deleted clips).
import { create } from 'zustand'
import { useEditor, useSettings, projectDuration, setting, timelineView } from '../state/store'
import {
  ACTIONS, actionFor, keymapDiff, keysOf, ownsKeys, sanitizeKeymap,
  type ActionId, type KeyChord, type KeymapDiff
} from '@shared/keymap'
import { importFiles } from './mediaImport'
import { snapshotFrame } from './snapshot'
import { togglePreviewWindow } from './popout'
import { useBeatsUi } from './beats'
import { useChecksUi } from './checks'
import { useSoundsUi } from '../components/SoundsDialog'
import { useCaptionsUi } from '../components/CaptionsDialog'
import { useTextUi } from '../components/TextTools'
import { useSettingsUi } from '../components/SettingsDialog'
import { startCollect } from '../components/CollectDialog'
import { usePasteAttrsUi } from '../components/PasteAttrsMenu'
import { modalsOpen } from '../components/Modal'
import { logError, logWarn } from './log'
import { saveUserStore } from './userStore'
import { tr, type TKey } from '../i18n'

type EditorState = ReturnType<typeof useEditor.getState>

// every label is a real i18n key
const _labels: readonly { labelKey: TKey }[] = ACTIONS
void _labels

/** project-file commands live in App.tsx (they drive its save UI); it fills these in */
export const appCommands = {
  /** true once the project is on disk */
  save: async (): Promise<boolean> => false,
  saveAs: () => {},
  newProject: () => {},
  openProject: () => {},
  /** a .kadr from the recent list, behind the unsaved-work question */
  openRecent: (_path: string) => {}
}

interface Handler {
  run(s: EditorState): void
  enabled?(s: EditorState): boolean
  /** why it is off, said by the command palette under the label */
  why?: TKey
}
const hasSel = (s: EditorState) => s.selection.length > 0 || !!s.range
const hasClips = (s: EditorState) => s.selection.length > 0
/** the stop key (K) is down — see onEditorKey */
let stopHeld = false

const HANDLERS: Record<ActionId, Handler> = {
  'transport.play': { run: (s) => s.setPlaying(!s.playing) },
  // J/L with K held step a frame (the Avid/Premiere habit); alone they shuttle
  'transport.forward': { run: (s) => { if (stopHeld) s.setPlayhead(s.playhead + 1 / s.project.fps); else s.shuttle(1) } },
  'transport.reverse': { run: (s) => { if (stopHeld) s.setPlayhead(s.playhead - 1 / s.project.fps); else s.shuttle(-1) } },
  'transport.stop': { run: (s) => s.setPlaying(false) },
  'transport.loop': { run: (s) => s.toggleLoop() },
  'edit.snap': { run: () => useSettings.getState().set('editing.snap', !setting<boolean>('editing.snap')) },
  'clip.toggleEnable': { enabled: hasClips, why: 'whyNoSel', run: (s) => s.toggleDisabled() },
  // the name lives in the Inspector (it shows the first selected clip)
  'clip.rename': {
    enabled: hasClips, why: 'whyNoSel',
    run: () => {
      const el = document.querySelector<HTMLInputElement>('[data-act="clip-name"]')
      el?.focus()
      el?.select()
    }
  },
  'transport.playInOut': { run: (s) => s.playInOut() },
  'edit.split': { run: (s) => s.splitAtPlayhead() },
  'file.save': { run: () => appCommands.save() },
  'file.saveAs': { run: () => appCommands.saveAs() },
  'file.collect': { run: () => void startCollect() },
  'edit.delete': {
    enabled: hasSel, why: 'whyNoSel',
    run: (s) => { if (s.selection.length) s.deleteSelection(); else if (s.range) s.deleteRange() }
  },
  'edit.rippleDelete': {
    enabled: hasSel, why: 'whyNoSel',
    run: (s) => { if (s.selection.length) s.rippleDelete(); else if (s.range) s.extractRange() }
  },
  'edit.closeGaps': {
    // the selection's tracks, or every track
    run: (s) => s.closeGaps(s.selection.length
      ? s.project.tracks.filter((t) => t.clips.some((c) => s.selection.includes(c.id))).map((t) => t.id)
      : 'all')
  },
  'edit.undo': { enabled: (s) => s.past.length > 0, why: 'whyNoUndo', run: (s) => s.undo() },
  'edit.redo': { enabled: (s) => s.future.length > 0, why: 'whyNoRedo', run: (s) => s.redo() },
  'edit.cut': { enabled: hasSel, why: 'whyNoSel', run: (s) => s.cut() },
  'edit.copy': {
    enabled: hasSel, why: 'whyNoSel',
    run: (s) => { if (s.selection.length) s.copySelection(); else if (s.range) s.copyRange() }
  },
  'edit.paste': {
    run: (s) => {
      if (s.clipboard.length) { s.pasteAtPlayhead(); return }
      // nothing copied inside the editor — try the OS clipboard:
      // copied files or a copied image (e.g. from Telegram/browser)
      void window.kadr.clipboardMedia().then((paths) => {
        if (paths.length) return importFiles(paths, { trackId: null, at: useEditor.getState().playhead })
      }).catch((err) => logError(tr('lgClipboard'), tr('lmPasteFail'), err))
    }
  },
  'edit.pasteInsert': {
    enabled: (s) => s.clipboard.length > 0, why: 'whyNoClipboard', run: (s) => s.pasteAtPlayhead(true)
  },
  'edit.pasteAttributes': {
    enabled: (s) => s.clipboard.length > 0 && s.selection.length > 0,
    why: 'whyPasteAttrs',
    run: () => usePasteAttrsUi.getState().open()
  },
  'clip.duplicate': { enabled: hasClips, why: 'whyNoSel', run: (s) => s.duplicateSelection() },
  'clip.freeze': { run: (s) => s.freezeFrame() },
  'edit.trimStart': { run: (s) => s.trimToPlayhead('in') },
  'edit.trimEnd': { run: (s) => s.trimToPlayhead('out') },
  'edit.link': { enabled: (s) => s.selection.length > 0, why: 'whyNoClips', run: (s) => s.toggleLinkSelection() },
  'view.zoomFit': { run: (s) => timelineView.fit?.(0, projectDuration(s.project)) },
  'view.zoomSel': {
    enabled: hasSel, why: 'whyNoSel',
    run: (s) => {
      const sel = s.project.tracks.flatMap((t) => t.clips).filter((c) => s.selection.includes(c.id))
      if (sel.length) timelineView.fit?.(Math.min(...sel.map((c) => c.start)), Math.max(...sel.map((c) => c.start + c.duration)))
      else if (s.range) timelineView.fit?.(s.range.start, s.range.end)
    }
  },
  'view.zoomIn': { run: () => timelineView.zoomBy?.(1.5) },
  'view.zoomOut': { run: () => timelineView.zoomBy?.(1 / 1.5) },
  'marker.add': { run: (s) => s.addMarker(s.playhead) },
  'playhead.prevFrame': { run: (s) => s.setPlayhead(s.playhead - 1 / s.project.fps) },
  'playhead.nextFrame': { run: (s) => s.setPlayhead(s.playhead + 1 / s.project.fps) },
  'playhead.back1s': { run: (s) => s.setPlayhead(s.playhead - 1) },
  'playhead.fwd1s': { run: (s) => s.setPlayhead(s.playhead + 1) },
  'playhead.start': { run: (s) => s.setPlayhead(0) },
  'playhead.end': { run: (s) => s.setPlayhead(projectDuration(s.project)) },
  'playhead.prevEdit': { run: (s) => s.goToEdit(-1) },
  'playhead.nextEdit': { run: (s) => s.goToEdit(1) },
  'range.in': { run: (s) => s.markIn() },
  'range.out': { run: (s) => s.markOut() },
  'range.clip': { run: (s) => s.markClip() },
  'edit.selectAll': { run: (s) => s.selectAll() },
  'edit.deselect': { run: (s) => s.select([]) },
  'edit.escape': { run: (s) => { if (s.animClipId) s.setAnimClip(null); else s.setRange(null) } },
  'app.settings': { run: () => useSettingsUi.getState().setOpen(true) },
  'app.palette': { run: () => usePaletteUi.setState({ open: true }) },
  'file.new': { run: () => appCommands.newProject() },
  'file.open': { run: () => appCommands.openProject() },
  'file.export': { run: (s) => s.setExportOpen(true) },
  'tools.transcribe': {
    enabled: (s) => !!s.range, why: 'whyNoRange',
    run: (s) => { if (s.range) useTextUi.getState().openTranscribe({ kind: 'range', start: s.range.start, end: s.range.end }) }
  },
  'tools.captions': { run: () => useCaptionsUi.getState().setOpen(true) },
  'tools.beats': { run: () => useBeatsUi.getState().setOpen(true) },
  'tools.sounds': { run: () => useSoundsUi.getState().setOpen(true) },
  'tools.checks': { run: () => useChecksUi.getState().setOpen(true) },
  'preview.snapshot': {
    run: () => void snapshotFrame({ interactive: true }).catch((err) => {
      if (!String(err).includes('cancelled')) logWarn(tr('lgSnapshot'), tr('lmSnapFail'), err)
    })
  },
  'preview.popout': { run: () => void togglePreviewWindow() }
}

/** null when the action can run now, else why not (an i18n key; '' when it has no reason text) */
export function whyOff(id: ActionId): TKey | '' | null {
  const h = HANDLERS[id]
  return h.enabled?.(useEditor.getState()) ?? true ? null : h.why ?? ''
}

export function runAction(id: ActionId) {
  const s = useEditor.getState()
  if (HANDLERS[id].enabled?.(s) ?? true) HANDLERS[id].run(s)
}

/** the command palette's open flag (src/components/CommandPalette.tsx) */
export const usePaletteUi = create<{ open: boolean }>(() => ({ open: false }))

// ------------------------------------------------------------------ keymap

const KEYMAP_FILE = 'keymap'
export const useKeymap = create<{ diff: KeymapDiff }>(() => ({ diff: {} }))

/** read `userData/keymap.json` once at boot; until then the defaults apply */
export async function loadKeymap() {
  try { useKeymap.setState({ diff: sanitizeKeymap(await window.kadr.readUserStore(KEYMAP_FILE)) }) } catch { /* defaults */ }
}

/** Rebind an action (`null` = back to its default keys); the file keeps the diff only. */
export function setActionKeys(id: ActionId, keys: KeyChord[] | null) {
  const diff = useKeymap.getState().diff
  // a key set back to its defaults leaves the file
  setKeymap(keymapDiff(Object.fromEntries(ACTIONS.map((a) =>
    [a.id, a.id === id ? keys ?? a.defaultKeys : keysOf(a.id, diff)]))))
}

/** Replace the whole keymap (the shortcut editor, an imported file; `{}` = every default). */
export function setKeymap(diff: KeymapDiff) {
  useKeymap.setState({ diff })
  void saveUserStore(KEYMAP_FILE, diff)
}

// ------------------------------------------------------------------ keydown

/** The editor's global keydown handler (the main window and the popped-out preview). */
export function onEditorKey(e: KeyboardEvent) {
  // a widget that handled the key itself (the speed jog's arrows) keeps it
  if (e.defaultPrevented) return
  // text fields and the Claude terminal own their keys
  if (ownsKeys(e.target as Element | null)) return
  // a dialog owns the keyboard while it is open: Space on one of its
  // buttons used to press the button AND start playback behind it
  if (modalsOpen()) return
  const a = actionFor(e, useKeymap.getState().diff)
  if (!a) return
  if ('prevent' in a && a.prevent) e.preventDefault()
  const shuttle = a.id === 'transport.forward' || a.id === 'transport.reverse'
  // an auto-repeating L/J would race to 8×; with K held the repeat walks frames
  if (e.repeat && (a.id === 'transport.stop' || (shuttle && !stopHeld))) return
  if (a.id === 'transport.stop') {
    // held until its own key comes up, or the window loses focus with it down
    stopHeld = true
    const win = e.currentTarget as Window | null
    const code = e.code
    const off = (ev: Event) => {
      if (ev.type === 'keyup' && (ev as KeyboardEvent).code !== code) return
      stopHeld = false
      win?.removeEventListener('keyup', off)
      win?.removeEventListener('blur', off)
    }
    win?.addEventListener('keyup', off)
    win?.addEventListener('blur', off)
  }
  runAction(a.id)
}
