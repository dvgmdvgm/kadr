// L5: the source viewer, landed from canvas L (design-source/canvas/L, RULES.md).
// `ViewerSlot` is the preview's place in the centre column: today's slot
// untouched until a source is opened, then a head of «Источник | Программа»
// tabs over it, the viewer laid OVER the programme (or beside it under
// «Рядом»). The slot div keeps its place in the tree in every mode, so the
// preview host and its fragment iframes are never moved or reloaded by it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useSettings } from '@/state/store'
import { setPreviewSlot, usePopout, dockPreviewWindow } from '@/engine/popout'
import { useOffline, openRelink } from '@/engine/offline'
import { previewPrefs } from '@/engine/player'
import { chromiumCanDecode } from '@/engine/codecs'
import { attachAudio, detachAudio, resumeAudio } from '@/engine/audio'
import { formatTime } from '@/engine/timelineMath'
import { playsProxy } from '@shared/proxyChoice'
import type { MediaAsset, Track, TrackKind } from '@shared/types'
import {
  useSource, marksOf, registerSourceMedia, sourceDuration, sourcePlan, sourceEdit,
  closeSource, showTab, toggleSplit, setSourceFocus, seekSource, playSource, stopSource,
  markSource, setSourceMark, clearSourceMarks, goSourceMark, setTarget, targetOf, hasPicture, hasSound,
  type SourceTarget
} from '@/engine/source'
import { useT, trf, tr } from '@/i18n'
import { Icon } from './icons'
import { CtxMenu } from './CtxMenu'

/** «Рядом» only fits from this centre width up (RULES 4) */
const SPLIT_MIN_W = 900
/** under this height the viewer drops its action row (RULES 22, the 1000×640 window) */
const COMPACT_H = 300

const secs = (n: number) => {
  const s = n.toFixed(2)
  return trf('svSecs', { s: useSettings.getState().lang === 'ru' ? s.replace('.', ',') : s })
}

// the viewer owns focus routing: a press inside it focuses it, anywhere else
// unfocuses it — and a press on the timeline's lanes brings the programme back
function useFocusRouting() {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = e.target as Element | null
      const inside = !!el?.closest?.('.sv-viewer, .sv-patch-menu')
      setSourceFocus(inside)
      if (!inside && el?.closest?.('.tl-scroll') && !el.closest('.track-head') && useSource.getState().tab === 'source') showTab('program')
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [])
}

export function ViewerSlot() {
  const t = useT()
  useFocusRouting()
  const assetId = useSource((s) => s.assetId)
  const tab = useSource((s) => s.tab)
  const split = useSource((s) => s.split)
  const popWin = usePopout((s) => s.win)
  const projectName = useEditor((s) => s.project.name)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const loaded = !!assetId
  const headShown = loaded || tab === 'source'
  const splitOn = split && loaded && !popWin && size.w >= SPLIT_MIN_W
  // with the programme in its own window the slot shows the source (RULES 6)
  const srcShown = !splitOn && (tab === 'source' || (!!popWin && loaded))
  const compact = size.h < COMPACT_H
  return (
    <div ref={ref} className={`sv-area${splitOn ? ' sv-split' : ''}`}>
      {splitOn && <div className="sv-pane"><SourceViewer pane compact={compact} canSplit /></div>}
      <div className={splitOn ? 'sv-pane' : 'sv-prog'}>
        {headShown && (splitOn
          ? <div className="sv-head"><span className="sv-pane-label">{t('svTabProgram')}</span><span className="sv-name">{projectName}</span></div>
          : <ViewerHead active={srcShown ? 'source' : 'program'} canSplit={size.w >= SPLIT_MIN_W && !popWin} compact={compact} />)}
        <div className="sv-stage">
          <div className={`preview-slot${popWin ? ' empty' : ''}`} ref={setPreviewSlot} />
          {popWin && !srcShown && (
            <div className="preview-detached">
              <Icon name="popout" size={30} />
              <span>{t('popoutHere')}</span>
              <button onClick={() => dockPreviewWindow()} data-act="popin">
                <Icon name="popin" /> {t('popoutBack')}
              </button>
            </div>
          )}
          {srcShown && <SourceViewer compact={compact} />}
        </div>
      </div>
    </div>
  )
}

function ViewerHead({ active, canSplit, compact, pane }: { active: 'source' | 'program'; canSplit: boolean; compact: boolean; pane?: boolean }) {
  const t = useT()
  const assetId = useSource((s) => s.assetId)
  const asset = useEditor((s) => s.project.assets.find((a) => a.id === assetId))
  const split = useSource((s) => s.split)
  const focused = useSource((s) => s.focused)
  const popWin = usePopout((s) => s.win)
  return (
    <div className={`sv-head${focused && active === 'source' && !pane ? ' sv-focus' : ''}`} data-act="sv-head">
      {pane ? <span className="sv-pane-label">{t('svTabSource')}</span> : (
        <div className="sv-tabs" role="tablist">
          <button className={`sv-tab${active === 'source' ? ' active' : ''}`} role="tab" aria-selected={active === 'source'}
                  data-act="sv-tab-source" title={t('svTabSourceTitle')} onClick={() => showTab('source')}>
            {t('svTabSource')}
          </button>
          <button className={`sv-tab${active === 'program' ? ' active' : ''}`} role="tab" aria-selected={active === 'program'}
                  data-act="sv-tab-program" title={popWin ? t('svTabProgramAway') : t('svTabProgramTitle')}
                  onClick={() => { if (popWin) dockPreviewWindow(); showTab('program') }}>
            {t('svTabProgram')}{popWin && <Icon name="popout" size={11} />}
          </button>
        </div>
      )}
      <span className="sv-name" title={asset?.path ?? ''}>{asset?.name ?? ''}</span>
      {canSplit && asset && (
        <button className={`ghost${split ? ' toggled' : ''}`} data-act="sv-split" aria-pressed={split}
                title={split ? t('svSplitOff') : t('svSplitOn')} onClick={toggleSplit}>{t('svSplit')}</button>
      )}
      {asset && !compact && (
        <button className="ghost icon-only" data-act="sv-close" title={t('svClose')} aria-label={t('svClose')} onClick={closeSource}>
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  )
}

function SourceViewer({ compact, pane, canSplit }: { compact: boolean; pane?: boolean; canSplit?: boolean }) {
  const t = useT()
  const assetId = useSource((s) => s.assetId)
  const asset = useEditor((s) => s.project.assets.find((a) => a.id === assetId)) ?? null
  const offline = useOffline((s) => (assetId ? s.ids.has(assetId) : false))
  const focused = useSource((s) => s.focused)
  return (
    <div className={`sv-viewer${focused ? ' sv-focus' : ''}`} data-act="source-viewer">
      {pane && <ViewerHead active="source" canSplit={!!canSplit} compact={compact} pane />}
      {!asset ? <SourceEmpty /> : offline ? (
        <div className="sv-empty">
          <Icon name="unlink" size={30} />
          <span>{t('svOffline')}</span>
          <button onClick={() => openRelink()}>{t('offlineBadge')}</button>
        </div>
      ) : <SourceBody key={asset.id} asset={asset} compact={compact} />}
    </div>
  )
}

function SourceEmpty() {
  const t = useT()
  // the keys are keycaps: {I} {O} {,} {.} in the string
  const how = t('svEmptyHow').split(/\{(.)\}/)
  return (
    <div className="sv-empty" data-act="sv-empty">
      <Icon name="film" size={30} />
      <span>{t('svEmpty')}<br />{how.map((p, i) => (i % 2 ? <span key={i} className="keycap">{p}</span> : p))}</span>
    </div>
  )
}

function sourceUrl(a: MediaAsset): string {
  const proxy = !!a.proxyPath && playsProxy(a, { proxies: previewPrefs.proxies, canDecode: chromiumCanDecode(a) })
  return window.kadr.fileUrl(proxy ? a.proxyPath! : a.path)
}

/** waveform columns from the asset's own probe peaks (max per column, 0..1) */
function columns(a: MediaAsset, n: number): number[] | null {
  if (!a.waveform) return null
  const max = Uint8Array.from(atob(a.waveform.max), (c) => c.charCodeAt(0))
  if (!max.length) return null
  const per = max.length / n
  return Array.from({ length: n }, (_, i) => {
    let m = 0
    for (let k = Math.floor(i * per); k < Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)); k++) m = Math.max(m, max[k] ?? 0)
    return m / 255
  })
}
const Bars = ({ cols }: { cols: number[] }) => (
  <>{cols.map((v, i) => <span key={i} style={{ height: `${Math.max(2, Math.round(v * 100))}%` }} />)}</>
)

function SourceBody({ asset, compact }: { asset: MediaAsset; compact: boolean }) {
  const t = useT()
  const fps = useEditor((s) => (asset.fps > 0 ? asset.fps : s.project.fps))
  const m = useSource((s) => marksOf(s, asset.id))
  const playing = useSource((s) => s.playing)
  const dur = sourceDuration(asset)
  const still = asset.kind === 'image'
  const [pos, setPos] = useState(m.pos)
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const url = useMemo(() => sourceUrl(asset), [asset])
  const jogCols = useMemo(() => (hasSound(asset) ? columns(asset, 180) : null), [asset])
  const picCols = useMemo(() => (asset.kind === 'audio' ? columns(asset, 160) : null), [asset])

  // the element: registered for the keys, its position mirrored while it plays
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    registerSourceMedia(el)
    el.currentTime = marksOf(useSource.getState(), asset.id).pos
    let raf = 0
    const loop = () => { setPos(el.currentTime); raf = requestAnimationFrame(loop) }
    const onPlay = () => {
      // the source's sound goes through the master like the programme's: the
      // output device (K7), the limiter and the meter see it
      resumeAudio()
      attachAudio(el)
      useSource.setState({ playing: true })
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(loop)
    }
    const onStop = () => {
      cancelAnimationFrame(raf)
      setPos(el.currentTime)
      useSource.setState((s) => ({
        playing: false,
        marks: s.assetId ? { ...s.marks, [asset.id]: { ...marksOf(s, asset.id), pos: el.currentTime } } : s.marks
      }))
    }
    const onSeek = () => setPos(el.currentTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onStop)
    el.addEventListener('ended', onStop)
    el.addEventListener('seeked', onSeek)
    return () => {
      cancelAnimationFrame(raf)
      el.pause()
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onStop)
      el.removeEventListener('ended', onStop)
      el.removeEventListener('seeked', onSeek)
      detachAudio(el)
      registerSourceMedia(null)
      useSource.setState({ playing: false })
    }
  }, [asset.id])
  // a still has no element: its position is the store's
  useEffect(() => { if (still) setPos(m.pos) }, [still, m.pos])

  const tc = (x: number) => formatTime(x, fps)
  const marked = m.in !== null || m.out !== null
  const a = m.in ?? 0, b = m.out ?? dur
  const pct = (x: number) => `${(Math.min(dur, Math.max(0, x)) / (dur || 1)) * 100}%`

  // the scrub bar: click/drag seeks; a drag that starts on a range edge moves that mark
  const jogRef = useRef<HTMLDivElement>(null)
  const onJogDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || still) return
    const el = jogRef.current!
    const r = el.getBoundingClientRect()
    const at = (x: number) => ((x - r.left) / r.width) * dur
    const px = (x: number) => (x / (dur || 1)) * r.width + r.left
    let edge: 'in' | 'out' | null = null
    if (marked) {
      if (m.in !== null && Math.abs(e.clientX - px(a)) <= 5) edge = 'in'
      else if (m.out !== null && Math.abs(e.clientX - px(b)) <= 5) edge = 'out'
    }
    stopSource()
    el.setPointerCapture(e.pointerId)
    const go = (x: number) => {
      const s = Math.min(dur, Math.max(0, at(x)))
      if (edge) setSourceMark(edge, s)
      seekSource(s)
      setPos(s)
    }
    go(e.clientX)
    el.onpointermove = (ev) => go(ev.clientX)
    el.onpointerup = () => { el.onpointermove = null; el.onpointerup = null }
  }
  const step = dur > 0 ? [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => dur / s <= 6) ?? 3600 : 1
  const ticks: number[] = []
  for (let x = 0; x < dur - step / 4; x += step) ticks.push(x)
  const tick = (x: number) => (x < 60 ? `${x}s` : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`)

  return (
    <>
      <div className="sv-pic">
        {asset.kind === 'audio' ? (
          <div className="sv-wave sv-bars" role="img" aria-label={trf('svWaveAlt', { name: asset.name })}>
            {picCols && <Bars cols={picCols} />}
            <audio ref={mediaRef} src={url} crossOrigin="anonymous" preload="auto" />
          </div>
        ) : still ? (
          <img className="sv-frame" src={window.kadr.fileUrl(asset.path)} crossOrigin="anonymous" alt={asset.name} />
        ) : (
          <video ref={mediaRef} className="sv-frame" src={url} crossOrigin="anonymous" preload="auto" playsInline
                 aria-label={trf('svPicAlt', { name: asset.name, t: tc(pos) })}
                 />
        )}
      </div>
      <div ref={jogRef} className="sv-jog" role="slider" tabIndex={0} data-act="sv-jog"
           aria-label={t('svTimeTitle')} aria-valuemin={0} aria-valuemax={dur} aria-valuenow={pos} aria-valuetext={tc(pos)}
           title={t('svJog')} onPointerDown={onJogDown}>
        {jogCols && <div className="sv-jog-wave sv-bars" aria-hidden="true"><Bars cols={jogCols} /></div>}
        {marked && <div className="sv-jog-range" style={{ left: pct(a), right: `calc(100% - ${pct(b)})` }}
                        title={trf('svMarkRange', { a: tc(a), b: tc(b) })} />}
        {ticks.map((x) => <span key={x} className="sv-jog-tick" style={{ left: `calc(${pct(x)} + 3px)` }}>{tick(x)}</span>)}
        <div className="sv-jog-head" style={{ left: pct(pos) }} />
      </div>
      <div className="sv-bar">
        {!still && <>
          <button className={`sv-mark${m.in !== null ? ' on' : ''}`} data-act="sv-mark-in" aria-pressed={m.in !== null}
                  aria-label={t('svMarkIn')} title={t('svMarkIn') + (m.in !== null ? ' — ' + tc(m.in) : '')}
                  onClick={() => markSource('in')}>[</button>
          <button className={`sv-mark${m.out !== null ? ' on' : ''}`} data-act="sv-mark-out" aria-pressed={m.out !== null}
                  aria-label={t('svMarkOut')} title={t('svMarkOut') + (m.out !== null ? ' — ' + tc(m.out) : '')}
                  onClick={() => markSource('out')}>]</button>
          {marked && !compact && (
            <button className="ghost icon-only" data-act="sv-clear" title={t('svClear')} aria-label={t('svClear')}
                    onClick={clearSourceMarks}><Icon name="close" size={13} /></button>
          )}
          {!compact && <span className="sep" />}
          {!compact && (
            <button className="icon-only" title={marked ? t('svToIn') : t('svToStart')} aria-label={marked ? t('svToIn') : t('svToStart')}
                    onClick={() => goSourceMark('in')}><Icon name="toStart" size={15} /></button>
          )}
          <button className="play" data-act="sv-play" title={playing ? t('svPause') : t('svPlay')} aria-label={playing ? t('svPause') : t('svPlay')}
                  onClick={() => playSource()}><Icon name={playing ? 'pause' : 'play'} size={16} /></button>
          {!compact && (
            <button className="icon-only" title={marked ? t('svToOut') : t('svToEnd')} aria-label={marked ? t('svToOut') : t('svToEnd')}
                    onClick={() => goSourceMark('out')}><Icon name="toEnd" size={15} /></button>
          )}
        </>}
        <span className="sv-tc" title={t('svTimeTitle')} data-act="sv-tc">{tc(pos)}</span>
        <span className="sv-dur" title={marked ? t('svMarkedTitle') : t('svDurTitle')}>
          {marked ? trf('svMarked', { dur: secs(b - a) }) : `/ ${tc(dur)}`}
        </span>
      </div>
      {!compact && <SourceActions />}
    </>
  )
}

/** the patch buttons, Insert and Overwrite, and why they are off */
function SourceActions() {
  const t = useT()
  // re-plan on any change of the project, the playhead, the range or the source state
  const project = useEditor((s) => s.project)
  useEditor((s) => s.playhead)
  useEditor((s) => s.range)
  const src = useSource()
  const plan = sourcePlan(project, src)
  if (!plan) return null
  const what = plan.whole ? t('svWhole') : secs(plan.len)
  const can = !plan.why && plan.len > 0
  return (
    <div className="sv-act">
      <PatchButton kind="video" asset={plan.asset} target={plan.video} tracks={project.tracks} />
      <PatchButton kind="audio" asset={plan.asset} target={plan.audio} tracks={project.tracks} />
      <span className="flex1" />
      <button disabled={!can} data-act="sv-insert" title={trf('svInsertTitle', { what })} aria-label={`${t('svInsert')} (,)`}
              onClick={() => sourceEdit('insert')}>{t('svInsert')} <span className="keycap">,</span></button>
      <button className="primary" disabled={!can} data-act="sv-overwrite" title={trf('svOverwriteTitle', { what })}
              aria-label={`${t('svOverwrite')} (.)`} onClick={() => sourceEdit('overwrite')}>
        {t('svOverwrite')} <span className="keycap">.</span>
      </button>
      {plan.why && (
        <span className="sv-why" data-act="sv-why">
          {plan.why === 'locked' ? trf('svWhyLocked', { track: plan.track?.name ?? '' }) : t('svWhyNothing')}
        </span>
      )}
    </div>
  )
}

function PatchButton({ kind, asset, target, tracks }: { kind: TrackKind; asset: MediaAsset; target: SourceTarget; tracks: Track[] }) {
  const t = useT()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = (e: Event) => { if (!(e.target as Element | null)?.closest?.('.sv-patch-menu')) setMenu(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc) }
  }, [menu])
  const k = kind === 'video' ? 'V' : 'A'
  const fixed = kind === 'video' ? !hasPicture(asset) : !hasSound(asset)
  const track = target && target !== 'new' ? tracks.find((x) => x.id === target) : undefined
  const name = target === 'new' ? t('svNewTrackShort') : track?.name ?? ''
  const off = fixed || target === null
  const label = fixed ? t(kind === 'video' ? 'svNoPicture' : 'svNoSound') : target === null ? t('svPatchOff') : `→ ${name}`
  const title = fixed ? label : target === null ? t(kind === 'video' ? 'svPatchOffV' : 'svPatchOffA')
    : trf(kind === 'video' ? 'svPatchV' : 'svPatchA', { track: name })
  const pick = (v: SourceTarget) => { setTarget(kind, v); setMenu(null) }
  return (
    <>
      <button className={`sv-patch${off ? ' sv-patch-off' : ''}`} data-act={`sv-patch-${k.toLowerCase()}`} aria-haspopup="menu"
              disabled={fixed} title={title}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu(menu ? null : { x: r.left, y: r.bottom + 2 })
              }}>
        <span className="sv-patch-k">{k}</span>{label}{!fixed && <Icon name="chevronDown" size={11} />}
      </button>
      {menu && (
        <CtxMenu x={menu.x} y={menu.y} className="sv-patch-menu">
          {tracks.filter((x) => x.kind === kind).map((x) => (
            <button key={x.id} role="menuitemradio" aria-checked={x.id === target} disabled={x.locked}
                    title={x.locked ? t('svLocked') : undefined} onClick={() => pick(x.id)}>
              <span className="ctx-check">{x.id === target && <Icon name="check" size={13} />}</span>
              {x.name}{x.locked && <> <Icon name="lock" size={11} /></>}
            </button>
          ))}
          <button role="menuitemradio" aria-checked={target === 'new'} onClick={() => pick('new')}>
            <span className="ctx-check">{target === 'new' ? <Icon name="check" size={13} /> : <Icon name="plus" size={12} />}</span>
            {t(kind === 'video' ? 'svNewVideoTrack' : 'svNewAudioTrack')}
          </button>
          <button role="menuitemradio" aria-checked={target === null} onClick={() => pick(null)}>
            <span className="ctx-check">{target === null && <Icon name="check" size={13} />}</span>
            {t(kind === 'video' ? 'svSkipPicture' : 'svSkipSound')}
          </button>
        </CtxMenu>
      )}
    </>
  )
}

/** The source's target on a track head (RULES 18): filled where it lands, an
    empty place on the other unlocked tracks of that kind. Nothing without a source. */
export function SourceChip({ track }: { track: Track }) {
  const assetId = useSource((s) => s.assetId)
  useSource((s) => s.targets)
  const project = useEditor((s) => s.project)
  const asset = assetId ? project.assets.find((a) => a.id === assetId) : undefined
  if (!asset) return null
  const can = track.kind === 'video' ? hasPicture(asset) : hasSound(asset)
  if (!can) return null
  const on = targetOf(track.kind, project) === track.id
  if (!on && track.locked) return null
  const k = track.kind === 'video' ? 'V' : 'A'
  return (
    <button className={`sv-chip${on ? ` sv-chip-${k.toLowerCase()}` : ''}`} data-act={`sv-chip-${k.toLowerCase()}`}
            aria-pressed={on} aria-label={tr(on ? (k === 'V' ? 'svChipV' : 'svChipA') : (k === 'V' ? 'svChipSetV' : 'svChipSetA'))}
            title={tr(on ? (k === 'V' ? 'svChipV' : 'svChipA') : (k === 'V' ? 'svChipSetV' : 'svChipSetA'))}
            onClick={(e) => { e.stopPropagation(); setTarget(track.kind, track.id) }}>
      {on ? k : ''}
    </button>
  )
}

