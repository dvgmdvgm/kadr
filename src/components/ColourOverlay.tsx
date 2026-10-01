// J6: what the colour section puts over the preview — the «До и после»
// divider (the GL draws both halves, src/engine/player.ts; this is only the
// line, its knob and the two labels) and the key's pipette, which takes one
// click on the picture. Both follow the canvas's displayed rect, in whichever
// window the preview is (it may be popped out — see OnionSkin).
import { useEffect, useState } from 'react'
import { useEditor } from '@/state/store'
import { usePopout } from '@/engine/popout'
import { useColourUi, compareProject } from '@/engine/colourUi'
import { colourGesture, setKeyColour } from '@/engine/colourEdit'
import { useT } from '@/i18n'
import { Icon } from './icons'

type Rect = { left: number; top: number; w: number; h: number }
const hex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

export function ColourOverlay({ canvas, sample }: {
  canvas: React.RefObject<HTMLCanvasElement>
  sample: (clipId: string, fx: number, fy: number) => [number, number, number] | null
}) {
  const t = useT()
  const compare = useColourUi((s) => s.compare)
  const split = useColourUi((s) => s.split)
  const picking = useColourUi((s) => s.picking)
  // the divider shows only when the preview really draws a «before» half
  const shown = useEditor((s) => compare && !!compareProject(s.project)) && compare
  const popped = usePopout((s) => s.win)
  const [rect, setRect] = useState<Rect | null>(null)
  const on = shown || !!picking

  useEffect(() => {
    const el = canvas.current
    if (!el || !on) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement!.getBoundingClientRect()
      setRect({ left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height })
    }
    measure()
    const win = el.ownerDocument.defaultView ?? window
    const ro = new win.ResizeObserver(measure)
    ro.observe(el)
    ro.observe(el.parentElement!)
    return () => ro.disconnect()
  }, [canvas, on, popped])

  // Esc leaves the pipette, in the preview's own window too
  useEffect(() => {
    if (!picking) return
    const win = canvas.current?.ownerDocument.defaultView ?? window
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      useColourUi.setState({ picking: null })
    }
    win.addEventListener('keydown', esc, true)
    if (win !== window) window.addEventListener('keydown', esc, true)
    return () => { win.removeEventListener('keydown', esc, true); window.removeEventListener('keydown', esc, true) }
  }, [picking, canvas, popped])

  if (!on || !rect) return null
  const box = { left: rect.left, top: rect.top, width: rect.w, height: rect.h }

  if (picking) {
    return (
      <div className="ba-wrap" data-act="cg-pick-surface" style={{ ...box, cursor: 'crosshair', pointerEvents: 'auto' }}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          const rgb = sample(picking, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
          if (rgb) { colourGesture(); setKeyColour(picking, hex(rgb)) }
          useColourUi.setState({ picking: null })
        }} />
    )
  }

  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const win = e.currentTarget.ownerDocument.defaultView ?? window
    const move = (ev: PointerEvent) => {
      const c = canvas.current?.getBoundingClientRect()
      if (c) useColourUi.setState({ split: Math.min(1, Math.max(0, (ev.clientX - c.left) / c.width)) })
    }
    const up = () => { win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up) }
    win.addEventListener('pointermove', move)
    win.addEventListener('pointerup', up)
  }
  return (
    <div className="ba-wrap" data-act="ba-wrap" style={box}>
      <span className="ba-label" style={{ left: 'var(--s4)' }}>{t('baBefore')}</span>
      <span className="ba-label" style={{ right: 'var(--s4)' }}>{t('baAfter')}</span>
      <div className="ba-split" style={{ left: `${split * 100}%` }} />
      <button className="ba-knob" data-act="ba-knob" style={{ left: `${split * 100}%` }}
        title={t('baKnob')} aria-label={t('baKnob')} onPointerDown={drag}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0
          if (!d) return
          e.preventDefault()
          useColourUi.setState({ split: Math.min(1, Math.max(0, split + d)) })
        }}>
        <Icon name="compare" size={13} />
      </button>
    </div>
  )
}
