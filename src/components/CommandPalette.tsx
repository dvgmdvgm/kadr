// The command palette (Ctrl+K, the `app.palette` action), landed from canvas D
// (RULES 22–30): every action of the registry found by its label in EITHER
// language (`paletteMatch`), Enter runs it. Not a Modal — no head, no footer
// actions — but it owns the keyboard like one (`useCountsAsModal`), so the
// editor's keys stay quiet while it is open. A disabled action stays listed,
// with its reason; Enter on it does nothing.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { useCountsAsModal } from './Modal'
import { useT, trIn, type TKey } from '@/i18n'
import { useSettings } from '@/state/store'
import { runAction, useKeymap, usePaletteUi, whyOff } from '@/engine/actions'
import { ACTIONS, chordLabel, keysOf, paletteMatch, type ActionId } from '@shared/keymap'

const ICONS: Partial<Record<ActionId, IconName>> = {
  'transport.play': 'play', 'edit.split': 'split', 'file.save': 'save', 'edit.delete': 'trash',
  'edit.undo': 'undo', 'edit.redo': 'redo', 'edit.link': 'link', 'playhead.start': 'toStart',
  'app.settings': 'settings', 'file.new': 'filePlus', 'file.open': 'folderOpen', 'file.export': 'download',
  'tools.transcribe': 'speech', 'tools.captions': 'captions', 'tools.beats': 'beat', 'tools.sounds': 'sfx',
  'tools.checks': 'check', 'preview.snapshot': 'camera', 'preview.popout': 'popout'
}

/** `text` with `len` letters from `at` in bold */
const marked = (text: string, at: number, len: number): ReactNode =>
  len ? <>{text.slice(0, at)}<b>{text.slice(at, at + len)}</b>{text.slice(at + len)}</> : text

export function CommandPalette() {
  const open = usePaletteUi((s) => s.open)
  return open ? <Palette close={() => usePaletteUi.setState({ open: false })} /> : null
}

function Palette({ close }: { close: () => void }) {
  useCountsAsModal()
  const t = useT()
  const lang = useSettings((s) => s.lang)
  const diff = useKeymap((s) => s.diff)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => restoreTo?.focus?.()
  }, [])

  const other = lang === 'ru' ? 'en' : 'ru'
  const hits = paletteMatch(
    ACTIONS.filter((a) => a.id !== 'app.palette')
      .map((a) => ({ id: a.id, labels: [trIn(lang, a.labelKey as TKey), trIn(other, a.labelKey as TKey)] })),
    q)
  const cur = Math.min(sel, Math.max(0, hits.length - 1))
  useEffect(() => { document.getElementById(`pal-${cur}`)?.scrollIntoView({ block: 'nearest' }) }, [cur])

  const run = (id: ActionId) => {
    if (whyOff(id) !== null) return
    close()
    runAction(id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = hits.length
    if (e.key === 'Escape') { e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown' && n) { e.preventDefault(); setSel((cur + 1) % n) }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setSel((cur - 1 + n) % n) }
    else if (e.key === 'Enter' && n) { e.preventDefault(); run(hits[cur].id as ActionId) }
    else if (e.key === 'Tab') e.preventDefault() // the input is the palette's one stop
  }

  const space = t('keysSpace')
  return (
    <div className="palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('palLabel')} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={input}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="pal-list"
            aria-activedescendant={hits.length ? `pal-${cur}` : undefined}
            placeholder={t('palHint')}
            aria-label={t('palHint')}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0) }}
          />
        </div>
        {hits.length ? (
          <div id="pal-list" className="palette-list" role="listbox" aria-label={t('palLabel')}>
            {hits.map((h, i) => {
              const a = ACTIONS.find((x) => x.id === h.id)!
              const id = a.id as ActionId
              const why = whyOff(id)
              const label = trIn(lang, a.labelKey as TKey)
              const icon = ICONS[id]
              return (
                <div
                  key={id}
                  id={`pal-${i}`}
                  className={`palette-row${i === cur ? ' active' : ''}`}
                  role="option"
                  aria-selected={i === cur}
                  aria-disabled={why !== null || undefined}
                  onMouseMove={() => { if (i !== cur) setSel(i) }}
                  onClick={() => run(id)}
                >
                  {icon ? <Icon name={icon} size={16} /> : <span aria-hidden="true" />}
                  <span className="palette-label">
                    <span>{h.via === 0 ? marked(label, h.at, h.len) : label}</span>
                    {why && <span className="palette-why">{t(why)}</span>}
                  </span>
                  {h.via === 1 && <span className="palette-alt">{marked(trIn(other, a.labelKey as TKey), h.at, h.len)}</span>}
                  {keysOf(id, diff).map((c) => <kbd key={chordLabel(c)} className="keycap">{chordLabel(c, space)}</kbd>)}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="palette-empty" role="status">
            <span>{t('palNone').replace('{q}', q.trim())}</span>
            <button className="ghost" onClick={() => { setQ(''); input.current?.focus() }}>{t('palAll')}</button>
          </div>
        )}
        <div className="palette-foot">
          {hits.length > 0 && <><span>{t('palPick')}</span><span>{t('palRun')}</span></>}
          <span>{t('palClose')}</span>
        </div>
      </div>
    </div>
  )
}
