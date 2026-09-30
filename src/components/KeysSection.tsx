// «Настройки › Клавиши»: every action of the registry (shared/keymap.ts) with
// its keys, landed from canvas D (RULES 16–21). Clicking the keys captures a
// new chord; a chord another action holds asks inline (replace / cancel) — a
// second modal is not allowed over this one. The file holds only the diff from
// the defaults (userData/keymap.json), so «ваше» is exactly «in the diff».
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { useT, tr, type TKey } from '@/i18n'
import { useKeymap, setKeymap, setActionKeys } from '@/engine/actions'
import { logWarn } from '@/engine/log'
import {
  ACTIONS, bindChord, capturedChord, chordLabel, holderOf, keysOf, sameChord, sanitizeKeymap,
  type ActionId, type KeyChord
} from '@shared/keymap'

type T = (k: TKey) => string
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

const GROUPS: [RegExp, TKey][] = [
  [/^(transport|playhead)\./, 'keysGrpPlay'], [/^(edit|marker)\./, 'keysGrpEdit'],
  [/^(file|app)\./, 'keysGrpFile'], [/^tools\./, 'keysGrpTools'], [/^preview\./, 'keysGrpPreview']
]
const groupOf = (id: string) => GROUPS.findIndex(([re]) => re.test(id))

/** the head's buttons: import, export, reset all (they sit in the section head) */
export function KeysHeadActions() {
  const t = useT()
  const diff = useKeymap((s) => s.diff)
  const [note, setNote] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const onImport = async (f: File | undefined) => {
    if (!f) return
    try {
      const raw = JSON.parse(await f.text())
      const next = sanitizeKeymap(raw)
      const kept = Object.keys(next).length
      const skipped = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).length - kept : 0
      setKeymap(next)
      setNote(fill(t('keysImported'), { n: kept }) + (skipped ? fill(t('keysSkipped'), { n: skipped }) : ''))
    } catch (err) {
      setNote(t('keysBadFile'))
      logWarn(tr('lgKeys'), tr('lmKeysRead'), err)
    }
  }
  const onExport = async () => {
    const path = await window.kadr.exportDialog('keymap', 'json')
    if (!path) return
    try { await window.kadr.writeTextFile(path, JSON.stringify(diff, null, 2) + '\n') } catch (err) { logWarn(tr('lgKeys'), tr('lmKeysWrite'), err) }
  }
  return (
    <>
      {note && <span className="keys-note" role="status">{note}</span>}
      <button className="ghost" data-act="keys-import" onClick={() => file.current?.click()}>{t('keysImport')}</button>
      <input ref={file} type="file" accept=".json,application/json" hidden
             onChange={(e) => { void onImport(e.target.files?.[0]); e.target.value = '' }} />
      <button className="ghost" data-act="keys-export" onClick={() => void onExport()}>{t('keysExport')}</button>
      <button className="ghost" data-act="keys-reset-all" disabled={!Object.keys(diff).length}
              onClick={() => { setKeymap({}); setNote('') }}>
        {t('keysResetAll')}
      </button>
    </>
  )
}

function Chips({ keys, t }: { keys: KeyChord[]; t: T }) {
  return <>{keys.map((c, i) => <kbd key={i} className="keycap">{chordLabel(c, t('keysSpace'))}</kbd>)}</>
}

export function KeysSection({ t }: { t: T }) {
  const diff = useKeymap((s) => s.diff)
  const [q, setQ] = useState('')
  const [capturing, setCapturing] = useState<ActionId | null>(null)
  const [pending, setPending] = useState<{ id: ActionId; chord: KeyChord } | null>(null)
  const label = (id: string) => t(ACTIONS.find((a) => a.id === id)!.labelKey as TKey)
  const keyText = (keys: KeyChord[]) => keys.map((c) => chordLabel(c, t('keysSpace'))).join(', ')

  const needle = q.trim().toLowerCase()
  const shown = ACTIONS.filter((a) => !needle ||
    t(a.labelKey as TKey).toLowerCase().includes(needle) || keyText(keysOf(a.id, diff)).toLowerCase().includes(needle))

  // While capturing, every key belongs to the capture, wherever focus is: Alt
  // would open the window menu, Enter/Space would press a button, Escape would
  // close the dialog (RULES 19, the card's risk). Window, capture phase — ahead
  // of the Modal's Escape and the editor's own handler.
  useEffect(() => {
    if (!capturing) return
    const own = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation() }
    const down = (e: KeyboardEvent) => {
      own(e)
      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) { setCapturing(null); return }
      const chord = capturedChord(e)
      if (!chord) return // a lone modifier: still on the way to the chord
      setCapturing(null)
      const d = useKeymap.getState().diff
      if (holderOf(d, capturing, chord)) setPending({ id: capturing, chord })
      else setKeymap(bindChord(d, capturing, chord))
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', own, true)
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', own, true) }
  }, [capturing])

  const row = (a: (typeof ACTIONS)[number]) => {
    const keys = keysOf(a.id, diff)
    const mine = a.id in diff
    const lbl = t(a.labelKey as TKey)
    const conflict = pending?.id === a.id ? pending : null
    const holder = conflict && holderOf(diff, a.id, conflict.chord)
    const rest = holder ? keysOf(holder.id, diff).filter((c) => !sameChord(c, conflict.chord)) : []
    const resetTo = fill(t('keysResetTo'), { keys: a.defaultKeys.length ? keyText([...a.defaultKeys]) : t('keysNone') })
    return (
      <div key={a.id}>
        <div className={`key-row${conflict ? ' conflict' : ''}`} data-action={a.id}>
          <span className="key-label">{lbl}</span>
          {mine && <span className="set-badge set-badge-user">{t('setSrcUser')}</span>}
          {capturing === a.id
            ? <span className="key-capture" role="status" aria-live="polite">{t('keysPress')}</span>
            : conflict
              ? <span className="key-chord pending"><Chips keys={[conflict.chord]} t={t} /></span>
              : <button className="ghost key-chord" onClick={() => { setPending(null); setCapturing(a.id) }}
                        aria-label={fill(t(keys.length ? 'keysAriaSet' : 'keysAriaNone'), { label: lbl, keys: keyText(keys) })}>
                  {keys.length ? <Chips keys={keys} t={t} /> : <span className="key-none">{t('keysAssign')}</span>}
                </button>}
          {mine && !conflict
            ? <button className="ghost icon-only set-reset" title={resetTo} aria-label={resetTo}
                      onClick={() => setActionKeys(a.id, null)}>
                <Icon name="reload" size={14} />
              </button>
            : <span className="set-slot" />}
        </div>
        {conflict && holder && (
          <div className="key-conflict" role="alert">
            <Icon name="alert" size={14} />
            <span>{fill(t(rest.length ? 'keysConflictRest' : 'keysConflict'), {
              key: chordLabel(conflict.chord, t('keysSpace')), action: label(holder.id), rest: keyText(rest)
            })}</span>
            <button data-act="keys-cancel" onClick={() => setPending(null)}>{t('cancel')}</button>
            <button data-act="keys-replace" onClick={() => { setKeymap(bindChord(diff, a.id, conflict.chord)); setPending(null) }}>
              {t('keysReplace')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <label className="keys-search">
        <Icon name="search" size={16} />
        <input type="search" value={q} placeholder={t('keysSearch')} aria-label={t('keysSearch')}
               onChange={(e) => setQ(e.target.value)} />
      </label>
      {GROUPS.map(([, key], g) => {
        const rows = shown.filter((a) => groupOf(a.id) === g)
        return rows.length > 0 && (
          <div key={key}>
            <div className="insp-section keys-group">{t(key)}</div>
            {rows.map(row)}
          </div>
        )
      })}
      {needle && <p className="dim">{fill(t('keysFound'), { n: shown.length, total: ACTIONS.length })}</p>}
    </>
  )
}
