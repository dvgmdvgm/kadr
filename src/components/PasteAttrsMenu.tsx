import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useEditor, ATTR_PARTS, type AttrPart } from '@/state/store'
import { useT, type TKey } from '@/i18n'
import { CtxMenu } from './CtxMenu'
import { Icon } from './icons'

const LABELS: Record<AttrPart, TKey> = {
  transform: 'attrTransform', effects: 'attrEffects', volume: 'attrVolume', speed: 'attrSpeed', masks: 'attrMasks', colour: 'attrColour'
}

/** Ctrl+Alt+V: which parts of the copied clip go onto the selection. */
export const usePasteAttrsUi = create<{
  at: { x: number; y: number } | null
  /** under the first selected clip — a key has no pointer position */
  open(): void
  close(): void
}>((set) => ({
  at: null,
  open: () => {
    const id = useEditor.getState().selection[0]
    const r = id ? document.querySelector(`[data-clip="${CSS.escape(id)}"]`)?.getBoundingClientRect() : undefined
    set({ at: r ? { x: r.left + 8, y: r.bottom + 4 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 } })
  },
  close: () => set({ at: null })
}))

export function PasteAttrsMenu() {
  const t = useT()
  const at = usePasteAttrsUi((s) => s.at)
  const close = usePasteAttrsUi((s) => s.close)
  // everything ticked, as Premiere opens it; the choice lasts the session
  const [on, setOn] = useState<AttrPart[]>(ATTR_PARTS)
  useEffect(() => {
    if (!at) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [at, close])
  if (!at) return null
  return (
    <CtxMenu x={at.x} y={at.y}>
      <div className="ctx-title dim">{t('pasteAttrsTitle')}</div>
      {ATTR_PARTS.map((k) => (
        <button key={k} data-act={`attr-${k}`} role="menuitemcheckbox" aria-checked={on.includes(k)}
                onClick={() => setOn(on.includes(k) ? on.filter((x) => x !== k) : ATTR_PARTS.filter((x) => x === k || on.includes(x)))}>
          <span className="ctx-check">{on.includes(k) && <Icon name="check" size={13} />}</span>
          {t(LABELS[k])}
        </button>
      ))}
      <button data-act="paste-attrs" disabled={!on.length}
              onClick={() => { useEditor.getState().pasteAttributes(on); close() }}>
        {t('pasteAttrsApply')}
      </button>
    </CtxMenu>
  )
}
