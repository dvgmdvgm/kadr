// The compact meter beside the preview (K6, canvas K RULES 19–21): the
// output's L and R sample peaks after the limiter with a hold line, the
// momentary loudness (K3) under them, and an over LED that lights when a
// sample reached 0 dBFS (only possible with the preview limiter off) and holds
// until clicked. A click anywhere else opens the mixer.
import { useEffect, useRef, useState } from 'react'
import { masterPeaks, loudness } from '@/engine/audio'
import { useT } from '@/i18n'
import { usePopout } from '@/engine/popout'
import { useMixerUi } from '@/engine/mixer'
import { lufsText } from '@shared/fader'
import { MeterBars, newMeter, stepMeter, type MeterEls } from './Mixer'

export function AudioMeter() {
  const t = useT()
  // the preview (this meter with it) may be detached into its own window
  const popped = usePopout((s) => s.win)
  const rootRef = useRef<HTMLDivElement>(null)
  const numRef = useRef<HTMLSpanElement>(null)
  const els = useRef<MeterEls | null>(null)
  const [over, setOver] = useState(false)
  const overRef = useRef(false)
  overRef.current = over

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const m = newMeter()
    let raf = 0
    let lastNum = 0
    // like the Player's clock, the loop runs in whatever window the meter
    // currently sits in: detached (engine/popout.ts) it would otherwise freeze
    // whenever the editor window is minimised
    const view = () => root.ownerDocument.defaultView ?? window
    const draw = (now: number) => {
      raf = view().requestAnimationFrame(draw)
      const p = masterPeaks()
      stepMeter(m, p, now, els.current ?? undefined)
      if (!overRef.current && (p[0] >= 1 || p[1] >= 1)) setOver(true)
      if (now - lastNum > 100 && numRef.current) {
        lastNum = now
        numRef.current.textContent = lufsText(loudness().momentary)
      }
    }
    raf = view().requestAnimationFrame(draw)
    return () => { try { view().cancelAnimationFrame(raf) } catch { /* window gone */ } }
  }, [popped])

  const open = () => useMixerUi.getState().setOpen(true)
  return (
    <div
      ref={rootRef} className="cm-meter" role="button" tabIndex={0} data-act="meter"
      title={t('cmTitle')} aria-label={t('mxToggle')}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open() } }}
    >
      <span
        className={`cm-led${over ? ' on' : ''}`} data-over={over ? '1' : '0'} role="button" aria-label={over ? t('cmOver') : t('cmNoOver')}
        title={over ? t('cmOver') : t('cmNoOver')}
        onClick={(e) => { if (over) { e.stopPropagation(); setOver(false) } }}
      />
      <MeterBars className="cm-bars" onEls={(e) => { els.current = e }} />
      <span className="cm-num" ref={numRef}>{lufsText(loudness().momentary)}</span>
    </div>
  )
}
