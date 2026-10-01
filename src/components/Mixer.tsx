// K6: the mixer (canvas K) — docked right of the timeline's lanes, under its
// toolbar. One strip per AUDIO track (pan, mute, solo, fader, peak meter) and
// the master (its fader, the K3 loudness readouts, the limiter, the output
// device). Every control writes through src/engine/mixer.ts, the same path as
// the track header, so the two can never disagree.
import { useEffect, useRef, useState } from 'react'
import type { Track } from '@shared/types'
import { useEditor, useSettings, setting } from '@/state/store'
import { useT, trf, type TKey } from '@/i18n'
import { Icon } from './icons'
import { faderPos, posDb, dbToGain, gainToDb, dbText, lufsText, panText } from '@shared/fader'
import {
  beginMixGesture, setTrackGain, setMaster, toggleTrack, setTrackPan, trackPanAt, useMixerUi
} from '@/engine/mixer'
import { trackPeaks, masterPeaks, loudness, resetLoudness, limiterInfo } from '@/engine/audio'
import { trackHeard } from '@/engine/player'
import { useRecord, toggleArm, setInput, inputPeaks, isArmed, useAudioInputs } from '@/engine/record'
import { FX_NAME, FxBlock, FxAddMenu, addFx, removeFx, toggleFx } from './AudioFxPanel'
import { CtxMenu } from './CtxMenu'
import type { AudioFxType } from '@shared/audioFx'

// ---- the peak meter: −60…0 dBFS linear in dB, a hold line for 2 s, then it falls
const FALL_DB_S = 24
const HOLD_MS = 2000
export interface MeterEls { lit: HTMLElement[]; hold: HTMLElement[] }
interface MeterState { lvl: [number, number]; hold: [number, number]; holdAt: [number, number]; t: number }
export const newMeter = (): MeterState => ({ lvl: [-90, -90], hold: [-90, -90], holdAt: [0, 0], t: 0 })
const top = (db: number) => Math.max(0, Math.min(100, -db / 60 * 100))

/** one frame of ballistics from linear peaks, painted into the meter's two channels */
export function stepMeter(m: MeterState, peaks: [number, number], now: number, els: MeterEls | undefined) {
  const dt = m.t ? Math.min(0.2, (now - m.t) / 1000) : 0
  m.t = now
  for (let c = 0; c < 2; c++) {
    const db = gainToDb(peaks[c])
    m.lvl[c] = Math.max(db, m.lvl[c] - FALL_DB_S * dt)
    if (db >= m.hold[c]) { m.hold[c] = db; m.holdAt[c] = now }
    else if (now - m.holdAt[c] > HOLD_MS) m.hold[c] = Math.max(db, m.hold[c] - FALL_DB_S * dt)
    if (!els) continue
    els.lit[c].style.clipPath = `inset(${top(m.lvl[c]).toFixed(1)}% 0 0 0)`
    els.hold[c].style.top = `${top(m.hold[c]).toFixed(1)}%`
    els.hold[c].style.visibility = m.hold[c] < -60 ? 'hidden' : ''
  }
}

/** two channel bars; `onEls` hands the elements to the loop that paints them */
export function MeterBars({ onEls, className = 'mx-meter' }: { onEls: (e: MeterEls | null) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    onEls({
      lit: Array.from(el.querySelectorAll<HTMLElement>('.mx-lit')),
      hold: Array.from(el.querySelectorAll<HTMLElement>('.mx-hold'))
    })
    return () => onEls(null)
  }, [onEls])
  return (
    <div className={className} ref={ref} aria-hidden="true">
      {[0, 1].map((c) => (
        <div className="mx-ch" key={c}><div className="mx-lit" style={{ clipPath: 'inset(100% 0 0 0)' }} /><div className="mx-hold" /></div>
      ))}
    </div>
  )
}

const SCALE = [0, -6, -12, -18, -30, -48]
function Scale() {
  return (
    <div className="mx-scale" aria-hidden="true">
      {SCALE.map((d) => <span key={d} className="mx-tick" style={{ top: `calc(5px + (100% - 10px) * ${top(d) / 100})` }}>{Math.abs(d)}</span>)}
    </div>
  )
}

// ---- the fader: position by the shared taper, one undo step per gesture
const STEP_DB = 0.5
const FINE_DB = 0.1
function Fader({ gain, label, onSet }: { gain: number; label: string; onSet: (g: number) => void }) {
  useT() // re-render on a language switch: the titles go through trf
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; pos: number } | null>(null)
  const keyRun = useRef(false)
  const db = gainToDb(gain)
  const p = faderPos(db)
  const posOf = (y: number, shift: boolean) => {
    const d = drag.current!
    const h = Math.max(1, ref.current!.clientHeight - 10)
    d.pos = Math.min(1, Math.max(0, d.pos - (y - d.y) / h * (shift ? 0.2 : 1)))
    d.y = y
    return d.pos
  }
  return (
    <div
      ref={ref} className="mx-fader" role="slider" tabIndex={0}
      aria-label={trf('mxFaderLabel', { track: label })} aria-valuetext={`${dbText(db)} dB`}
      aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(p.toFixed(3))}
      title={trf('mxFaderTitle', { track: label, db: dbText(db) })}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        keyRun.current = false
        beginMixGesture()
        drag.current = { y: e.clientY, pos: p }
      }}
      onPointerMove={(e) => { if (drag.current) onSet(dbToGain(posDb(posOf(e.clientY, e.shiftKey)))) }}
      onPointerUp={() => { drag.current = null }}
      onDoubleClick={() => { beginMixGesture(); onSet(1) }}
      onBlur={() => { keyRun.current = false }}
      onKeyDown={(e) => {
        const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
        if (!dir) return
        e.preventDefault()
        e.stopPropagation()
        if (!keyRun.current) { beginMixGesture(); keyRun.current = true }
        onSet(dbToGain(Math.max(-60, db) + dir * (e.shiftKey ? FINE_DB : STEP_DB)))
      }}
    >
      <div className="mx-rail" />
      <div className="mx-unity" style={{ top: `calc(5px + (100% - 10px) * ${1 - faderPos(0)})` }} />
      <div className="mx-cap" style={{ top: `calc(5px + (100% - 10px) * ${1 - p})` }} />
    </div>
  )
}

/** the value under the fader; double-click types a dB value in */
function DbValue({ gain, onSet }: { gain: number; onSet: (g: number) => void }) {
  const t = useT()
  const [edit, setEdit] = useState(false)
  if (edit) {
    return (
      <input
        className="mx-db-edit" autoFocus aria-label={t('mxDbEdit')} title={t('mxDbEdit')}
        defaultValue={dbText(gainToDb(gain)).replace('−', '-')}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setEdit(false)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') setEdit(false)
          if (e.key !== 'Enter') return
          const s = e.currentTarget.value.trim().replace('−', '-').replace(',', '.')
          const v = /^-?(inf|∞)$/i.test(s) ? -Infinity : Number(s)
          if (s !== '' && !Number.isNaN(v)) { beginMixGesture(); onSet(dbToGain(Math.min(6, v))) }
          setEdit(false)
        }}
      />
    )
  }
  return <div className="mx-db" onDoubleClick={() => setEdit(true)} title={t('mxDbEdit')}>{dbText(gainToDb(gain))}</div>
}

function Pan({ track }: { track: Track }) {
  const t = useT()
  const playhead = useEditor((s) => s.playhead)
  const keyed = !!track.pan?.keyframes?.length
  const v = trackPanAt(track, playhead)
  const at = useRef(0)
  const set = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect()
    setTrackPan(track.id, ((x - r.left) / Math.max(1, r.width)) * 2 - 1, at.current)
  }
  return (
    <>
      <div
        className="mx-pan" role="slider" tabIndex={0}
        aria-label={trf('mxPanLabel', { track: track.name })} aria-valuetext={panText(v)}
        aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(v.toFixed(2))}
        title={trf('mxPanTitle', { v: panText(v) })}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          // a keyed pan takes ONE key per gesture, at the gesture's start (BREAKS 12)
          at.current = useEditor.getState().playhead
          beginMixGesture()
          set(e.currentTarget, e.clientX)
        }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) set(e.currentTarget, e.clientX) }}
        onDoubleClick={() => { beginMixGesture(); setTrackPan(track.id, 0, useEditor.getState().playhead) }}
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
          if (!dir) return
          e.preventDefault()
          e.stopPropagation()
          beginMixGesture()
          setTrackPan(track.id, v + dir * (e.shiftKey ? 0.01 : 0.05), useEditor.getState().playhead)
        }}
      >
        <div className="mx-pan-fill" style={{ left: `${50 + Math.min(0, v) * 50}%`, right: `${50 - Math.max(0, v) * 50}%` }} />
      </div>
      <div className="mx-pan-val">
        {panText(v)}
        {keyed && <span title={t('mxPanKeyed')} style={{ display: 'inline-flex', color: 'var(--c-sel)' }}><Icon name="diamond" size={9} /></span>}
      </div>
    </>
  )
}

type Reg = (key: string) => (e: MeterEls | null) => void

/** K8: arm for recording — the track header's (`th-arm`) and the strip's (`mx-btn mx-arm`) */
export function ArmButton({ trackId, strip = false }: { trackId: string; strip?: boolean }) {
  const t = useT()
  const on = useRecord((s) => trackId in s.armed)
  const label = on ? t('mxArmed') : t('mxArm')
  return (
    <button className={strip ? `mx-btn mx-arm${on ? ' on' : ''}` : `th-arm${on ? ' on' : ''}`}
            data-act={strip ? 'mx-arm' : 'arm'} aria-pressed={on} title={label} aria-label={t('mxArm')}
            onClick={() => toggleArm(trackId)}>
      <Icon name="circle" size={strip ? 12 : 13} style={on ? { fill: 'currentColor' } : undefined} />
    </button>
  )
}

/** K8: the armed strip's input, under its name; the select changes it */
function InputLine({ trackId }: { trackId: string }) {
  const t = useT()
  const device = useRecord((s) => s.armed[trackId])
  const list = useAudioInputs()
  if (device === undefined) return null
  const name = device ? list.find(([id]) => id === device)?.[1] ?? device.slice(0, 8) : t('mxInDefault')
  return (
    <label className="mx-in" title={trf('mxInput', { device: name })}>
      <Icon name="mic" size={10} />
      <select className="mx-out-sel" data-act="mx-in" aria-label={trf('mxInput', { device: name })} value={device}
              onChange={(e) => setInput(trackId, e.target.value)}>
        <option value="">{t('mxInDefault')}</option>
        {list.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
      </select>
    </label>
  )
}

const TRACK_FX: AudioFxType[] = ['eq', 'comp', 'deess']

/**
 * K9 (canvas K, RULES 12): the track's effects — they process the track's SUM.
 * Two slots show; a third and more collapse into «Ещё N: …». A click opens the
 * track's chain in a popover (every block, and adding more); right-click
 * bypasses or removes; a bypassed one is struck through. An empty strip shows
 * one dashed «+ Эффект»; a narrow one has one button «Эфф. · N».
 */
function Slots({ track, narrow }: { track: Track; narrow: boolean }) {
  const t = useT()
  const list = track.audioFx ?? []
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  const [add, setAdd] = useState<{ x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!pop && !menu) return
    const close = () => { setPop(null); setMenu(null) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [pop, menu])
  const owner = { track }
  const at = (e: React.MouseEvent) => { const r = e.currentTarget.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 } }
  const open = (e: React.MouseEvent) => setPop(at(e))
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const names = list.map((f) => t(FX_NAME[f.type]))
  const slots = narrow ? (
    <button className={`mx-slot${list.length ? '' : ' mx-add'}`} data-act="mx-fx" onPointerDown={stop}
            title={list.length ? trf('mxFxList', { names: names.join(', ') }) : t('mxFxAddTitle')}
            onClick={(e) => (list.length ? open(e) : setAdd(at(e)))}>
      {list.length ? trf('mxFxNarrow', { n: list.length }) : t('mxFxAddNarrow')}
    </button>
  ) : (
    <>
      {list.slice(0, list.length > 2 ? 1 : 2).map((f, i) => (
        <button key={f.id} className={`mx-slot${f.enabled ? '' : ' mx-off'}`} data-act="mx-fx" data-afx={f.type} onPointerDown={stop}
                title={trf(f.enabled ? 'mxFxSlot' : 'mxFxOff', { name: names[i] })}
                onClick={open}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: f.id }) }}>
          {names[i]}
        </button>
      ))}
      {list.length > 2 && (
        <button className="mx-slot" data-act="mx-fx-more" onPointerDown={stop} onClick={open}
                title={trf('mxFxList', { names: names.join(', ') })}>
          {trf('mxFxMore', { n: list.length - 1, names: names.slice(1).join(', ') })}
        </button>
      )}
      {list.length < 2 && (
        <button className="mx-slot mx-add" data-act="mx-fx-add" onPointerDown={stop} title={t('mxFxAddTitle')}
                onClick={(e) => setAdd(at(e))}>
          {t('mxFxAdd')}
        </button>
      )}
    </>
  )
  const target = menu && list.find((f) => f.id === menu.id)
  return (
    <div className="mx-slots">
      {slots}
      {pop && (
        <CtxMenu x={pop.x} y={pop.y} className="afx-pop">
          <div className="ctx-title">{trf('mxFxTitle', { track: track.name })}</div>
          {list.map((f) => <FxBlock key={f.id} owner={owner} fx={f} />)}
          <div className="afx-add-row">
            {TRACK_FX.map((ty) => (
              <button key={ty} className="fx-add" data-afx-add={ty} onClick={() => addFx(owner, ty)}>
                <Icon name="plus" size={12} /> {t(FX_NAME[ty])}
              </button>
            ))}
          </div>
        </CtxMenu>
      )}
      {add && (
        <FxAddMenu x={add.x} y={add.y} types={TRACK_FX} onClose={() => setAdd(null)}
                   onPick={(ty) => { addFx(owner, ty); setPop({ x: add.x, y: add.y }) }} />
      )}
      {menu && target && (
        <CtxMenu x={menu.x} y={menu.y}>
          <button data-act="mx-fx-bypass" onClick={() => { toggleFx(owner, target.id); setMenu(null) }}>
            {t(target.enabled ? 'mxFxBypass' : 'mxFxEnable')}
          </button>
          <button className="danger" data-act="mx-fx-remove" onClick={() => { removeFx(owner, target.id); setMenu(null) }}>
            {t('mxFxRemove')}
          </button>
        </CtxMenu>
      )}
    </div>
  )
}

function Strip({ track, quiet, narrow, reg }: { track: Track; quiet: boolean; narrow: boolean; reg: Reg }) {
  const t = useT()
  return (
    <div
      className={`mx-strip${narrow ? ' mx-narrow' : ''}${quiet ? ' mx-quiet' : ''}`}
      data-strip={track.id}
      style={track.color ? { boxShadow: `inset 0 3px 0 var(--label-${track.color})` } : undefined}
    >
      <div className="mx-name" title={track.name}>{track.name}</div>
      <InputLine trackId={track.id} />
      <Slots track={track} narrow={narrow} />
      <Pan track={track} />
      <div className="mx-btns">
        <button className={`mx-btn mx-mute${track.muted ? ' on' : ''}`} data-act="mx-mute" aria-pressed={track.muted}
                title={t('mute')} aria-label={t('mute')} onClick={() => toggleTrack(track.id, 'muted')}>
          <Icon name={track.muted ? 'mute' : 'volume'} size={12} />
        </button>
        <button className={`mx-btn mx-solo${track.solo ? ' on' : ''}`} data-act="mx-solo" aria-pressed={!!track.solo}
                title={t('solo')} aria-label={t('solo')} onClick={() => toggleTrack(track.id, 'solo')}>
          <Icon name="solo" size={12} />
        </button>
        {!narrow && <ArmButton trackId={track.id} strip />}
      </div>
      <div className="mx-body">
        <Fader gain={track.gain} label={track.name} onSet={(g) => setTrackGain(track.id, g)} />
        {!narrow && <Scale />}
        <MeterBars onEls={reg(track.id)} />
      </div>
      <DbValue gain={track.gain} onSet={(g) => setTrackGain(track.id, g)} />
    </div>
  )
}

/** the system's audio outputs, as Настройки → Воспроизведение lists them (K7) */
export function useAudioOutputs(): [string, string][] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md) return
    const list = () => md.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')))
      .catch(() => setDevices([]))
    list()
    md.addEventListener('devicechange', list)
    return () => md.removeEventListener('devicechange', list)
  }, [])
  return devices.map((d) => [d.deviceId, d.label || d.deviceId.slice(0, 8)])
}

const LIM: Record<string, { k: TKey; title: TKey; dot: string; color?: string }> = {
  on: { k: 'mxLimOn', title: 'mxLimOnTitle', dot: 'var(--c-ok)' },
  acting: { k: 'mxLimActing', title: 'mxLimActingTitle', dot: 'var(--c-warn)', color: 'var(--c-warn)' },
  off: { k: 'mxLimOff', title: 'mxLimOffTitle', dot: 'var(--c-text-off)' },
  loading: { k: 'mxLimOn', title: 'mxLimOnTitle', dot: 'var(--c-text-off)' },
  failed: { k: 'mxLimFail', title: 'mxLimFailTitle', dot: 'var(--c-danger)', color: 'var(--c-danger)' }
}

function Master({ reg }: { reg: Reg }) {
  const t = useT()
  const gain = useEditor((s) => s.project.masterGain ?? 1)
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 100) // the readouts update 10 times a second
    return () => clearInterval(id)
  }, [])
  const l = loudness()
  const lim = limiterInfo()
  const acting = lim.state === 'on' && lim.reductionDb < -0.05
  const ls = LIM[acting ? 'acting' : lim.state]
  const red = dbText(lim.reductionDb)
  const outputs = useAudioOutputs()
  useSettings((s) => s.snap)
  const out = String(setting('playback.audioOutput') ?? '')
  const known = !out || outputs.some(([id]) => id === out)
  const read = (k: TKey, title: TKey, v: number, cls = '') => (
    <div className="mx-read" title={t(title)}><span className="mx-read-k">{t(k)}</span><span className={`mx-read-v${cls}`}>{lufsText(v)}</span></div>
  )
  return (
    <div className="mx-master" data-strip="master">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s2)' }}>
        <span className="mx-name" style={{ color: 'var(--c-text)' }}>{t('mxMaster')}</span>
        <span className="mx-lim" data-lim={acting ? 'acting' : lim.state} style={ls.color ? { color: ls.color } : undefined}
              title={trf(ls.title, { db: red })}>
          <span className="mx-lim-dot" style={{ background: ls.dot }} />{trf(ls.k, { db: red })}
        </span>
      </div>
      <div className="mx-row" style={{ gap: 'var(--s3)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)' }}>
          <div className="mx-body">
            <Fader gain={gain} label={t('mxMaster')} onSet={setMaster} />
            <Scale />
            <MeterBars onEls={reg('master')} />
          </div>
          <DbValue gain={gain} onSet={setMaster} />
        </div>
        <div className="mx-lufs" data-lufs="">
          {read('mxM', 'mxMTitle', l.momentary)}
          {read('mxS', 'mxSTitle', l.shortTerm)}
          {read('mxI', 'mxITitle', l.integrated, ' mx-big')}
          {read('mxTp', 'mxTpTitle', l.truePeak, l.truePeak > -1 ? ' mx-over' : '')}
          <button className="ghost" data-act="mx-reset" onClick={resetLoudness} title={t('mxResetTitle')}
                  style={{ alignSelf: 'flex-start', minHeight: 20, padding: '0 var(--s2)', fontSize: 'var(--fz-micro)' }}>
            <Icon name="reload" size={11} /> {t('mxReset')}
          </button>
        </div>
      </div>
      <label className="mx-out" title={t('mxOutTitle')}>
        <Icon name="volume" size={11} />
        <select className="mx-out-sel" data-act="mx-out" aria-label={t('mxOutTitle')} value={out}
                onChange={(e) => useSettings.getState().set('playback.audioOutput', e.target.value === '' ? null : e.target.value)}>
          <option value="">{t('setOutDefault')}</option>
          {outputs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          {!known && <option value={out}>{trf('mxOutGone', { name: out.slice(0, 8) })}</option>}
        </select>
        <Icon name="chevronDown" size={11} />
      </label>
    </div>
  )
}

const STRIP_W = 72
const NARROW_W = 56
const MASTER_W = 176
/** past this many tracks the strips go narrow (the canvas's 12-track board) */
const NARROW_FROM = 7

export function MixerDock() {
  const t = useT()
  const tracks = useEditor((s) => s.project.tracks)
  const project = useEditor((s) => s.project)
  const audio = tracks.filter((x) => x.kind === 'audio')
  const anySolo = tracks.some((x) => x.solo)
  const narrow = audio.length >= NARROW_FROM
  const els = useRef(new Map<string, MeterEls>())
  const regs = useRef(new Map<string, (e: MeterEls | null) => void>())
  const reg: Reg = (key) => {
    let f = regs.current.get(key)
    if (!f) {
      f = (e) => { if (e) els.current.set(key, e); else els.current.delete(key) }
      regs.current.set(key, f)
    }
    return f
  }
  useEffect(() => {
    const states = new Map<string, MeterState>()
    let raf = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      for (const [key, e] of els.current) {
        let m = states.get(key)
        if (!m) states.set(key, (m = newMeter()))
        stepMeter(m, key === 'master' ? masterPeaks() : isArmed(key) ? inputPeaks(key) : trackPeaks(key), now, e)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  const w = audio.length ? audio.length * (narrow ? NARROW_W : STRIP_W) + MASTER_W + 1 : MASTER_W + 240
  return (
    <div className="mx-dock" data-mixer="" style={{ width: w, maxWidth: '45vw', flexShrink: 0 }}>
      <div className="panel-head">
        <span>{t('mxToggle')}</span>
        <button className="ghost icon-only" data-act="mx-hide" title={t('mxHide')} aria-label={t('mxHide')}
                onClick={() => useMixerUi.getState().setOpen(false)}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="mx-row">
        <div className="mx-scroll">
          {audio.length ? audio.map((tr) => (
            <Strip key={tr.id} track={tr} narrow={narrow} reg={reg}
                   quiet={anySolo && !trackHeard(project, tr)} />
          )) : (
            <div className="mx-empty">
              <span>{t('mxEmpty')}</span>
              <button onClick={() => useEditor.getState().addTrack('audio')}><Icon name="plus" size={13} /> {t('mxAddTrack')}</button>
            </div>
          )}
        </div>
        <Master reg={reg} />
      </div>
    </div>
  )
}
