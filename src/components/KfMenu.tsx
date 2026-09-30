// Right-click on a keyframe diamond (Animation and Track Motion editors):
// delete, then the five easings with the current one checked. It acts on
// every selected diamond when the clicked one is selected.
import { useEffect, useRef } from 'react'
import type { Easing } from '@shared/types'
import { useT, type TKey } from '@/i18n'
import { CtxMenu } from './CtxMenu'
import { Icon } from './icons'

export const EASE_LABEL: Record<Easing, TKey> = {
  linear: 'easeLinear',
  easeIn: 'easeIn',
  easeOut: 'easeOut',
  easeInOut: 'easeInOut',
  hold: 'easeHold'
}
const EASINGS = Object.keys(EASE_LABEL) as Easing[]

export function KfMenu({ x, y, count, current, onDelete, onEasing, onClose }: {
  x: number
  y: number
  /** how many diamonds it acts on */
  count: number
  current: Easing | undefined
  onDelete(): void
  onEasing(e: Easing): void
  onClose(): void
}) {
  const t = useT()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const out = () => close.current()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current() } }
    window.addEventListener('pointerdown', out)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  return (
    <CtxMenu x={x} y={y}>
      <button className="danger" data-act="kf-delete" onClick={() => { onDelete(); onClose() }}>
        {count > 1 ? `${t('kfDeleteSel')} (${count})` : t('kfDeleteThis')}
      </button>
      <div className="ctx-title">{t('kfEasing')}</div>
      {EASINGS.map((e) => (
        <button key={e} data-act={`ease-${e}`} role="menuitemradio" aria-checked={current === e}
                onClick={() => { onEasing(e); onClose() }}>
          <span className="ctx-check">{current === e && <Icon name="check" size={13} />}</span>
          {t(EASE_LABEL[e])}
        </button>
      ))}
    </CtxMenu>
  )
}
