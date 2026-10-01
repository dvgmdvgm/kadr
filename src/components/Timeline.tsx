import { type WaveBins, type FollowMode, waveColumns, trackOverlaps, formatTime, fitZoom, followLeft } from '@/engine/timelineMath'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync, createPortal } from 'react-dom'
import { create } from 'zustand'
import { LABEL_COLORS, type Anim, type AudioDefect, type Clip, type MediaAsset, type TimelineMarker, type Track } from '@shared/types'
import {
  useEditor, useSettings, projectDuration, snapPoints, snapTo, findClip, withLinked, MAX_ZOOM, MIN_ZOOM, setting, timelineView
} from '@/state/store'

/** «Скорость клипа — перетаскивание с»: the modifier that turns an edge drag into a speed change */
const speedModifier = (e: { ctrlKey: boolean; altKey: boolean }) => {
  const m = setting('mouse.speedModifier')
  return m === 'ctrl' ? e.ctrlKey : m === 'alt' ? e.altKey : e.ctrlKey || e.altKey
}
/** «Радиус прилипания», in seconds at this zoom */
const snapRadius = (zoom: number) => setting<number>('editing.snapRadius') / zoom
import { useT, tr, trf, type TKey } from '@/i18n'
import { duckHere, duckTargets } from '@/engine/duck'
import { useSilences, setSilenceState, applySilences, clearSilences, confirmAllSilences, findSilencesHere, type Silence } from '@/engine/silences'
import { TRANSITIONS } from '@/gl/transitions'
import { EDGE_TRANSITIONS } from '@/gl/edges'
import { FADE_CURVES, FADE_CURVE_NAME, type FadeCurve } from '@shared/fadeCurves'
import { CtxMenu } from './CtxMenu'
import { PasteAttrsMenu } from './PasteAttrsMenu'
import { Modal } from './Modal'
import { trackDeleteAsks } from '@/engine/discardGuard'
import { reverseClip, useReverseUi } from '@/engine/reverse'
import { useOffline } from '@/engine/offline'
import { normalizeClip, useNormalizeUi } from '@/engine/normalize'
import { dropPayload, dragHasMedia, dropUsable, importDrop } from '@/engine/mediaImport'
import { useTextUi } from './TextTools'
import { useCaptionsUi } from './CaptionsDialog'
import { useNeonWaveUi } from './NeonWaveDialog'
import { useSoundsUi } from './SoundsDialog'
import { useBeatsUi } from '@/engine/beats'
import { useChecksUi } from '@/engine/checks'
import { useTtsUi } from './TtsDialog'
import { evalAnim } from '@/engine/anim'
import { levelAt, addLevelPoint, moveLevelPoint, deleteLevelPoint, shiftLevel, sortedKfs, type LevelLine } from './animUtils'
import { spanToProject, projectToSrc, type VisibleSpan } from '@/engine/voiceDefects'
import { clipsInSpan, clipsBetween, unlocked } from '@/engine/timelineSelect'
import { layoutSpeeds, SPEED_MIN, SPEED_MAX, type SpeedItem } from '@/engine/speedLayout'
import { useVoiceUi, setVerdict, clearVerdict, addUserDefect, setDefectsHidden } from '@/engine/voiceCheck'
import { confirmDefect } from '@/engine/voiceRegen'
import { useDefectsUi, targetRun } from './DefectsDialog'
import { Icon, Spinner, type IconName } from './icons'
import { token } from '@/theme'
import { logWarn } from '@/engine/log'
import { scrub } from '@/engine/scrubAudio'
import { toggleTrack, useMixerUi } from '@/engine/mixer'
import { MixerDock } from './Mixer'
import { dbText, gainToDb } from '@shared/fader'

/** Neon wave (audio-reactive fragment) from the selected range. */
function NeonWaveButton() {
  const t = useT()
  const range = useEditor((s) => s.range)
  return (
    <button
      disabled={!range}
      data-act="neon-wave"
      title={t('nwButtonHint')}
      onClick={() => useNeonWaveUi.getState().setOpen(true)}
    >
      <Icon name="wave" /> {t('nwButton')}
    </button>
  )
}

/** Transcribe the selected range (Shift-drag on the ruler) into SRT/TXT. */
function TranscribeRangeButton() {
  const t = useT()
  const range = useEditor((s) => s.range)
  return (
    <button
      disabled={!range}
      title={t('transcribeRangeHint')}
      onClick={() => {
        const r = useEditor.getState().range
        if (r) useTextUi.getState().openTranscribe({ kind: 'range', start: r.start, end: r.end })
      }}
      data-act="transcribe-range"
    >
      <Icon name="captions" /> {t('transcribeRange')}
    </button>
  )
}

const HEADER_W = 150
const RULER_H = 28

function niceStep(zoom: number): number {
  // a major tick roughly every 90px
  const raw = 90 / zoom
  const steps = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s >= raw) ?? 600
}

function tickLabel(t: number): string {
  if (t >= 60) return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return `${parseFloat(t.toFixed(2))}s`
}

/** Ctrl pressed DURING a drag lets go of the magnet while it is held (see Timeline's effect) */
let snapFree = false
const snapTime = (t: number, points: number[], zoom: number) => (snapFree ? t : snapTo(t, points, zoom))

/** window-level drag helper: calls move(dx, ev) until pointerup */
function windowDrag(
  e: { clientX: number },
  move: (dx: number, ev: PointerEvent) => void,
  done?: () => void
) {
  const startX = e.clientX
  const onMove = (ev: PointerEvent) => move(ev.clientX - startX, ev)
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    // a cancelled gesture (pen/touch, a window manager stealing the drag)
    // never sends pointerup — without this the drag's overlay stays on screen
    // and every later mouse move keeps driving it with no button held
    window.removeEventListener('pointercancel', onUp)
    done?.()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

// ---------------------------------------------------------------------------
// decoded waveform cache (per asset)

/** a decoded waveform + its display gain (quiet recordings stay visible, Audacity-like) */
interface Wf extends WaveBins {
  norm: number
}

const wfCache = new Map<string, Wf>()

function getWaveform(asset: MediaAsset): Wf | null {
  if (!asset.waveform) return null
  let wf = wfCache.get(asset.id)
  if (!wf) {
    const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const max = decode(asset.waveform.max)
    const rms = decode(asset.waveform.rms)
    let peak = 0
    for (const v of max) if (v > peak) peak = v
    wf = {
      rate: asset.waveform.rate,
      max,
      rms,
      norm: Math.min(8, 230 / Math.max(16, peak)),
      windows: new Map()
    }
    wfCache.set(asset.id, wf)
  }
  return wf
}

/** Drag the playhead, or — with Shift — select an export range, snapped. */
function startScrubOrRange(e: React.PointerEvent<HTMLDivElement>, lane: HTMLElement) {
  const timeAt = (clientX: number) => {
    const rect = lane.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left) / useEditor.getState().zoom)
  }
  if (e.shiftKey) {
    const st = useEditor.getState()
    const points = snapPoints(st.project, '', st.playhead)
    const anchor = snapTime(timeAt(e.clientX), points, st.zoom)
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const cur = snapTime(timeAt(ev.clientX), points, s.zoom)
      s.setRange({ start: Math.min(anchor, cur), end: Math.max(anchor, cur) })
    })
    return
  }
  // K7: stopped, the drag is heard in short grains; playing, the player already plays it
  const heard = !useEditor.getState().playing
  const to = (t: number) => {
    useEditor.getState().setPlayhead(t)
    if (heard) scrub.move(t)
  }
  if (heard) scrub.begin()
  to(timeAt(e.clientX))
  windowDrag(e, (_dx, ev) => to(timeAt(ev.clientX)), () => { if (heard) scrub.end() })
}

/** The rubber band being dragged, in .tl-content pixels. Its own store so a
    move repaints the rectangle alone instead of every lane and clip. */
const useBand = create<{ box: { x: number; y: number; w: number; h: number } | null }>(
  () => ({ box: null })
)

function BandBox() {
  const box = useBand((s) => s.box)
  if (!box) return null
  return (
    <div
      className="band-box"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    />
  )
}

/** Rubber-band selection from an empty spot on a lane: every clip the
    rectangle covers, on every lane it reaches. Ctrl ADDS to what is already
    selected. A press that never moves is not a band — it falls through to
    `click`, which is how Ctrl+click still closes a gap and a plain click
    still parks the playhead. */
function startBand(
  e: React.PointerEvent<HTMLDivElement>,
  lane: HTMLElement,
  click: () => void
) {
  const content = lane.closest('.tl-content') as HTMLElement | null
  const scroll = content?.parentElement
  if (!content || !scroll) {
    click()
    return
  }
  const base = e.ctrlKey ? useEditor.getState().selection : null
  const x0 = e.clientX
  const y0 = e.clientY
  // the anchor is kept as a TIME and as an offset inside the content, not as
  // a screen position: the timeline can be scrolled and zoomed mid-drag (the
  // wheel does both), and a client-pixel anchor would then sit at a different
  // moment than the one the user grabbed
  const cr0 = content.getBoundingClientRect()
  const anchorT = Math.max(0, (x0 - cr0.left - HEADER_W) / useEditor.getState().zoom)
  const anchorY = y0 - cr0.top
  let moved = false
  let lastKey = ''
  windowDrag(
    e,
    (_dx, ev) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) <= 3) return
      moved = true
      const cr = content.getBoundingClientRect()
      // the sticky track headers float over the lane while it is scrolled —
      // the band stops at their edge instead of quietly taking clips nobody
      // can see underneath
      const wall = scroll.getBoundingClientRect().left + HEADER_W
      const ax = cr.left + HEADER_W + anchorT * useEditor.getState().zoom
      const left = Math.max(wall, Math.min(ax, ev.clientX))
      const right = Math.max(left, Math.max(ax, ev.clientX))
      const top = Math.min(cr.top + anchorY, ev.clientY)
      const bottom = Math.max(cr.top + anchorY, ev.clientY)
      useBand.setState({
        box: { x: left - cr.left, y: top - cr.top, w: right - left, h: bottom - top }
      })
      const trackIds: string[] = []
      for (const el of content.querySelectorAll<HTMLElement>('[data-lane]')) {
        const r = el.getBoundingClientRect()
        if (r.bottom > top && r.top < bottom) trackIds.push(el.dataset.lane!)
      }
      const s = useEditor.getState()
      const ids = unlocked(s.project, withLinked(
        s.project,
        clipsInSpan(
          s.project,
          trackIds,
          (left - cr.left - HEADER_W) / s.zoom,
          (right - cr.left - HEADER_W) / s.zoom
        )
      ))
      const next = base ? [...new Set([...base, ...ids])] : ids
      // the panels that read the selection redraw on every set — don't make
      // them do it for a pointermove that changed nothing
      const key = next.join()
      if (key === lastKey) return
      lastKey = key
      s.select(next)
    },
    () => {
      useBand.setState({ box: null })
      if (!moved) click()
    }
  )
}

interface MenuState {
  x: number
  y: number
  kind: 'track' | 'clip' | 'transition' | 'edge' | 'junction' | 'fade'
  trackId?: string
  trackKind?: Track['kind']
  clipId?: string
  linked?: boolean
  /** edge and fade menus: which clip end was clicked */
  edge?: 'in' | 'out'
  /** junction menus: [outgoing clip, incoming clip] */
  clipIds?: [string, string]
}

/** The mouse gestures, one per line behind a «?» — as a toolbar row they
    wrapped onto three lines at 1500 px and into a column in a narrow window. */
function TimelineHelp() {
  const t = useT()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!at) return
    const out = () => setAt(null)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setAt(null) } }
    window.addEventListener('pointerdown', out)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', key, true)
    }
  }, [at])
  return (
    <>
      <button
        className={`icon-only tl-help${at ? ' active' : ''}`}
        data-act="timeline-help"
        title={t('tlHelp')}
        aria-label={t('tlHelp')}
        aria-expanded={!!at}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (at) { setAt(null); return }
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        ?
      </button>
      {at && (
        <CtxMenu x={at.x} y={at.y} className="tl-help-pop">
          <div className="ctx-title">{t('tlHelp')}</div>
          {t('dropHint').split(' · ').map((line) => <div key={line} className="tl-help-line">{line}</div>)}
        </CtxMenu>
      )}
    </>
  )
}

export function Timeline({ height }: { height: number }) {
  const t = useT()
  const tracks = useEditor((s) => s.project.tracks)
  const zoom = useEditor((s) => s.zoom)
  const trackH = useSettings((s) => s.trackH)
  const duration = useEditor((s) => projectDuration(s.project))
  const scrollRef = useRef<HTMLDivElement>(null)
  // the scroll position in PIXELS; the visible seconds are derived from it and
  // the zoom in the same render — keeping seconds in state meant a zoom was
  // rendered once with the old view and then again, i.e. two layouts a frame
  const [sv, setSv] = useState({ left: 0, width: 0 })
  // a zoom gesture in progress (see the timeline effect): the zoom it started
  // at, where it is now, and the time under the anchor (off px into the lanes)
  const gestureRef = useRef<{ z0: number; nz: number; anchorT: number; off: number } | null>(null)
  const zoomGestureRef = useRef<((target: number, anchorClientX: number) => void) | null>(null)
  const commitGestureRef = useRef<(() => void) | null>(null)
  const zoomSliderRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (zoomSliderRef.current) zoomSliderRef.current.value = String(Math.log(zoom))
  }, [zoom])
  // Ctrl PRESSED during a drag frees it from the magnet while held. Ctrl held
  // BEFORE the press already means speed / roll / toggle-select, and its
  // auto-repeat is ignored, so those gestures keep snapping as before.
  useEffect(() => {
    let down = false
    const press = () => { down = true }
    const release = () => { down = false; snapFree = false }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Control') return
      if (e.type === 'keyup') snapFree = false
      else if (down && !e.repeat) snapFree = true
    }
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key, true)
    return () => {
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key, true)
    }
  }, [])
  const view = useMemo(() => ({ start: sv.left / zoom, end: (sv.left + sv.width - HEADER_W) / zoom }), [sv, zoom])
  const [menu, setMenu] = useState<MenuState | null>(null)

  const contentW = Math.max(800, (duration + 30) * zoom)

  // a layout effect: the first measure lands before the first paint (no empty frame)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    // the same numbers → the same state object: no re-render of every track
    const setSvIf = (v: { left: number; width: number }) =>
      setSv((cur) => (cur.left === v.left && cur.width === v.width ? cur : v))
    const updateView = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setSvIf({ left: el.scrollLeft, width: el.clientWidth }))
    }
    setSvIf({ left: el.scrollLeft, width: el.clientWidth }) // no empty first frame
    el.addEventListener('scroll', updateView)
    const ro = new ResizeObserver(updateView)
    ro.observe(el)

    // ZOOM GESTURES STRETCH, THEN COMMIT. Re-laying out and re-rasterising
    // the whole visible timeline on every step cost 70–90 ms a frame zoomed
    // out on an 1100-clip project (the GPU raster, not the JS). During a
    // gesture only a transform changes — the lanes, the ruler and the overlay
    // layer are scaled about the anchor (see .tl-content.zooming in the CSS),
    // which is composited, not drawn — and the real zoom is committed when
    // the gesture pauses (or stretches too far): one render, with the anchor
    // landing exactly where the stretched picture had it.
    const content = el.querySelector('.tl-content') as HTMLElement
    const commit = () => {
      clearTimeout(gestureTimer)
      const g = gestureRef.current
      if (!g) return
      gestureRef.current = null
      lastAnchor = { anchorT: g.anchorT, off: g.off, at: performance.now() }
      const s = useEditor.getState()
      const nz = g.nz
      // commit the new content width AND the view it will show in one go:
      // scrollLeft set against the stale (narrower) width gets clamped by the
      // browser (zooming near the end of a long timeline anchored left of the
      // cursor), and a view left over from the old zoom would leave the edges
      // of the new one empty for a frame
      const dur = projectDuration(s.project)
      const maxLeft = Math.max(0, HEADER_W + Math.max(800, (dur + 30) * nz) - el.clientWidth)
      const left = Math.min(maxLeft, Math.max(0, g.anchorT * nz - g.off))
      settleAtOnce = true
      try {
        flushSync(() => {
          s.setZoom(nz)
          setSvIf({ left, width: el.clientWidth })
        })
      } finally {
        settleAtOnce = false
      }
      el.scrollLeft = left
      content.classList.remove('zooming')
      content.style.removeProperty('--zs')
    }
    commitGestureRef.current = commit
    let gestureTimer: ReturnType<typeof setTimeout> | undefined
    let lastAnchor: { anchorT: number; off: number; at: number } | null = null
    zoomGestureRef.current = (target: number, anchorClientX: number) => {
      const s = useEditor.getState()
      let g = gestureRef.current
      if (!g) {
        const rect = el.getBoundingClientRect()
        const off = Math.max(0, Math.min(el.clientWidth - HEADER_W, anchorClientX - rect.left - HEADER_W))
        // a gesture that goes on after a commit keeps its anchor TIME: taken
        // afresh from the (whole-pixel) scroll position, each commit added up
        // to half a pixel of drift — ~100 ms over a tenfold zoom, measured
        const prev = lastAnchor
        const anchorT = prev && performance.now() - prev.at < 400 && Math.abs(prev.off - off) < 2
          ? prev.anchorT
          : (off + el.scrollLeft) / s.zoom
        g = { z0: s.zoom, nz: s.zoom, anchorT, off }
        gestureRef.current = g
        content.style.setProperty('--zo', `${HEADER_W + g.anchorT * g.z0}px`)
        content.classList.add('zooming')
      }
      g.nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target))
      const k = g.nz / g.z0
      content.style.setProperty('--zs', String(k))
      clearTimeout(gestureTimer)
      // a long stretch gets blurry (in) or leaves empty edges (out): redraw
      if (k > 2 || k < 0.5) commit()
      else gestureTimer = setTimeout(commit, 150)
    }
    // a key zoom (Shift+Z, Alt+Z, -/=) is a gesture committed at once: `anchorT`
    // lands `off` px into the lanes at the new zoom
    const zoomNow = (nz: number, anchorT: number, off: number) => {
      commit()
      gestureRef.current = { z0: useEditor.getState().zoom, nz: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nz)), anchorT, off }
      commit()
    }
    const lanes = () => el.clientWidth - HEADER_W
    timelineView.fit = (a, b) => {
      const f = fitZoom(a, b, lanes())
      if (f) zoomNow(f.zoom, f.t0, 0)
    }
    timelineView.zoomBy = (k) => {
      // about the playhead where it is on screen, else it comes to the middle
      const s = useEditor.getState()
      const off = s.playhead * s.zoom - el.scrollLeft
      zoomNow(s.zoom * k, s.playhead, off >= 0 && off <= lanes() ? off : lanes() / 2)
    }
    // PLAYBACK FOLLOW («Следовать за курсором»): page or centre the view while
    // playing — never during a zoom gesture, whose stretch is anchored to the view
    const unfollow = useEditor.subscribe((s, p) => {
      if (!s.playing || s.playhead === p.playhead || gestureRef.current) return
      const left = followLeft(setting<FollowMode>('playback.follow'), s.playhead * s.zoom, el.scrollLeft, lanes(), s.playRate)
      if (left !== null) el.scrollLeft = left
    })
    const onWheel = (e: WheelEvent) => {
      // «Колесо на таймлайне»: the wheel (and Ctrl+wheel) zooms around the cursor and Shift pans,
      // or the wheel scrolls and Ctrl zooms
      if (setting('mouse.wheel') === 'scroll' ? !e.ctrlKey : e.shiftKey) return
      // the gain/opacity slider row has its own precise ±1% wheel
      if ((e.target as HTMLElement).closest?.('.track-gain-row')) return
      e.preventDefault()
      const cur = gestureRef.current?.nz ?? useEditor.getState().zoom
      zoomGestureRef.current?.(cur * Math.exp(-e.deltaY * 0.0015 * setting<number>('mouse.zoomSpeed')), e.clientX)
    }
    // anything else on the timeline sees the committed zoom: a click during
    // the stretch would otherwise land where the picture is not
    const onDown = () => commit()
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('scroll', updateView)
      ro.disconnect()
      cancelAnimationFrame(raf)
      // no commit here (flushSync is not allowed while React unmounts)
      clearTimeout(gestureTimer)
      gestureRef.current = null
      zoomGestureRef.current = null
      commitGestureRef.current = null
      timelineView.fit = timelineView.zoomBy = null
      unfollow()
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  // fallback drop target for the WHOLE timeline: the ruler and the empty
  // space below the tracks must accept media too, not just the lanes
  // (a lane that took the drop leaves the event defaultPrevented)
  const onAnyDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    if (e.dataTransfer.types.includes('kadr/asset') || dragHasMedia(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onAnyDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    const sc = e.currentTarget
    const rect = sc.getBoundingClientRect()
    const time = Math.max(0,
      (e.clientX - rect.left + sc.scrollLeft - HEADER_W) / useEditor.getState().zoom)
    const assetId = e.dataTransfer.getData('kadr/asset')
    if (assetId) {
      e.preventDefault()
      useEditor.getState().insertClipFromAsset(assetId, null, time, e.shiftKey) // Shift inserts
      return
    }
    const payload = dropPayload(e)
    if (dropUsable(payload)) {
      e.preventDefault()
      void importDrop(payload, { trackId: null, at: time })
    }
  }

  const mixerOpen = useMixerUi((s) => s.open)
  return (
    <div className="timeline" style={{ height }}>
      <div className="tl-toolbar">
        <button data-act="add-video" onClick={() => useEditor.getState().addTrack('video')}>
          <Icon name="plus" size={13} /> {t('addVideoTrack')}
        </button>
        <button data-act="add-audio" onClick={() => useEditor.getState().addTrack('audio')}>
          <Icon name="plus" size={13} /> {t('addAudioTrack')}
        </button>
        <TranscribeRangeButton />
        <button
          data-act="captions"
          title={t('capButtonHint')}
          onClick={() => useCaptionsUi.getState().setOpen(true)}
        >
          <Icon name="glow" /> {t('capButton')}
        </button>
        <BeatButtons />
        <PasteAttrsMenu />
        <ChecksButton />
        <button data-act="sounds" title={t('soundsButtonHint')}
                onClick={() => useSoundsUi.getState().setOpen(true)}>
          <Icon name="sfx" /> {t('soundsButton')}
        </button>
        <NeonWaveButton />
        <button data-act="tts" title={t('ttsButtonHint')}
                onClick={() => useTtsUi.getState().openSettings()}>
          <Icon name="speech" /> {t('ttsButton')}
        </button>
        <DefectButtons />
        <SilenceButtons />
        <TimelineHelp />
        <MixerToggle />
        <span className="flex1" />
        <label className="zoom-ctl">
          {t('trackHeight')}
          <input
            type="range"
            min={32}
            max={140}
            step={2}
            value={trackH}
            onChange={(e) => useSettings.getState().setTrackH(Number(e.target.value))}
          />
        </label>
        <label className="zoom-ctl">
          {t('zoom')}
          <input
            type="range"
            ref={zoomSliderRef}
            min={Math.log(MIN_ZOOM)}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            defaultValue={Math.log(zoom)}
            onChange={(e) => {
              // the same stretch-then-commit as the wheel, anchored at the
              // playhead when it is on screen, else at the middle
              const el = scrollRef.current
              const fn = zoomGestureRef.current
              if (!el || !fn) { useEditor.getState().setZoom(Math.exp(Number(e.target.value))); return }
              const st = useEditor.getState()
              const rect = el.getBoundingClientRect()
              const g = gestureRef.current
              const z = g ? g.z0 : st.zoom
              const px = rect.left + HEADER_W + st.playhead * z - el.scrollLeft
              const onScreen = px >= rect.left + HEADER_W && px <= rect.right
              fn(Math.exp(Number(e.target.value)), onScreen ? px : rect.left + HEADER_W + (el.clientWidth - HEADER_W) / 2)
            }}
            onPointerUp={() => commitGestureRef.current?.()}
          />
        </label>
      </div>
      <div className="mx-row">
      <div className="tl-scroll" ref={scrollRef} onDragOver={onAnyDragOver} onDrop={onAnyDrop}>
        <div className="tl-content" style={{ width: HEADER_W + contentW, ['--z' as string]: zoom, ['--hw' as string]: `${HEADER_W}px` }}>
          <RulerRow contentW={contentW} view={view} />
          {tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              trackH={trackH}
              contentW={contentW}
              view={view}
              onMenu={setMenu}
            />
          ))}
          {/* zero width, full height: takes no pointer events itself and changes
              no coordinates — it exists so a zoom gesture can scale all of
              these together (.tl-content.zooming) */}
          <div className="tl-overlays">
            <RangeOverlay />
            <BandBox />
            <KfMarker />
            <BeatLines view={view} />
            <Markers />
            <SilenceFlags />
            <Playhead />
          </div>
        </div>
      </div>
      {mixerOpen && <MixerDock />}
      </div>
      {menu && <TrackMenu menu={menu} onClose={() => setMenu(null)} />}
      <TimelineAsks />
    </div>
  )
}

/** K6: «Микшер» in the timeline toolbar opens the dock right of the lanes */
function MixerToggle() {
  const t = useT()
  const open = useMixerUi((s) => s.open)
  return (
    <button className={open ? 'toggled' : ''} data-act="mixer" aria-pressed={open} title={t('mxToggleTitle')}
            onClick={() => useMixerUi.getState().setOpen(!open)}>
      <Icon name="sliders" size={13} /> {t('mxToggle')}
    </button>
  )
}

// Destructive timeline actions that no longer happen on one click: the marker
// menu (right-click), its rename box, and the question before a track with
// clips is deleted. Each ends in one store action = one undo step.
const useTlAsk = create<{
  track: { id: string; n: number } | null
  marker: { id: string; x: number; y: number } | null
  rename: { id: string; label: string } | null
}>(() => ({ track: null, marker: null, rename: null }))

function TimelineAsks() {
  const t = useT()
  const { track, marker, rename } = useTlAsk()
  const close = () => useTlAsk.setState({ track: null, marker: null, rename: null })
  useEffect(() => {
    if (!marker) return
    const off = () => useTlAsk.setState({ marker: null })
    window.addEventListener('pointerdown', off)
    return () => window.removeEventListener('pointerdown', off)
  }, [marker])
  if (marker) {
    return (
      <CtxMenu x={marker.x} y={marker.y}>
        <button
          data-act="marker-rename"
          onClick={() => {
            const m = useEditor.getState().project.markers?.find((x) => x.id === marker.id)
            useTlAsk.setState({ marker: null, rename: m ? { id: m.id, label: m.label } : null })
          }}
        >
          {t('markerRename')}
        </button>
        <button
          className="danger"
          data-act="marker-delete"
          onClick={() => {
            useEditor.getState().removeMarker(marker.id)
            close()
          }}
        >
          {t('markerDelete')}
        </button>
      </CtxMenu>
    )
  }
  if (rename) {
    const apply = () => {
      useEditor.getState().renameMarker(rename.id, rename.label)
      close()
    }
    return (
      <Modal
        title={t('markerName')}
        onClose={close}
        actions={
          <>
            <button onClick={close}>{t('cancel')}</button>
            <button className="primary" onClick={apply} data-act="marker-rename-ok">{t('markerRename')}</button>
          </>
        }
      >
        <input
          autoFocus
          aria-label={t('markerName')}
          value={rename.label}
          onChange={(e) => useTlAsk.setState({ rename: { ...rename, label: e.target.value } })}
          onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
        />
      </Modal>
    )
  }
  if (track) {
    return (
      <Modal
        title={t('deleteTrackAsk').replace('{n}', String(track.n))}
        onClose={close}
        actions={
          <>
            <button onClick={close} data-act="track-delete-cancel">{t('cancel')}</button>
            <button
              className="danger"
              data-act="track-delete-ok"
              onClick={() => {
                useEditor.getState().removeTrack(track.id)
                close()
              }}
            >
              {t('deleteTrack')}
            </button>
          </>
        }
      >
        <p>{t('deleteTrackBody')}</p>
      </Modal>
    )
  }
  return null
}

/** the colour-label row of the track and clip menus (E9); undefined = no colour */
function Swatches({ value, onPick }: { value?: number; onPick: (n: number | undefined) => void }) {
  const t = useT()
  return (
    <>
      <div className="ctx-title dim">{t('colorLabel')}</div>
      <div className="ctx-swatches" role="group" aria-label={t('colorLabel')}>
        <button
          data-act="color-none" title={t('colorNone')} aria-label={t('colorNone')}
          aria-pressed={!value} style={{ '--sw': 'transparent' } as React.CSSProperties}
          onClick={() => onPick(undefined)}
        >
          <Icon name="close" size={12} />
        </button>
        {Array.from({ length: LABEL_COLORS }, (_, i) => i + 1).map((n) => (
          <button
            key={n} data-act={`color-${n}`}
            title={t('colorN').replace('{n}', String(n))} aria-label={t('colorN').replace('{n}', String(n))}
            aria-pressed={value === n} style={{ '--sw': `var(--label-${n})` } as React.CSSProperties}
            onClick={() => onPick(n)}
          />
        ))}
      </div>
    </>
  )
}

function TrackMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const t = useT()
  const selCount = useEditor((s) => s.selection.length)
  const transCur = useEditor((s) => {
    if (menu.kind !== 'transition' || !menu.clipId) return null
    const f = findClip(s.project, menu.clipId)
    if (!f) return null
    const tin = f.clip.transitionIn
    // a transitionIn with a duration is an edge tip — the overlap blends as default
    return tin && tin.duration <= 0.001 ? tin.type : 'crossfade'
  })
  const edgeCur = useEditor((s) => {
    if (menu.kind === 'edge' && menu.clipId) {
      const f = findClip(s.project, menu.clipId)
      const tr = menu.edge === 'in' ? f?.clip.transitionIn : f?.clip.transitionOut
      return tr && tr.duration > 0.001 ? { type: tr.type, duration: tr.duration } : null
    }
    if (menu.kind === 'junction' && menu.clipIds) {
      const b = findClip(s.project, menu.clipIds[1])
      const tr = b?.clip.transitionIn
      return tr && tr.duration > 0.001 ? { type: tr.type, duration: tr.duration } : null
    }
    return null
  })
  if (menu.kind === 'transition') {
    const pick = (type: string) => {
      useEditor.getState().setTransition(menu.clipId!, type)
      onClose()
    }
    return (
      <CtxMenu x={menu.x} y={menu.y} className="trans-menu">
        <div className="ctx-title dim">{t('transition')}</div>
        {TRANSITIONS.map((tr) => (
          <button key={tr.id} onClick={() => pick(tr.id)}>
            <span className="ctx-check">
              {transCur === tr.id && <Icon name="check" size={13} />}
            </span>
            {t(tr.nameKey)}
          </button>
        ))}
        <button onClick={() => pick('none')}>
          <span className="ctx-check">
            {transCur === 'none' && <Icon name="check" size={13} />}
          </span>
          {t('trNone')}
        </button>
      </CtxMenu>
    )
  }
  if (menu.kind === 'fade' && menu.clipId) {
    // K2: the shape of this end's audio fade — also of the crossfade over an overlap
    const key = menu.edge === 'in' ? 'fadeInCurve' : 'fadeOutCurve'
    const cur = findClip(useEditor.getState().project, menu.clipId)?.clip[key] ?? 'lin'
    const pick = (c: FadeCurve) => {
      const st = useEditor.getState()
      st.pushHistory('hFade')
      st.updateClip(menu.clipId!, { [key]: c })
      onClose()
    }
    return (
      <CtxMenu x={menu.x} y={menu.y} className="trans-menu">
        <div className="ctx-title dim">{t(key)}</div>
        {FADE_CURVES.map((c) => (
          <button key={c} data-curve={c} onClick={() => pick(c)}>
            <span className="ctx-check">{cur === c && <Icon name="check" size={13} />}</span>
            {t(FADE_CURVE_NAME[c])}
          </button>
        ))}
      </CtxMenu>
    )
  }
  if (menu.kind === 'edge' || menu.kind === 'junction') {
    const apply = (type: string | null, duration?: number) => {
      const st = useEditor.getState()
      if (menu.kind === 'junction' && menu.clipIds) {
        st.setEdgeTransitions([
          { clipId: menu.clipIds[0], edge: 'out', type, duration },
          { clipId: menu.clipIds[1], edge: 'in', type, duration }
        ])
      } else if (menu.clipId && menu.edge) {
        st.setEdgeTransitions([{ clipId: menu.clipId, edge: menu.edge, type, duration }])
      }
    }
    const title =
      menu.kind === 'junction' ? t('edgeJunction') : menu.edge === 'in' ? t('edgeIn') : t('edgeOut')
    return (
      <CtxMenu x={menu.x} y={menu.y} className="trans-menu">
        <div className="ctx-title dim">{title}</div>
        {EDGE_TRANSITIONS.map((ed) => (
          <button key={ed.id} onClick={() => { apply(ed.id); onClose() }}>
            <span className="ctx-check">
              {edgeCur?.type === ed.id && <Icon name="check" size={13} />}
            </span>
            {t(ed.nameKey)}
          </button>
        ))}
        <div className="ctx-dur-row">
          <span className="dim">{t('edgeDuration')}</span>
          {[0.3, 0.5, 1].map((d) => (
            <button
              key={d}
              className={Math.abs((edgeCur?.duration ?? setting<number>('editing.edgeDuration')) - d) < 0.01 ? 'dur-on' : ''}
              onClick={() => {
                if (edgeCur) apply(edgeCur.type, d)
                onClose()
              }}
            >
              {d}s
            </button>
          ))}
        </div>
        {edgeCur && (
          <button className="danger" onClick={() => { apply(null); onClose() }}>
            {t('edNone')}
          </button>
        )}
      </CtxMenu>
    )
  }
  return (
    <CtxMenu x={menu.x} y={menu.y}>
      {menu.kind === 'track' ? (
        <>
          <button
            onClick={() => {
              useEditor.getState().addTrackNear(menu.trackId!)
              onClose()
            }}
          >
            {menu.trackKind === 'video' ? t('addVideoTrack') : t('addAudioTrack')}
          </button>
          <Swatches
            value={useEditor.getState().project.tracks.find((x) => x.id === menu.trackId)?.color}
            onPick={(color) => {
              const st = useEditor.getState()
              st.pushHistory('hTrack')
              st.updateTrack(menu.trackId!, { color })
              onClose()
            }}
          />
          <button
            className="danger"
            onClick={() => {
              const st = useEditor.getState()
              const tr = st.project.tracks.find((x) => x.id === menu.trackId)
              const n = tr ? trackDeleteAsks(tr, useSettings.getState().confirmDelete) : 0
              if (n) useTlAsk.setState({ track: { id: tr!.id, n } })
              else st.removeTrack(menu.trackId!)
              onClose()
            }}
          >
            {t('deleteTrack')}
          </button>
        </>
      ) : (
        <>
          {menu.linked ? (
            <button
              onClick={() => {
                const st = useEditor.getState()
                st.select(withLinked(st.project, [menu.clipId!]))
                st.toggleLinkSelection()
                onClose()
              }}
            >
              {t('unlinkAV')}
            </button>
          ) : (
            selCount === 2 && (
              <button
                onClick={() => {
                  useEditor.getState().toggleLinkSelection()
                  onClose()
                }}
              >
                {t('linkAV')}
              </button>
            )
          )}
          <button
            onClick={() => {
              const st = useEditor.getState()
              st.setAnimClip(menu.clipId!)
              onClose()
            }}
          >
            {t('animTab')}…
          </button>
          {speedGroup(menu.clipId!).length > 0 && <SpeedDial clipId={menu.clipId!} />}
          <button
            data-act="clip-toggle-enable"
            onClick={() => {
              const st = useEditor.getState()
              if (!st.selection.includes(menu.clipId!)) st.select(withLinked(st.project, [menu.clipId!]))
              st.toggleDisabled()
              onClose()
            }}
          >
            {findClip(useEditor.getState().project, menu.clipId!)?.clip.disabled ? t('clipEnable') : t('clipDisable')}
          </button>
          {(() => {
            // F4: «Заполнить кадр» — cover on the clicked clip (the selection, when it is in it); again → contain
            const p = useEditor.getState().project
            const f = findClip(p, menu.clipId!)
            if (!f || f.track.kind !== 'video') return null
            const filled = f.clip.fit === 'cover'
            return (
              <button
                data-act="clip-fill-frame"
                onClick={() => {
                  const st = useEditor.getState()
                  const ids = (st.selection.includes(menu.clipId!) ? st.selection : [menu.clipId!])
                    .filter((id) => findClip(st.project, id)?.track.kind === 'video')
                  st.pushHistory('hEdit')
                  st.setClipProps(ids, { fit: filled ? undefined : 'cover' })
                  onClose()
                }}
              >
                {filled ? t('fitFrame') : t('fillFrame')}
              </button>
            )
          })()}
          <Swatches
            value={findClip(useEditor.getState().project, menu.clipId!)?.clip.color}
            onPick={(color) => {
              const st = useEditor.getState()
              const ids = st.selection.includes(menu.clipId!) ? st.selection : [menu.clipId!]
              st.pushHistory('hEdit')
              st.setClipProps(ids, { color })
              onClose()
            }}
          />
          {(() => {
            const p = useEditor.getState().project
            const f = findClip(p, menu.clipId!)
            const a = f?.clip.assetId ? p.assets.find((x) => x.id === f.clip.assetId) : null
            if (!a || a.kind === 'image' || !a.duration) return null
            const busy = useReverseUi.getState().busy[menu.clipId!]
            if (busy !== undefined) {
              return (
                <button disabled>
                  <Spinner size={14} /> {t('reversing')} {Math.round(busy * 100)}%
                </button>
              )
            }
            return (
              <button
                onClick={() => {
                  void reverseClip(menu.clipId!)
                  onClose()
                }}
              >
                {a.reverseOf ? t('unreverse') : t('reverse')}
              </button>
            )
          })()}
          {(() => {
            const p = useEditor.getState().project
            const f = findClip(p, menu.clipId!)
            const a = f?.clip.assetId ? p.assets.find((x) => x.id === f.clip.assetId) : null
            if (!a?.hasAudio) return null
            if (useNormalizeUi.getState().busy[menu.clipId!]) {
              return <button disabled><Spinner size={14} /> {t('normalizing')}…</button>
            }
            return (
              <button
                onClick={() => {
                  normalizeClip(menu.clipId!).catch((err) =>
                    logWarn(tr('lgVolume'), tr('lmNormFail'), err)
                  )
                  onClose()
                }}
              >
                {t('normalize')}
              </button>
            )
          })()}
          {duckTargets(menu.clipId!).includes(menu.clipId!) && (
            <button data-act="clip-duck" onClick={() => { void duckHere(menu.clipId!); onClose() }}>
              {t('actDuck')}
            </button>
          )}
          <button
            className="danger"
            onClick={() => {
              const st = useEditor.getState()
              // a right-click inside a group deletes the group, not one clip
              if (!st.selection.includes(menu.clipId!)) {
                st.select(withLinked(st.project, [menu.clipId!]))
              }
              st.deleteSelection()
              onClose()
            }}
          >
            {t('clipDelete')}
          </button>
          <button
            className="danger"
            onClick={() => {
              const st = useEditor.getState()
              st.rippleDelete(st.selection.includes(menu.clipId!) ? st.selection : [menu.clipId!])
              onClose()
            }}
          >
            {t('actRippleDelete')}
          </button>
        </>
      )}
    </CtxMenu>
  )
}

function RulerRow({ contentW, view }: { contentW: number; view: ViewWindow }) {
  const zoom = useEditor((s) => s.zoom)
  const step = niceStep(zoom)
  // labels for the visible stretch only (half a screen either side): the
  // whole length was one element per step — tens of thousands zoomed in on a
  // long project. The grid lines are the CSS background and cost nothing.
  const pad = (view.end - view.start) * 0.5
  const from = Math.max(0, Math.floor((view.start - pad) / step))
  const to = Math.min(Math.ceil(contentW / (step * zoom)), Math.ceil((view.end + pad) / step))
  const ticks = useMemo(() => {
    const out: number[] = []
    for (let x = from; x < to; x++) out.push(x * step)
    return out
  }, [step, from, to])

  return (
    <div className="tl-row" style={{ height: RULER_H }}>
      <div className="tl-head" style={{ width: HEADER_W, height: RULER_H }} />
      <div
        className="ruler"
        style={{ width: contentW, backgroundSize: `${step * zoom}px 100%` }}
        onPointerDown={(e) => startScrubOrRange(e, e.currentTarget)}
      >
        {ticks.map((tt) => (
          <span key={tt} style={{ left: tt * zoom }}>{tickLabel(tt)}</span>
        ))}
      </div>
    </div>
  )
}

function Playhead() {
  const playhead = useEditor((s) => s.playhead)
  const zoom = useEditor((s) => s.zoom)
  return <div className="playhead" style={{ left: HEADER_W + playhead * zoom }} />
}

/** Track-independent user markers: M adds one at the playhead, the flag
    drags along the timeline (snapping), right-click opens Rename / Delete. */
function Markers() {
  const all = useEditor((s) => s.project.markers)
  const zoom = useEditor((s) => s.zoom)
  const t = useT()
  // the analysis' markers are drawn by BeatLines; only the user's own get a flag
  const markers = useMemo(() => (all ?? []).filter((m) => !m.kind), [all])
  if (!markers.length) return null
  return (
    <>
      {markers.map((m) => (
        <div
          key={m.id}
          className="tl-marker"
          style={{ left: HEADER_W + m.time * zoom }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            const st = useEditor.getState()
            st.pushHistory('hMarkerMove')
            // not its own spot: markers are snap targets now, and a marker
            // would otherwise stick to where it started
            const points = snapPoints(st.project, m.id, st.playhead)
            const startX = e.clientX
            const t0 = m.time
            windowDrag(e, (_dx, ev) => {
              const s = useEditor.getState()
              s.moveMarker(m.id, snapTime(t0 + (ev.clientX - startX) / s.zoom, points, s.zoom))
            })
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            useTlAsk.setState({ marker: { id: m.id, x: e.clientX, y: e.clientY } })
          }}
        >
          <span className="tl-marker-flag" title={t('markerTip')}>{m.label}</span>
        </div>
      ))}
    </>
  )
}

/**
 * Detected beats: a thin pink line each; with a bar analysis the first beat
 * of every bar is a heavier line and carries its bar number on the ruler
 * (numbers thin out when bars crowd). Only the visible stretch is drawn, and
 * when beats crowd closer than 5 px only the downbeats (or, without bars, the
 * accents) are — at that zoom every beat would just paint the lanes pink.
 * Sections of the song are a labelled band along the bottom of the ruler,
 * pauses a light hatch through the lanes. All passive: they are snap targets,
 * not handles.
 */
function BeatLines({ view }: { view: ViewWindow }) {
  const t = useT()
  const markers = useEditor((s) => s.project.markers)
  const zoom = useEditor((s) => s.zoom)
  const beats = useMemo(() => (markers ?? []).filter((m) => m.kind === 'beat'), [markers])
  const spans = useMemo(() => (markers ?? []).filter((m) => m.kind === 'section' || m.kind === 'pause'), [markers])
  const scenes = useMemo(() => (markers ?? []).filter((m) => m.kind === 'scene'), [markers])
  if (!beats.length && !spans.length && !scenes.length) return null
  const margin = 50 / zoom
  const visible = beats.filter((b) => b.time >= view.start - margin && b.time <= view.end + margin)
  const hasBars = beats.some((b) => b.beatInBar !== undefined)
  const isDown = (b: TimelineMarker) => b.beatInBar === 1 && (b.bar ?? 0) > 0
  let gap = Infinity
  for (let i = 1; i < beats.length; i++) gap = Math.min(gap, beats[i].time - beats[i - 1].time)
  const shown = gap * zoom < 5 ? visible.filter((b) => (hasBars ? isDown(b) : b.strong)) : visible
  // bar numbers: every bar when there is room, else every 2nd / 4th / 8th / 16th
  const downs = beats.filter(isDown)
  let barGap = Infinity
  for (let i = 1; i < downs.length; i++) barGap = Math.min(barGap, downs[i].time - downs[i - 1].time)
  const every = [1, 2, 4, 8, 16, 32].find((n) => barGap * n * zoom >= 26) ?? 64
  const inView = (m: TimelineMarker) => (m.end ?? m.time) >= view.start - margin && m.time <= view.end + margin
  return (
    <>
      {spans.filter(inView).map((m) => m.kind === 'section'
        ? (
          <div key={m.id} className={`tl-section sec-${m.section ?? 'verse'}`}
               style={{ left: HEADER_W + m.time * zoom, width: Math.max(1, ((m.end ?? m.time) - m.time) * zoom) }}
               title={`${t(`section_${m.section ?? 'verse'}` as TKey)} · ${t('sectionEnergy')} ${Math.round((m.energy ?? 0) * 100)}%`}>
            <span>{t(`section_${m.section ?? 'verse'}` as TKey)}</span>
          </div>
          )
        : (
          <div key={m.id} className="tl-pause" title={t('musicPause')}
               style={{ left: HEADER_W + m.time * zoom, width: Math.max(2, ((m.end ?? m.time) - m.time) * zoom) }} />
          ))}
      {scenes.filter(inView).map((m) => (
        <div key={m.id} className="tl-scene" title={t('sceneCut')} style={{ left: HEADER_W + m.time * zoom }} />
      ))}
      {shown.map((b) => (
        <div key={b.id}
             className={`tl-beat${hasBars ? (isDown(b) ? ' down' : '') : b.strong ? ' strong' : ''}`}
             style={{ left: HEADER_W + b.time * zoom }}>
          {isDown(b) && (b.bar! - 1) % every === 0 && <span className="tl-bar-num">{b.bar}</span>}
        </div>
      ))}
    </>
  )
}

/** «Проверка» — opens the checks dialog (src/engine/checks.ts). */
function ChecksButton() {
  const t = useT()
  const running = useChecksUi((s) => s.running)
  const hasFragments = useEditor((s) => s.project.tracks.some((tr) => tr.clips.some((c) => c.kind === 'remotion')))
  if (!hasFragments) return null
  return (
    <button data-act="checks" title={t('checksButtonHint')} onClick={() => useChecksUi.getState().setOpen(true)}>
      {running ? <Spinner /> : <Icon name="check" />} {t('checksButton')}
    </button>
  )
}

/**
 * What a fragment declared it does (fragment.inspect events), as ticks along
 * the bottom of its clip — tall for a big event, short for a small one — and a
 * warning mark where the last check found a problem. From the last «Проверка»;
 * passive like the beats (a drag on the clip goes through).
 */
function EventTicks({ track }: { track: Track }) {
  const zoom = useEditor((s) => s.zoom)
  const result = useChecksUi((s) => s.result)
  if (!result) return null
  const evs = result.events.filter((e) => e.trackId === track.id)
  const ids = new Set(track.clips.map((c) => c.id))
  const probs = result.issues.filter((i) => i.level === 'warn' && i.clipId && ids.has(i.clipId))
  if (!evs.length && !probs.length) return null
  return (
    <>
      {evs.map((e, k) => (
        <div key={`e${k}`} className={`tl-event ${e.kind}`} style={{ left: e.t * zoom }} />
      ))}
      {probs.map((p, k) => (
        <div key={`p${k}`} className="tl-event-warn" title={p.message}
             style={{ left: p.t * zoom, width: Math.max(3, ((p.end ?? p.t) - p.t) * zoom) }} />
      ))}
    </>
  )
}

const SNAP_TARGETS = [
  ['editing.snapEdges', 'snapEdges'],
  ['editing.snapPlayhead', 'snapPlayhead'],
  ['editing.snapMarkers', 'snapMarkers'],
  ['editing.snapBeats', 'snapBeatsT']
] as const

/** «Биты» — opens the beat dialog; the magnet next to it is the timeline's
    snapping (N), and its right-click menu picks what snaps. */
function BeatButtons() {
  const t = useT()
  const busy = useBeatsUi((s) => s.busy)
  useSettings((s) => s.snap) // re-render on any settings change
  const snap = setting<boolean>('editing.snap')
  const on = SNAP_TARGETS.map(([k]) => setting<boolean>(k))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    window.addEventListener('pointerdown', off)
    return () => window.removeEventListener('pointerdown', off)
  }, [menu])
  return (
    <>
      <button data-act="beats" title={t('beatsButtonHint')}
              onClick={() => useBeatsUi.getState().setOpen(true)}>
        {busy ? <Spinner /> : <Icon name="beat" />} {t('beatsButton')}
      </button>
      <button className="icon-only beat-snap" data-act="tl-snap"
              title={t('snapHint')} aria-label={t('actSnap')} aria-pressed={snap}
              onClick={() => useSettings.getState().set('editing.snap', !snap)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}>
        <Icon name="magnet" />
      </button>
      {menu && (
        <CtxMenu x={menu.x} y={menu.y}>
          <div className="ctx-title dim">{t('snapTargets')}</div>
          {SNAP_TARGETS.map(([k, label], i) => (
            <button key={k} data-act={`snap-${label}`} role="menuitemcheckbox" aria-checked={on[i]}
                    onClick={() => useSettings.getState().set(k, !on[i])}>
              <span className="ctx-check">{on[i] && <Icon name="check" size={13} />}</span>
              {t(label)}
            </button>
          ))}
        </CtxMenu>
      )}
    </>
  )
}

/** Yellow marker mirroring a keyframe being dragged in a mini-timeline. */
function KfMarker() {
  const kfMarker = useEditor((s) => s.kfMarker)
  const zoom = useEditor((s) => s.zoom)
  if (kfMarker === null) return null
  return (
    <div className="kf-marker" style={{ left: HEADER_W + kfMarker * zoom }}>
      <div className="kf-marker-diamond" />
    </div>
  )
}

function RangeOverlay() {
  const range = useEditor((s) => s.range)
  const zoom = useEditor((s) => s.zoom)
  if (!range) return null

  const dragEdge = (edge: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    const points = snapPoints(st.project, '', st.playhead)
    const overlay = e.currentTarget.parentElement as HTMLElement
    const contentLeft = overlay.parentElement!.getBoundingClientRect().left
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const r = s.range
      if (!r) return
      const time = snapTime(
        Math.max(0, (ev.clientX - contentLeft - HEADER_W) / s.zoom),
        points,
        s.zoom
      )
      const next = edge === 'start' ? { start: time, end: r.end } : { start: r.start, end: time }
      if (next.end < next.start) [next.start, next.end] = [next.end, next.start]
      s.setRange(next)
    })
  }

  return (
    <div
      className="range-overlay"
      style={{ left: HEADER_W + range.start * zoom, width: (range.end - range.start) * zoom }}
    >
      <div className="range-edge left" onPointerDown={dragEdge('start')} />
      <div className="range-edge right" onPointerDown={dragEdge('end')} />
      <button
        className="range-clear"
        title="Esc"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useEditor.getState().setRange(null)}
      >
        ×
      </button>
    </div>
  )
}

interface ViewWindow {
  start: number
  end: number
}

// groups a burst of wheel notches over one gain slider into a single undo entry
const gainWheelMark = { id: '', ts: 0 }

// Round multipliers the speed drag and the speed dial snap to (range in
// speedLayout.ts). Preview playback is clamped to Chromium's 0.0625–16×
// element range and relies on resync seeks beyond it; export is exact at
// any speed.
const SPEED_SNAPS = [
  0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
  12, 16, 20, 25, 32, 50, 64, 100
]
const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4]

/** What a speed change applies to: the whole selection when the clip is part
    of it, else the clip alone — timed media only, locked tracks left out. */
function speedGroup(clipId: string): SpeedItem[] {
  const { project: p, selection } = useEditor.getState()
  const ids = selection.includes(clipId) ? selection : [clipId]
  const out: SpeedItem[] = []
  for (const id of ids) {
    const f = findClip(p, id)
    const a = f?.clip.assetId ? p.assets.find((x) => x.id === f.clip.assetId) : null
    if (!f || f.track.locked || !a || a.kind === 'image') continue
    out.push({
      id, trackId: f.track.id, start: f.clip.start, duration: f.clip.duration, speed: f.clip.speed || 1
    })
  }
  return out
}

/** Pixels of jog-strip drag per ×4 of speed. */
const JOG_PX = 160

/** The speed jog strip in a clip's context menu. Dragging it sideways scales
    the group's speeds together (JOG_PX to the right = ×4 faster); the presets
    and the typed number set every clip to that value. The group keeps its start. */
function SpeedDial({ clipId }: { clipId: string }) {
  const t = useT()
  const speed = useEditor((s) => findClip(s.project, clipId)?.clip.speed || 1)
  const [text, setText] = useState<string | null>(null)

  const setAll = (v: number) => {
    if (!(v > 0)) return
    const s = useEditor.getState()
    s.pushHistory('hSpeed')
    s.setClipSpeeds(layoutSpeeds(speedGroup(clipId), () => v, 'start'))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    useEditor.getState().pushHistory('hSpeed')
    const items = speedGroup(clipId)
    const base = items.find((i) => i.id === clipId)?.speed ?? speed
    const x0 = e.clientX
    const move = (ev: PointerEvent) => {
      let v = base * 4 ** ((ev.clientX - x0) / JOG_PX)
      const snap = SPEED_SNAPS.find((c) => Math.abs(Math.log2(v / c)) < 0.04)
      if (snap) v = snap
      v = Math.min(SPEED_MAX, Math.max(SPEED_MIN, v))
      useEditor.getState().setClipSpeeds(layoutSpeeds(items, (it) => (it.speed * v) / base, 'start'))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('lostpointercapture', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('lostpointercapture', up)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const up = e.key === 'ArrowUp' || e.key === 'ArrowRight'
    if (!up && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = up
      ? SPEED_SNAPS.find((c) => c > speed + 1e-6)
      : [...SPEED_SNAPS].reverse().find((c) => c < speed - 1e-6)
    if (next) setAll(next)
  }

  // the ticks ride along with the value, like a physical jog wheel's rim
  const pos = `${(Math.log(speed) / Math.log(4)) * JOG_PX}px 0`
  return (
    <div className="speed-dial">
      <div className="ctx-title">{t('speed')}</div>
      <input
        className="speed-dial-value"
        aria-label={t('speed')}
        value={text ?? `×${+speed.toFixed(2)}`}
        onFocus={(e) => {
          setText(`${+speed.toFixed(2)}`)
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            setAll(parseFloat((text ?? '').replace(',', '.').replace(/^[×x]/i, '')))
            e.currentTarget.blur()
          } else if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <div
        className="speed-jog"
        role="slider"
        tabIndex={0}
        title={t('speedDialHint')}
        aria-label={t('speed')}
        aria-valuemin={SPEED_MIN}
        aria-valuemax={SPEED_MAX}
        aria-valuenow={speed}
        aria-valuetext={`×${+speed.toFixed(2)}`}
        style={{ backgroundPosition: `${pos}, ${pos}` }}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="ctx-dur-row">
        {SPEED_PRESETS.map((v) => (
          <button key={v} className={Math.abs(speed - v) < 1e-6 ? 'dur-on' : ''} onClick={() => setAll(v)}>
            ×{v}
          </button>
        ))}
      </div>
    </div>
  )
}

function TrackRow({
  track, trackH, contentW, view, onMenu
}: {
  track: Track
  trackH: number
  contentW: number
  view: ViewWindow
  onMenu: (m: MenuState) => void
}) {
  const t = useT()
  const reorder = useRef<{ pushed: boolean } | null>(null)
  const gainRef = useRef<HTMLInputElement>(null)
  const [naming, setNaming] = useState(false)
  // Only what is near the visible stretch goes into the DOM (half a screen on
  // either side, so a scroll finds it drawn), plus the selection — a clip being
  // dragged must not unmount under the pointer. Everything was rendered before:
  // 1124 clips and 9400 nodes on a real 19-minute project, re-rendered on every
  // scroll and every zoom step.
  const selection = useEditor((s) => s.selection)
  // Zoomed out so that the whole project is a few screens, culling costs more
  // than it saves: every scroll would mount and unmount clips at the edges
  // (measured: worse than rendering them all, which memo() makes cheap).
  const span = view.end - view.start
  const pad = contentW <= 4 * span * useEditor.getState().zoom ? Infinity : Math.max(2, span * 0.5)
  const near = { start: view.start - pad, end: view.end + pad }
  const shown = useMemo(() => {
    const sel = new Set(selection)
    return track.clips.filter((c) => (c.start < near.end && c.start + c.duration > near.start) || sel.has(c.id))
  }, [track.clips, selection, near.start, near.end])

  // wheel over the volume/opacity slider: precise ±1% per notch (a drag can't
  // hit exact values); consecutive notches merge into one history entry
  useEffect(() => {
    const el = gainRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation() // the timeline zoom listener must not see this
      const st = useEditor.getState()
      const tr = st.project.tracks.find((x) => x.id === track.id)
      if (!tr) return
      const now = Date.now()
      if (gainWheelMark.id !== track.id || now - gainWheelMark.ts > 1000) st.pushHistory('hEdit')
      gainWheelMark.id = track.id
      gainWheelMark.ts = now
      const max = tr.kind === 'audio' ? 2 : 1
      const next = Math.round((tr.gain + (e.deltaY < 0 ? 0.01 : -0.01)) * 100) / 100
      st.updateTrack(track.id, { gain: Math.min(max, Math.max(0, next)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [track.id, trackH < 46]) // the slider row mounts only when tall enough

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const time = Math.max(0, (e.clientX - rect.left) / useEditor.getState().zoom)
    const assetId = e.dataTransfer.getData('kadr/asset')
    if (assetId) {
      e.preventDefault()
      useEditor.getState().insertClipFromAsset(assetId, track.id, time, e.shiftKey) // Shift inserts
      return
    }
    // files (or browser image URLs / raw image data) dropped from outside:
    // import into the bin AND lay them out back-to-back from the drop point
    // (audio goes to an audio track; remote URLs are downloaded first)
    const payload = dropPayload(e)
    if (dropUsable(payload)) {
      e.preventDefault()
      void importDrop(payload, { trackId: track.id, at: time })
    }
  }

  // Empty space on a lane is where clips are SELECTED — the playhead is
  // dragged on the ruler above. Shift still drags the in/out range (the
  // transcribe / neon-wave / defect-mark gesture), so nothing is taken away.
  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    if (e.shiftKey) {
      startScrubOrRange(e, e.currentTarget)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const time = (e.clientX - rect.left) / useEditor.getState().zoom
    if (e.ctrlKey) {
      startBand(e, e.currentTarget, () => useEditor.getState().closeGapAt(track.id, time))
      return
    }
    startBand(e, e.currentTarget, () => {
      const s = useEditor.getState()
      s.select([])
      s.setPlayhead(time)
    })
  }

  // drag the header vertically to reorder tracks
  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // closest, not tagName: a press on a button's ICON (svg/path) used to start
    // a reorder, whose pointer capture then took the click from the button
    if ((e.target as HTMLElement).closest('button, input') || e.button !== 0) return
    reorder.current = { pushed: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = reorder.current
    if (!r) return
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const overId = (el as HTMLElement).dataset?.trackhead
      if (!overId || overId === track.id) continue
      const st = useEditor.getState()
      const to = st.project.tracks.findIndex((tr) => tr.id === overId)
      if (to >= 0) {
        if (!r.pushed) {
          st.pushHistory('hTrack')
          r.pushed = true
        }
        st.moveTrack(track.id, to)
      }
      break
    }
  }
  const onHeadUp = () => {
    reorder.current = null
  }

  return (
    <div className="tl-row" style={{ height: trackH }}>
      <div
        className={`tl-head track-head ${track.kind}`}
        style={{
          width: HEADER_W, height: trackH,
          ...(track.color ? { boxShadow: `inset 3px 0 0 var(--label-${track.color})` } : {})
        }}
        data-trackhead={track.id}
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu({ x: e.clientX, y: e.clientY, kind: 'track', trackId: track.id, trackKind: track.kind })
        }}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button, input')) setNaming(true) }}
      >
        <div className="track-head-row">
          {naming ? (
            <input
              className="track-name-edit"
              data-act="track-name"
              aria-label={t('trackRenameHint')}
              autoFocus
              defaultValue={track.name}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim()
                setNaming(false)
                if (!name || name === track.name) return
                const st = useEditor.getState()
                st.pushHistory('hTrack')
                st.updateTrack(track.id, { name })
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') { e.currentTarget.value = track.name; e.currentTarget.blur() }
              }}
            />
          ) : (
            <span className="track-name" title={t('trackRenameHint')}>{track.name}</span>
          )}
          {track.kind === 'video' && (
            <button
              className={track.motion ? 'toggled-on' : ''}
              data-act="track-motion"
              title={t('trackMotion')}
              aria-label={t('trackMotion')}
              onClick={() => useEditor.getState().setMotionTrack(track.id)}
            >
              <Icon name="move" size={13} />
            </button>
          )}
          <button
            className={track.muted ? 'toggled' : ''}
            data-act="mute"
            title={t('mute')}
            aria-label={t('mute')}
            aria-pressed={track.muted}
            onClick={() => toggleTrack(track.id, 'muted')}
          >
            <Icon name={track.muted ? 'mute' : 'volume'} size={13} />
          </button>
          <button
            className={track.solo ? 'toggled-on' : ''}
            data-act="solo"
            title={t('solo')}
            aria-label={t('solo')}
            aria-pressed={!!track.solo}
            onClick={() => toggleTrack(track.id, 'solo')}
          >
            <Icon name="solo" size={13} />
          </button>
          <button
            className={track.locked ? 'toggled' : ''}
            data-act="lock"
            title={t('lock')}
            aria-label={t('lock')}
            aria-pressed={track.locked}
            onClick={() => useEditor.getState().updateTrack(track.id, { locked: !track.locked })}
          >
            <Icon name={track.locked ? 'lock' : 'unlock'} size={13} />
          </button>
        </div>
        {trackH >= 46 && (
          <div className="track-gain-row">
            <input
              ref={gainRef}
              className="track-gain"
              type="range"
              min={0}
              max={track.kind === 'audio' ? 2 : 1}
              step={0.01}
              value={track.gain}
              title={track.kind === 'audio' ? t('volume') : t('opacity')}
              aria-label={track.kind === 'audio' ? t('volume') : t('opacity')}
              onPointerDown={(e) => {
                e.stopPropagation()
                useEditor.getState().pushHistory('hEdit')
              }}
              onChange={(e) =>
                useEditor.getState().updateTrack(track.id, { gain: Number(e.target.value) })
              }
            />
            {track.kind === 'audio'
              ? <span className="gain-pct dim" title={t('thGainDb')}>{dbText(gainToDb(track.gain))}</span>
              : <span className="gain-pct dim">{Math.round(track.gain * 100)}%</span>}
          </div>
        )}
      </div>
      <div
        className={`lane ${track.kind}`}
        data-lane={track.id}
        style={{ width: contentW, height: trackH }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('kadr/asset') || dragHasMedia(e)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onDrop}
        onPointerDown={onLaneDown}
      >
        {shown.map((c) => {
          // a clip off screen (beyond the waveform's 64 px margin) gets a
          // constant "nothing visible" — otherwise every clip right of the view
          // was handed a new view.end on every zoom step and re-rendered
          const m = 64 / useEditor.getState().zoom
          const on = c.start + c.duration > view.start - m && c.start < view.end + m
          return (
            <ClipView key={c.id} clip={c} track={track} laneHeight={trackH} onMenu={onMenu}
                      visStart={on ? Math.max(c.start, view.start) : Infinity}
                      visEnd={on ? Math.min(c.start + c.duration, view.end) : Infinity} />
          )
        })}
        <TransitionZones track={track} view={near} onMenu={onMenu} />
        <DefectBands track={track} view={near} />
        <EventTicks track={track} />
      </div>
    </div>
  )
}

/** Run the detector, and mark a defect the detector missed.
 *
 * The manual mark deliberately reuses the in/out range (Shift+drag) instead of
 * a Ctrl-drag on the clip: Ctrl+drag over a clip body is how clips are handled,
 * and stealing it would break moving them. Without a range the playhead does.
 */
function DefectButtons() {
  const t = useT()
  const hasRuns = useEditor((s) => (s.project.voiceRuns?.length ?? 0) > 0)
  const hidden = useVoiceUi((s) => s.hidden)
  const [busy, setBusy] = useState(false)
  if (!hasRuns) return null

  /** Mark from the in/out range, or from the playhead when there is none. */
  const mark = async (kind: 'defect' | 'redo') => {
    const s = useEditor.getState()
    const run = targetRun()
    if (!run) return
    const r = s.range
    const a = r ? r.start : s.playhead
    const b = r ? r.end : s.playhead + 0.15
    // range/playhead are TIMELINE seconds; a defect lives in source time
    const found = s.project.tracks.flatMap((tr) => tr.clips)
      .find((c) => c.assetId === run.assetId && a < c.start + c.duration && b > c.start)
    if (!found) return
    setBusy(true)
    try {
      await addUserDefect(run.assetId, projectToSrc(found, a), projectToSrc(found, b), kind)
    } catch (e) {
      useVoiceUi.setState({ error: String((e as Error)?.message ?? e) })
      useDefectsUi.getState().setOpen(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button data-act="defects" title={t('dfButtonHint')}
              onClick={() => useDefectsUi.getState().setOpen(true)}>
        <Icon name="target" /> {t('dfButton')}
      </button>
      <button data-act="mark-defect" title={`${t('dfUserHint')} · ${t('dfDragHint')}`}
              disabled={busy} onClick={() => mark('defect')}>
        <Icon name="pencil" /> {t('dfUserAdd')}
      </button>
      <button data-act="mark-redo" title={t('dfRedoHint')} disabled={busy}
              onClick={() => mark('redo')}>
        <Icon name="again" /> {t('dfRedoAdd')}
      </button>
      <button className="icon-only" data-act="hide-defects"
              title={hidden ? t('dfShow') : t('dfHide')}
              aria-label={hidden ? t('dfShow') : t('dfHide')}
              aria-pressed={hidden}
              onClick={() => setDefectsHidden(!hidden)}>
        <Icon name={hidden ? 'eyeOff' : 'eye'} />
      </button>
    </>
  )
}

/** Silence removal (card I5): find, mark all, remove the confirmed ones (one undo), clear. */
function SilenceButtons() {
  const t = useT()
  const { items, busy, none } = useSilences()
  // a confirmed 'short' (card I11) goes to «Экспортировать выбранные», not here
  const confirmed = items.filter((x) => x.state === 'confirmed' && x.kind !== 'short').length
  return (
    <>
      <button data-act="silences" title={t('silButtonHint')} disabled={busy} onClick={() => void findSilencesHere()}>
        {busy ? <Spinner size={14} /> : <Icon name="mute" />} {t('silButton')}
      </button>
      {none && <span className="dim">{t('silNone')}</span>}
      {items.length > 0 && (
        <>
          <button data-act="silences-confirm-all" onClick={confirmAllSilences}>
            <Icon name="check" /> {t('silConfirmAll')}
          </button>
          <button data-act="silences-apply" disabled={!confirmed} onClick={() => applySilences('confirmed')}>
            <Icon name="trash" /> {trf('silApply', { n: confirmed })}
          </button>
          <button className="icon-only" data-act="silences-clear" title={t('silClear')} aria-label={t('silClear')}
                  onClick={clearSilences}>
            <Icon name="close" />
          </button>
        </>
      )}
    </>
  )
}

/**
 * Found pauses as full-height bands over every track (a cut goes through all of
 * them), each with the defect flag on the ruler: click marks it for removal
 * (Alt unmarks), right click keeps it, double click plays it with a second of
 * context. Deciding is no edit — only «Удалить подтверждённые» is.
 */
function SilenceFlags() {
  const items = useSilences((s) => s.items)
  const zoom = useEditor((s) => s.zoom)
  if (!items.length) return null
  const cls = (x: Silence) => (x.state === 'proposed' ? '' : ` ${x.state}`)
  // the agent's proposals (kadr_propose, card I8) ride the same flags, with their reason
  const tip = (x: Silence) => {
    const len = (x.end - x.start).toFixed(2)
    return x.reason ? trf(x.kind === 'short' ? 'shortTip' : 'propTip', { reason: x.reason, len }) : trf('silTip', { len })
  }
  return (
    <>
      {items.map((x) => (
        <div key={x.id}>
          <div className={`adefect silence${cls(x)}`} data-silence={x.id}
               style={{ left: HEADER_W + x.start * zoom, width: Math.max(3, (x.end - x.start) * zoom) }} />
          <button
            className={`adefect-flag${cls(x)}`}
            data-silence-flag={x.id}
            style={{ left: HEADER_W + x.start * zoom }}
            title={tip(x)}
            aria-label={tip(x)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSilenceState(x.id, e.altKey ? 'proposed' : 'confirmed') }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSilenceState(x.id, 'rejected') }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              const s = useEditor.getState()
              s.setRange({ start: Math.max(0, x.start - 1), end: x.end + 1 })
              s.playInOut()
            }}
          >
            {x.state === 'confirmed' ? <Icon name="check" size={10} strokeWidth={3} /> : <Icon name={x.reason ? 'bot' : 'mute'} size={10} strokeWidth={2.5} />}
          </button>
        </div>
      ))}
    </>
  )
}

/** ttsqc's classes, for the flag. 'user' is ours, for a hand-placed mark. */
const DEFECT_LABEL: Record<string, TKey> = {
  insert: 'dfInsert', corrupt: 'dfCorrupt', missing: 'dfMissing',
  truncation: 'dfTruncation', stress: 'dfStress', misread: 'dfMisread',
  script_typo: 'dfTypo', region_fail: 'dfRegion', user: 'dfUser',
  // «заново» — это НЕ утверждение о дефекте: фраза перегенерируется, но в
  // корпус не идёт. Своя подпись, свой цвет и свой значок — иначе по метке не
  // отличить, попадёт ли она в обучение
  redo: 'dfRedoCls'
}

/**
 * Audio defects of a voice-over, drawn INSIDE the lane of the clip they belong
 * to — deliberately unlike markers (full-height green flags) and the range
 * (full-height blue band), because a defect is a property of one clip's audio,
 * not of the timeline. Violet is the one unused colour here.
 *
 * The bands themselves are pointer-transparent so dragging the clip underneath
 * still works (the trick `.tl-marker` uses); only the flag and the two phrase
 * edge handles take the mouse.
 */
function DefectBands({ track, view }: { track: Track; view: ViewWindow }) {
  const t = useT()
  const zoom = useEditor((s) => s.zoom)
  const defects = useEditor((s) => s.project.defects)
  const clips = track.clips
  const busy = useVoiceUi((s) => s.busy)
  const hidden = useVoiceUi((s) => s.hidden)
  const marking = useVoiceUi((s) => s.marking)
  const preview = marking && marking.trackId === track.id ? marking : null
  // every defect against every clip of the track — once per change of either,
  // not on every render (it ran on every scroll and zoom step)
  const all = useMemo(() => {
    const out: Array<{ d: AudioDefect; src: VisibleSpan; phrase: VisibleSpan | null; clipId: string }> = []
    if (!defects?.length) return out
    const byAsset = new Map<string, Clip[]>()
    for (const c of clips) if (c.assetId) byAsset.set(c.assetId, [...(byAsset.get(c.assetId) ?? []), c])
    for (const d of defects) {
      // «не дефект» — метка и выделение уходят с таймлайна. Сама запись остаётся
      // в проекте: это обучающий пример для детектора, и Ctrl+Z вернёт её вид.
      if (d.state === 'rejected') continue
      for (const clip of byAsset.get(d.assetId) ?? []) {
        const src = spanToProject(clip, d.src[0], d.src[1])
        if (!src) continue
        out.push({ d, src, phrase: spanToProject(clip, d.phrase.t0, d.phrase.t1), clipId: clip.id })
      }
    }
    return out
  }, [defects, clips])
  if (hidden) return null
  if (!defects?.length && !preview) return null
  const placed = all.filter(({ src, phrase }) =>
    (src.end > view.start && src.start < view.end) || (!!phrase && phrase.end > view.start && phrase.start < view.end))
  if (!placed.length && !preview) return null

  const dragEdge = (e: React.PointerEvent, d: AudioDefect, edge: 't0' | 't1', clip: Clip) => {
    e.stopPropagation()
    const st = useEditor.getState()
    st.pushHistory('hDefectEdge')
    const startX = e.clientX
    const from = d.phrase[edge]
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const speed = clip.speed || 1
      const next = from + ((ev.clientX - startX) / s.zoom) * speed
      const cur = s.project.defects?.find((x) => x.id === d.id)
      if (!cur) return
      // the phrase must keep containing its defect — that invariant is what the
      // splice stands on, so the handle simply cannot be dragged past it
      const t0 = edge === 't0' ? Math.min(next, cur.src[0]) : cur.phrase.t0
      const t1 = edge === 't1' ? Math.max(next, cur.src[1]) : cur.phrase.t1
      s.updateDefect(d.id, {
        phrase: { ...cur.phrase, t0: Math.max(0, t0), t1, cut: ['fallback', 'fallback'] }
      })
    })
  }

  const dragSrc = (e: React.PointerEvent, d: AudioDefect, edge: 0 | 1, clip: Clip) => {
    e.stopPropagation()
    const st = useEditor.getState()
    st.pushHistory('hDefectEdge')
    const startX = e.clientX
    const from = d.src[edge]
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const speed = clip.speed || 1
      const cur = s.project.defects?.find((x) => x.id === d.id)
      if (!cur) return
      const next = from + ((ev.clientX - startX) / s.zoom) * speed
      // дефект обязан остаться внутри своей фразы и не вывернуться наизнанку
      const lo = cur.phrase.t0
      const hi = cur.phrase.t1
      const src: [number, number] = edge === 0
        ? [Math.min(Math.max(next, lo), cur.src[1] - 0.02), cur.src[1]]
        : [cur.src[0], Math.max(Math.min(next, hi), cur.src[0] + 0.02)]
      s.updateDefect(d.id, { src })
    })
  }

  return (
    <>
      {preview && (
        <div className="adefect marking"
             style={{ left: Math.min(preview.from, preview.to) * zoom,
                      width: Math.max(3, Math.abs(preview.to - preview.from) * zoom) }} />
      )}
      {placed.map(({ d, src, phrase, clipId }) => {
        const clip = clips.find((c) => c.id === clipId)
        const working = busy[d.id] !== undefined
        const label = t(DEFECT_LABEL[d.cls ?? 'user'] ?? 'dfUser')
        const conf = d.confidence === undefined ? '' : ` ${d.confidence.toFixed(2)}`
        const redo = d.cls === 'redo'
        // прямо в подсказке: пойдёт эта отметка в обучение или нет
        const learns = redo ? t('dfNoLearn') : t('dfLearns')
        return (
          <div key={`${d.id}-${clipId}`}>
            {phrase && (
              <div
                className={`adefect-phrase ${d.state}`}
                style={{ left: phrase.start * zoom, width: Math.max(2, (phrase.end - phrase.start) * zoom) }}
              >
                {clip && !phrase.clippedIn && (
                  <span className="adefect-edge left"
                        title={t('dfEdgeTip')}
                        onPointerDown={(e) => dragEdge(e, d, 't0', clip)} />
                )}
                {clip && !phrase.clippedOut && (
                  <span className="adefect-edge right"
                        title={t('dfEdgeTip')}
                        onPointerDown={(e) => dragEdge(e, d, 't1', clip)} />
                )}
              </div>
            )}
            <div
              className={`adefect ${d.state} ${d.origin}${redo ? ' redo' : ''}` +
                `${working ? ' working' : ''}` +
                `${src.clippedIn ? ' clipped-in' : ''}${src.clippedOut ? ' clipped-out' : ''}`}
              data-defect={d.id}
              style={{ left: src.start * zoom, width: Math.max(3, (src.end - src.start) * zoom) }}
            >
              {clip && !src.clippedIn && (
                <span className="adefect-edge src left" title={t('dfSrcEdge')}
                      onPointerDown={(e) => dragSrc(e, d, 0, clip)} />
              )}
              {clip && !src.clippedOut && (
                <span className="adefect-edge src right" title={t('dfSrcEdge')}
                      onPointerDown={(e) => dragSrc(e, d, 1, clip)} />
              )}
            </div>
            <button
              className={`adefect-flag ${d.state} ${d.origin}${redo ? ' redo' : ''}` +
                `${working ? ' working' : ''}`}
              style={{ left: src.start * zoom }}
              title={`${label}${conf}\n${learns}\n${t(redo ? 'dfTipRedo' : 'dfTip')}` +
                `\n${(d.phrase.text || '').slice(0, 120)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (!phrase) return
                // прослушать место — главное действие при разборе: ставим
                // диапазон на фразу и сразу запускаем
                const s = useEditor.getState()
                s.setRange({ start: phrase.start, end: phrase.end })
                s.setPlayhead(phrase.start)
                s.setPlaying(true)
              }}
              onClick={(e) => {
                e.stopPropagation()
                // Alt returns it to undecided — a mis-click must be cheap
                if (e.altKey) clearVerdict(d.id)
                else confirmDefect(d.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (d.origin === 'user') useEditor.getState().removeDefects(d.id)
                else setVerdict(d.id, false)
              }}
            >
              {d.state === 'confirmed' || d.state === 'done'
                ? <Icon name="check" size={10} strokeWidth={3} />
                : d.state === 'failed'
                  ? <Icon name="alert" size={10} strokeWidth={2.5} />
                  : redo
                    ? <Icon name="again" size={10} strokeWidth={2.5} />
                    : d.origin === 'user'
                      ? <Icon name="pencil" size={10} strokeWidth={2.5} />
                      : <Icon name="diamond" size={10} strokeWidth={2.5} />}
            </button>
          </div>
        )
      })}
    </>
  )
}

/**
 * Vegas-style crossed overlap regions (badge picks the blend) plus junction
 * markers on butt joints (badge picks an AE-style edge transition pair).
 */
function TransitionZones({ track, view, onMenu }: { track: Track; view: ViewWindow; onMenu: (m: MenuState) => void }) {
  const t = useT()
  const zoom = useEditor((s) => s.zoom)
  const all = useMemo(() => trackOverlaps(track.clips), [track.clips])
  const zones = all.zones.filter((z) => z.to > view.start && z.from < view.end)
  const joints = all.joints.filter((j) => j.at > view.start && j.at < view.end)
  if (!zones.length && !joints.length) return null
  return (
    <>
      {zones.map((z) => {
        const tin = z.clip.transitionIn
        const type = tin && tin.duration <= 0.001 ? tin.type : 'crossfade'
        const def = TRANSITIONS.find((tr) => tr.id === type)
        const name = type === 'none' ? t('trNone') : t((def ?? TRANSITIONS[0]).nameKey)
        return (
          <div
            key={z.clip.id}
            className={`transition-zone ${type === 'none' ? 'cut' : ''}`}
            style={{ left: z.from * zoom, width: Math.max(2, (z.to - z.from) * zoom) }}
          >
            {track.kind === 'video' && (
              <button
                className="transition-badge"
                title={`${t('transition')}: ${name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onMenu({ x: e.clientX, y: e.clientY, kind: 'transition', clipId: z.clip.id })
                }}
                aria-label={`${t('transition')}: ${name}`}
              >
                <Icon name="transition" size={12} />
              </button>
            )}
          </div>
        )
      })}
      {track.kind === 'video' &&
        joints.map((j) => {
          const tin = j.b.transitionIn
          const def = tin && tin.duration > 0.001
            ? EDGE_TRANSITIONS.find((e) => e.id === tin.type)
            : undefined
          return (
            <button
              key={`${j.a.id}-${j.b.id}`}
              className={`junction-badge ${def ? 'set' : ''}`}
              style={{ left: j.at * zoom }}
              title={`${t('edgeJunction')}${def ? ': ' + t(def.nameKey) : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onMenu({
                  x: e.clientX, y: e.clientY, kind: 'junction', clipIds: [j.a.id, j.b.id]
                })
              }}
              aria-label={t('edgeJunction')}
            >
              <Icon name="junction" size={12} />
            </button>
          )
        })}
    </>
  )
}

type DragMode = 'move' | 'in' | 'out'

interface DragState {
  mode: DragMode
  startX: number
  origStart: number
  origEnd: number
  origTrackId: string
  points: number[]
  /** original positions of all selected clips when group-dragging */
  group: { id: string; start: number; trackId: string; kind: Track['kind'] }[] | null
}

/**
 * The zoom the clips were last RENDERED at. During a zoom gesture only the CSS
 * variable --z (px per second, set on .tl-content) changes: every clip's
 * position and size are calc()s of it, so a zoom step is one style change and
 * a layout — not a React render of every clip (122 ms a step on a 1124-clip
 * project, in the dev build this editor runs in). What depends on the zoom in
 * any other way — which handles fit, the waveform's pixels — follows this
 * value, 150 ms after the zooming stops; until then a waveform is stretched.
 */
const useSettledZoom = create<{ z: number }>(() => ({ z: useEditor.getState().zoom }))
let settleTimer: ReturnType<typeof setTimeout> | undefined
let settleAtOnce = false
useEditor.subscribe((s, p) => {
  if (s.zoom === p.zoom) return
  clearTimeout(settleTimer)
  // a zoom gesture commits ONE change when it ends: settle in the same render
  if (settleAtOnce) useSettledZoom.setState({ z: s.zoom })
  else settleTimer = setTimeout(() => useSettledZoom.setState({ z: useEditor.getState().zoom }), 150)
})
/** a length in timeline seconds as CSS that follows the live zoom */
const zpx = (sec: number) => `calc(var(--z) * ${sec}px)`

/**
 * One clip. `visStart..visEnd` is the visible part of it (timeline seconds,
 * clipped to the clip): a clip that is entirely on screen gets the same pair on
 * every scroll, and memo() then skips it — only the clips at the edges redraw.
 */
const ClipView = memo(function ClipView({
  clip, track, laneHeight, visStart, visEnd, onMenu
}: {
  clip: Clip
  track: Track
  laneHeight: number
  visStart: number
  visEnd: number
  onMenu: (m: MenuState) => void
}) {
  const t = useT()
  const zoom = useSettledZoom((s) => s.z)
  const selected = useEditor((s) => s.selection.includes(clip.id))
  const asset = useEditor((s) =>
    clip.assetId ? s.project.assets.find((a) => a.id === clip.assetId) : undefined
  )
  const reversing = useReverseUi((s) => s.busy[clip.id]) // 0..1 or undefined
  const offline = useOffline((s) => !!clip.assetId && s.ids.has(clip.assetId))
  const drag = useRef<DragState | null>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const [levelDrag, setLevelDrag] = useState<number | null>(null)
  // live ×N readout during a Ctrl speed drag; highlighted when snapped
  const [speedBadge, setSpeedBadge] =
    useState<{ x: number; y: number; speed: number; snapped: boolean } | null>(null)
  // a glyph + a readout beside the cursor during a ripple, roll, slip or slide drag
  const [modeBadge, setModeBadge] =
    useState<{ x: number; y: number; icon: IconName; text: string } | null>(null)
  const signed = (dt: number) => `${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)}`

  const w = clip.duration * zoom
  const speed = clip.speed || 1
  // timeline length of one full pass over the source — the loop period
  const natural =
    asset && asset.kind !== 'image'
      ? Math.max(0.05, asset.duration - clip.inPoint) / speed
      : Infinity
  const loops = isFinite(natural) && clip.duration > natural + 0.01

  // visible slice in clip-local px — waveform drawn 1:1 with device pixels
  const margin = 64
  const vis0 = Math.max(0, Math.floor((visStart - clip.start) * zoom) - margin)
  const vis1 = Math.min(w, Math.ceil((visEnd - clip.start) * zoom) + margin)
  const visW = Math.max(0, Math.round(vis1 - vis0))

  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas || !asset || visW <= 0) return
    const wf = getWaveform(asset)
    if (!wf) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.round(visW * dpr)
    const ch = Math.round((laneHeight - 16) * dpr)
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const span = Math.max(0.05, asset.duration - clip.inPoint)
    const mid = ch / 2
    const cols = waveColumns(wf, { cw, vis0, dpr, zoom, speed, inPoint: clip.inPoint, span })
    // one path per colour, filled once: switching fillStyle for every column
    // was a large share of the redraw
    const peaks = new Path2D()
    const rmsPath = new Path2D()
    for (let x = 0; x < cw; x++) {
      const ph = Math.max(1, Math.min(1, (cols.peak[x] * wf.norm) / 255) * mid)
      const rh = Math.max(1, Math.min(1, (cols.rms[x] * wf.norm) / 255) * mid)
      peaks.rect(x, mid - ph, 1, ph * 2)
      rmsPath.rect(x, mid - rh, 1, rh * 2)
    }
    ctx.fillStyle = token('--c-wave-peak')
    ctx.fill(peaks)
    ctx.fillStyle = token('--c-wave-rms')
    ctx.fill(rmsPath)
  }, [asset, zoom, vis0, visW, clip.inPoint, clip.start, speed, laneHeight])

  // -------------------------------------------------------------- main drag
  // window-level listeners: the clip element remounts when it crosses to
  // another track mid-drag, which would kill pointer capture
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    const st = useEditor.getState()
    // a locked A/V twin is left out: the store would refuse to move it, and
    // half a pair that follows the drag is worse than a pair that does not
    const linkedIds = unlocked(st.project, withLinked(st.project, [clip.id]))
    const zone0 = setting<number>('mouse.edgeZone')
    const lx0 = e.clientX - e.currentTarget.getBoundingClientRect().left
    const atEdge = w > 24 && (lx0 < zone0 || lx0 > w - zone0)
    if (e.ctrlKey && e.shiftKey && atEdge && startRoll(e, lx0 < zone0 ? 'in' : 'out')) return
    if (e.altKey && !e.ctrlKey && !atEdge) {
      // Alt on the body: slip; Alt+Shift: slide (Alt near an edge stays speed)
      startSlipSlide(e, e.shiftKey)
      return
    }
    if (e.shiftKey && w > 24) {
      // Shift on an EDGE is ripple trim; Shift on the body stays span select
      const rect = e.currentTarget.getBoundingClientRect()
      const lx = e.clientX - rect.left
      const zone = setting<number>('mouse.edgeZone')
      if (lx < zone || lx > rect.width - zone) {
        startRippleTrim(e, lx < zone ? 'in' : 'out')
        return
      }
    }
    if (e.shiftKey) {
      // Explorer's Shift+click: from the FIRST clip of the current selection
      // to this one — the tracks between them, over the time they cover
      const anchor = st.selection[0]
      st.select(
        anchor && anchor !== clip.id
          ? unlocked(st.project, withLinked(st.project, clipsBetween(st.project, anchor, clip.id)))
          : linkedIds
      )
      return
    }
    if (speedModifier(e) && w > 24 && asset && asset.kind !== 'image') {
      // Ctrl/Alt+drag near EITHER edge = speed (Vegas-style time stretch) —
      // the same gesture as the extend handles, but forgiving about where
      // exactly the clip is grabbed
      const rect = e.currentTarget.getBoundingClientRect()
      const lx = e.clientX - rect.left
      if (lx > rect.width - 14) {
        startExtendDrag('right')(e)
        return
      }
      if (lx < 14) {
        startExtendDrag('left')(e)
        return
      }
    }
    // Ctrl on the body: a click toggles the selection, a DRAG past 3 px copies
    // (Explorer's copy modifier) — the originals move, copies stay behind
    let copy: string[] | null = null
    const toggleSelection = () => {
      const s = useEditor.getState()
      const sel = new Set(s.selection)
      if (sel.has(clip.id)) linkedIds.forEach((id) => sel.delete(id))
      else linkedIds.forEach((id) => sel.add(id))
      s.select([...sel])
    }
    if (e.ctrlKey) {
      // On a voice-over clip Ctrl+DRAG marks a span for the defect detector —
      // the gesture the work actually needs. A Ctrl+CLICK (no movement) still
      // toggles the selection exactly as before, so nothing is taken away.
      const run = clip.assetId
        ? st.project.voiceRuns?.find((r) => r.assetId === clip.assetId)
        : undefined
      if (run) {
        const box = e.currentTarget.getBoundingClientRect()
        const atX = (x: number) => {
          const s = useEditor.getState()
          const t = clip.start + (x - box.left) / s.zoom
          return Math.min(clip.start + clip.duration, Math.max(clip.start, t))
        }
        const from = atX(e.clientX)
        let moved = false
        useVoiceUi.setState({ marking: { trackId: track.id, from, to: from } })
        windowDrag(e, (_dx, ev) => {
          if (Math.abs(ev.clientX - e.clientX) > 3) moved = true
          useVoiceUi.setState({ marking: { trackId: track.id, from, to: atX(ev.clientX) } })
        }, () => {
          const m = useVoiceUi.getState().marking
          useVoiceUi.setState({ marking: null })
          if (!moved || !m || Math.abs(m.to - m.from) < 0.02) {
            toggleSelection()
            return
          }
          const a = Math.min(m.from, m.to)
          const b = Math.max(m.from, m.to)
          addUserDefect(clip.assetId!, projectToSrc(clip, a), projectToSrc(clip, b))
            .catch((err) => {
              useVoiceUi.setState({ error: String((err as Error)?.message ?? err) })
              useDefectsUi.getState().setOpen(true)
            })
        })
        return
      }
      copy = selected ? unlocked(st.project, st.selection) : linkedIds
    }
    if (!copy && !selected) st.select(linkedIds)

    const rect = e.currentTarget.getBoundingClientRect()
    const lx = e.clientX - rect.left
    const zone = setting<number>('mouse.edgeZone')
    const mode: DragMode = copy ? 'move' : lx < zone && w > 24 ? 'in' : lx > rect.width - zone && w > 24 ? 'out' : 'move'
    const grabTime = clip.start + lx / st.zoom
    if (!copy) st.pushHistory(mode === 'move' ? 'hMove' : 'hTrim')

    const sel = copy ?? useEditor.getState().selection
    const group =
      mode === 'move' && sel.length > 1 && sel.includes(clip.id)
        ? sel
            .map((id) => {
              const f = findClip(st.project, id)
              return f ? { id, start: f.clip.start, trackId: f.track.id, kind: f.track.kind } : null
            })
            .filter((x): x is NonNullable<typeof x> => !!x)
        : null

    // keep the grabbed position as a snap target so the clip can come home
    const points = snapPoints(st.project, group ? group.map((g) => g.id) : clip.id, st.playhead)
    points.push(clip.start, clip.start + clip.duration)

    const d: DragState = {
      mode,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      origTrackId: track.id,
      points,
      group
    }
    drag.current = d
    const clipId = clip.id

    const onMove = (ev: PointerEvent) => {
      const s = useEditor.getState()
      const dt = (ev.clientX - d.startX) / s.zoom
      const origDur = d.origEnd - d.origStart

      if (d.mode === 'move') {
        let ns = d.origStart + dt
        // snap whichever edge actually found a target (closest wins); detect
        // "snapped" by comparing snapTime's input and output directly so
        // float round-trips can't fake a zero-distance candidate
        const nsEnd = ns + origDur
        const c1 = snapTime(ns, d.points, s.zoom)
        const cEnd = snapTime(nsEnd, d.points, s.zoom)
        const d1 = c1 !== ns ? Math.abs(c1 - ns) : Infinity
        const d2 = cEnd !== nsEnd ? Math.abs(cEnd - nsEnd) : Infinity
        if (d1 <= d2 && d1 < Infinity) ns = c1
        else if (d2 < Infinity) ns = cEnd - origDur
        // hovered lane (live track switch without releasing the button)
        let hoverId: string | null = null
        for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
          const id = (el as HTMLElement).dataset?.lane
          if (id) {
            hoverId = id
            break
          }
        }
        if (d.group) {
          // the group keeps its shape at the left wall: setClipStarts clamps
          // each clip at 0 on its own, which would pile the whole selection
          // onto t=0 instead of stopping it there
          const floor = Math.min(...d.group.map((g) => g.start))
          const delta = Math.max(ns - d.origStart, -floor)
          // shift the whole group across tracks by the grabbed clip's offset
          // within its own track kind (audio partners move in parallel)
          const tracks = s.project.tracks
          const origTrack = tracks.find((tr) => tr.id === d.origTrackId)
          const hovered = hoverId ? tracks.find((tr) => tr.id === hoverId) : undefined
          let offset = 0
          if (origTrack && hovered && hovered.kind === origTrack.kind) {
            const list = tracks.filter((tr) => tr.kind === origTrack.kind)
            offset = list.findIndex((tr) => tr.id === hovered.id) -
                     list.findIndex((tr) => tr.id === origTrack.id)
          }
          s.setClipStarts(d.group.map((g) => {
            let trackId = g.trackId
            if (offset !== 0) {
              const list = tracks.filter((tr) => tr.kind === g.kind)
              const idx = list.findIndex((tr) => tr.id === g.trackId) + offset
              if (list[idx] && !list[idx].locked) trackId = list[idx].id
            }
            return { id: g.id, start: g.start + delta, trackId }
          }))
          return
        }
        const f = findClip(s.project, clipId)
        if (!f) return
        const targetTrack = hoverId ?? f.track.id
        if (f.track.id !== targetTrack || Math.abs(f.clip.start - ns) > 1e-6) {
          s.moveClip(clipId, targetTrack, Math.max(0, ns))
        }
      } else if (d.mode === 'in') {
        s.trimClip(clipId, 'in', snapTime(d.origStart + dt, d.points, s.zoom))
      } else {
        s.trimClip(clipId, 'out', snapTime(d.origEnd + dt, d.points, s.zoom))
      }
    }
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMoveTracked = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        moved = true
        if (copy) {
          // one undo step: the copies and the move that follows
          const s = useEditor.getState()
          s.pushHistory('hDuplicate')
          s.select(copy)
          s.duplicateInPlace(copy)
        }
      }
      if (copy && !moved) return
      onMove(ev)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMoveTracked)
      window.removeEventListener('pointerup', onUp)
      drag.current = null
      if (copy) {
        if (!moved) toggleSelection()
        return
      }
      // a plain click (no drag) parks the playhead at the click position;
      // dragging keeps the red cursor where it was so clips can snap to it
      if (!moved && mode === 'move') {
        const s = useEditor.getState()
        s.setPlayhead(grabTime)
        // …and it drops the rest of a group selection, the way clicking one
        // file in Explorer does. Without this a band selection could only be
        // narrowed by clicking empty space first.
        if (s.selection.length > linkedIds.length) s.select(linkedIds)
      }
    }
    window.addEventListener('pointermove', onMoveTracked)
    window.addEventListener('pointerup', onUp)
  }

  // ------------------------------------------------------------ fade drags
  const startFadeDrag = (which: 'fadeIn' | 'fadeOut') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!selected) st.select([clip.id])
    st.pushHistory('hFade')
    const f0 = (which === 'fadeIn' ? clip.fadeIn : clip.fadeOut) ?? 0
    windowDrag(e, (dx) => {
      const s = useEditor.getState()
      const f = findClip(s.project, clip.id)
      if (!f) return
      const raw = which === 'fadeIn' ? f0 + dx / s.zoom : f0 - dx / s.zoom
      const v = Math.max(0, Math.min(f.clip.duration, raw))
      s.updateClip(clip.id, { [which]: v < 0.06 ? 0 : v } as Partial<Clip>)
    })
  }

  // ------------------------------------------------------ ripple trim drag
  // Shift+drag of an edge: the clip's length changes and everything after it
  // on its track and its twin's follows (rippleTrim). The in edge keeps its
  // place — the head comes off the source and the tail closes up.
  const startRippleTrim = (e: React.PointerEvent<HTMLDivElement>, edge: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!selected) st.select(unlocked(st.project, withLinked(st.project, [clip.id])))
    st.pushHistory('hRippleTrim')
    const origEnd = clip.start + clip.duration
    const origDur = clip.duration
    const origIn = clip.inPoint
    const points = snapPoints(st.project, withLinked(st.project, [clip.id]), st.playhead)
    windowDrag(e, (dx, ev) => {
      const s = useEditor.getState()
      const dt = dx / s.zoom
      if (edge === 'out') s.rippleTrim(clip.id, 'out', snapTime(origEnd + dt, points, s.zoom))
      else {
        // the start never moves, so ask for what is still to come off the head
        const cur = findClip(s.project, clip.id)?.clip
        if (cur) s.rippleTrim(clip.id, 'in', cur.start + dt - (cur.inPoint - origIn) / speed)
      }
      const now = findClip(useEditor.getState().project, clip.id)?.clip
      setModeBadge({ x: ev.clientX, y: ev.clientY, icon: 'wave', text: signed((now?.duration ?? origDur) - origDur) })
    }, () => setModeBadge(null))
  }

  // ------------------------------------------------------------ roll drag
  // Ctrl+Shift+drag of an edge shared with a butted neighbour: the cut moves,
  // both clips change length, their sum does not. False when there is no
  // neighbour (the caller falls through).
  const startRoll = (e: React.PointerEvent<HTMLDivElement>, edge: 'in' | 'out') => {
    const st = useEditor.getState()
    const cut = edge === 'in' ? clip.start : clip.start + clip.duration
    const other = track.clips.find((o) => o.id !== clip.id &&
      Math.abs((edge === 'in' ? o.start + o.duration : o.start) - cut) < 1e-6)
    if (!other) return false
    e.stopPropagation()
    e.preventDefault()
    const [left, right] = edge === 'in' ? [other.id, clip.id] : [clip.id, other.id]
    st.pushHistory('hRoll')
    const points = snapPoints(st.project, withLinked(st.project, [clip.id, other.id]), st.playhead)
    windowDrag(e, (dx, ev) => {
      const s = useEditor.getState()
      s.rollEdit(left, right, snapTime(cut + dx / s.zoom, points, s.zoom))
      const l = findClip(useEditor.getState().project, left)?.clip
      setModeBadge({ x: ev.clientX, y: ev.clientY, icon: 'junction', text: signed((l ? l.start + l.duration : cut) - cut) })
    }, () => setModeBadge(null))
    return true
  }

  // ------------------------------------------------------ slip/slide drag
  // Alt+drag of the body: slip — the source moves under a clip that stays put
  // (the content follows the pointer); Alt+Shift: slide — the clip moves with
  // its source and the butted neighbours' facing edges follow.
  const startSlipSlide = (e: React.PointerEvent<HTMLDivElement>, isSlide: boolean) => {
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!isSlide && (!asset || asset.kind === 'image')) {
      setModeBadge({ x: e.clientX, y: e.clientY, icon: 'film', text: t('slipStill') })
      windowDrag(e, () => {}, () => setModeBadge(null))
      return
    }
    if (!selected) st.select(unlocked(st.project, withLinked(st.project, [clip.id])))
    st.pushHistory(isSlide ? 'hSlide' : 'hSlip')
    const origStart = clip.start
    const origIn = clip.inPoint
    const points = snapPoints(st.project, withLinked(st.project, [clip.id]), st.playhead)
    windowDrag(e, (dx, ev) => {
      const s = useEditor.getState()
      const cur = findClip(s.project, clip.id)?.clip
      if (!cur) return
      const fps = s.project.fps
      if (isSlide) {
        let ns = origStart + dx / s.zoom
        const snapped = snapTime(ns, points, s.zoom)
        const snappedEnd = snapTime(ns + cur.duration, points, s.zoom) - cur.duration
        ns = snapped !== ns ? snapped : snappedEnd
        s.slide(clip.id, ns - cur.start)
        const now = findClip(useEditor.getState().project, clip.id)?.clip ?? cur
        setModeBadge({ x: ev.clientX, y: ev.clientY, icon: 'move', text: signed(now.start - origStart) })
      } else {
        // dragging right shows EARLIER source: the picture follows the hand
        const want = origIn - (dx / s.zoom) * speed
        s.slip(clip.id, (want - cur.inPoint) / speed)
        const now = findClip(useEditor.getState().project, clip.id)?.clip ?? cur
        setModeBadge({ x: ev.clientX, y: ev.clientY, icon: 'film',
          text: `${formatTime(now.inPoint, fps)} – ${formatTime(now.inPoint + now.duration * speed, fps)}` })
      }
    }, () => setModeBadge(null))
  }

  // ---------------------------------------------------- extend/speed drag
  // Works from BOTH clip ends. Right: the start stays put (resize = loop-
  // extend, Ctrl = speed). Left: the RIGHT edge stays anchored (resize =
  // trim-in, Ctrl = speed with the start moving instead).
  const startExtendDrag = (edge: 'left' | 'right') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (e.ctrlKey && e.shiftKey && startRoll(e, edge === 'left' ? 'in' : 'out')) return
    const speedMode = speedModifier(e) && !!asset && asset.kind !== 'image'
    if (e.shiftKey && !speedMode) {
      startRippleTrim(e, edge === 'left' ? 'in' : 'out')
      return
    }
    const st = useEditor.getState()
    if (!selected) st.select([clip.id])
    const leftTrim = edge === 'left' && !speedMode
    st.pushHistory(speedMode ? 'hSpeed' : leftTrim ? 'hTrim' : 'hResize')
    const origStart = clip.start
    const origEnd = clip.start + clip.duration
    const origDur = clip.duration
    const origSpeed = speed
    // a speed drag carries the whole selection along, scaled by the grabbed
    // clip's ratio; the group's edge opposite the grabbed one stays put
    const group = speedMode ? speedGroup(clip.id) : []
    // exclude the linked twin (and the speed group) from snap targets — they follow the drag
    const points = snapPoints(
      st.project, withLinked(st.project, [clip.id, ...group.map((g) => g.id)]), st.playhead)
    windowDrag(e, (dx, ev) => {
      const s = useEditor.getState()
      const dt = dx / s.zoom
      if (speedMode) {
        // same source span, new tempo — no looping; keyframes/fades rescale
        // along, and the linked audio/video partner changes tempo too
        const srcSpan = origDur * origSpeed
        let nd = edge === 'right'
          ? Math.max(0.05, origDur + dt)
          : Math.min(origEnd, Math.max(0.05, origDur - dt)) // start may not go below 0
        // snap within ~16 px: to round multipliers AND to the edges of the
        // other clips / the playhead — the closest candidate wins
        let snapped = false
        let bestGap = 16 / s.zoom
        let snapNd = nd
        const consider = (candNd: number) => {
          const gap = Math.abs(candNd - nd)
          if (candNd > 0.05 && gap < bestGap) {
            bestGap = gap
            snapNd = candNd
            snapped = true
          }
        }
        for (const cand of SPEED_SNAPS) consider(srcSpan / cand)
        // the MOVING edge lands on a timeline point
        for (const p of points) consider(edge === 'right' ? p - origStart : origEnd - p)
        if (snapped) nd = snapNd
        const nspeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, srcSpan / nd))
        setSpeedBadge({ x: ev.clientX, y: ev.clientY, speed: nspeed, snapped })
        s.setClipSpeeds(layoutSpeeds(group, (it) => (it.speed * nspeed) / origSpeed,
          edge === 'left' ? 'end' : 'start'))
      } else if (leftTrim) {
        // same semantics as dragging the clip's left trim edge: content
        // stays in place, inPoint compensates, source start clamps
        s.trimClip(clip.id, 'in', snapTime(origStart + dt, points, s.zoom))
      } else {
        let nd = Math.max(0.05, origDur + dt)
        // sticky zone at the natural (source) length
        if (isFinite(natural) && Math.abs(nd - natural) < snapRadius(s.zoom)) nd = natural
        const snapped = snapTime(origStart + nd, points, s.zoom) - origStart
        if (snapped > 0.05 && Math.abs(snapped - nd) < snapRadius(s.zoom)) nd = snapped
        s.setClipDuration(clip.id, nd) // linked partner follows
      }
    }, () => setSpeedBadge(null))
  }

  // rubber band: opacity for video clips, gain for audio clips
  const isAudio = track.kind === 'audio'
  const levelMax = isAudio ? 2 : 1
  const level = isAudio ? evalAnim(clip.gain, 0) : evalAnim(clip.transform?.opacity, 0)
  const levelPad = 7
  const levelUsable = Math.max(4, laneHeight - 8 - levelPad * 2)
  const yOfLevel = (v: number) => levelPad + (1 - Math.min(levelMax, Math.max(0, v)) / levelMax) * levelUsable
  const levelY = yOfLevel(level)
  // K1: the line takes points — the Anim's keys, at clip-local times
  const levelAnim = isAudio ? clip.gain : clip.transform?.opacity
  const writeLevel = (a: Anim) => {
    const s = useEditor.getState()
    const f = findClip(s.project, clip.id)
    if (!f) return
    if (isAudio) s.updateClip(clip.id, { gain: a })
    else s.updateClip(clip.id, { transform: { ...f.clip.transform, opacity: a } })
  }
  const lineOf = (el: Element): LevelLine => {
    const r = el.closest('.clip')!.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, duration: clip.duration, pad: levelPad, usable: levelUsable, max: levelMax }
  }

  // the line: a drag moves the whole level (every point alike); a click adds a point
  const startLevelDrag = (e: React.PointerEvent<Element>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    st.pushHistory('hEdit') // one gesture, one undo step
    const a0 = levelAnim ?? { value: 1 }
    const line = lineOf(e.currentTarget)
    const down = levelAt(line, e.clientX, e.clientY)
    let moved = false
    windowDrag(
      e,
      (dx, ev) => {
        const dy = ev.clientY - e.clientY
        if (!moved && Math.abs(dx) + Math.abs(dy) <= 3) return
        moved = true
        const a = shiftLevel(a0, -(dy / levelUsable) * levelMax, levelMax)
        setLevelDrag(evalAnim(a, down.t))
        writeLevel(a)
      },
      () => {
        if (!moved) writeLevel(addLevelPoint(a0, down.t))
        setLevelDrag(null)
      }
    )
  }
  // a point: drag moves it (Shift: along time only), right-click removes it
  const startPointDrag = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0 || !levelAnim) return
    e.stopPropagation()
    e.preventDefault()
    useEditor.getState().pushHistory('hEdit')
    const a0 = levelAnim
    const line = lineOf(e.currentTarget)
    const k0 = sortedKfs(a0)[i]
    setLevelDrag(k0.value)
    windowDrag(e, (dx, ev) => {
      const dy = ev.clientY - e.clientY
      const a = moveLevelPoint(a0, i, k0.time + (dx / line.width) * clip.duration,
        k0.value - (dy / levelUsable) * levelMax, { duration: clip.duration, max: levelMax, keepLevel: ev.shiftKey })
      setLevelDrag(a.keyframes![i].value)
      writeLevel(a)
    }, () => setLevelDrag(null))
  }
  const deletePoint = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (track.locked || !levelAnim) return
    useEditor.getState().pushHistory('hEdit')
    writeLevel(deleteLevelPoint(levelAnim, i))
  }
  // the keyed line, in clip seconds × lane px: straight between linear keys,
  // sampled where an easing or the spline bends it
  const levelPath = (() => {
    if (!levelAnim?.keyframes?.length) return ''
    const kfs = sortedKfs(levelAnim)
    const ts = [0]
    kfs.forEach((k, j) => {
      const next = kfs[j + 1]
      ts.push(k.time)
      if (next && (levelAnim.smooth || k.easing !== 'linear')) {
        for (let s = 1; s < 24; s++) ts.push(k.time + ((next.time - k.time) * s) / 24)
        ts.push(next.time - 1e-6)
      }
    })
    ts.push(clip.duration)
    return ts.map((t) => `${t},${yOfLevel(evalAnim(levelAnim, t)).toFixed(1)}`).join(' ')
  })()

  const isText = clip.kind === 'text'
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0
  const cls = `clip ${track.kind} ${selected ? 'selected' : ''} ${isText ? 'text-clip' : ''} ${clip.kind === 'remotion' ? 'remotion-clip' : ''}${offline ? ' offline' : ''}${clip.disabled ? ' disabled' : ''}`
  // a colour label (E9): the clip's own, else its track's
  const label = clip.color ?? track.color
  const tint = label ? { background: `var(--label-${label})` } : {}
  // A clip a few pixels wide shows nothing but its colour: its handles, level
  // line, label and waveform can be neither seen nor grabbed. Zoomed out on a
  // long project that is most of them (a 19-minute project: ~600 clips on
  // screen, most of them short sounds) and all that DOM was rebuilt on every
  // zoom step. It stays one element — selectable, draggable, with its menu.
  const tiny = w < 6

  // edge (tip) transitions: AE-style effects on the clip head/tail
  const tipIn = clip.transitionIn && clip.transitionIn.duration > 0.001 ? clip.transitionIn : null
  const tipOut = clip.transitionOut && clip.transitionOut.duration > 0.001 ? clip.transitionOut : null
  const openTipMenu = (edge: 'in' | 'out') => (e: React.MouseEvent) => {
    e.stopPropagation()
    onMenu({ x: e.clientX, y: e.clientY, kind: 'edge', clipId: clip.id, edge })
  }
  const openFadeMenu = (edge: 'in' | 'out') => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onMenu({ x: e.clientX, y: e.clientY, kind: 'fade', clipId: clip.id, edge })
  }

  const loopMarks: number[] = []
  if (loops) {
    for (let k = 1; k * natural < clip.duration; k++) loopMarks.push(k * natural)
  }

  // fade handles ride along the fade boundary: max(0, min(w − 12, fade·zoom − 5))
  const fadeInX = `clamp(0px, calc(var(--z) * ${fadeIn}px - 5px), calc(var(--z) * ${clip.duration}px - 12px))`
  const fadeOutX = `clamp(0px, calc(var(--z) * ${fadeOut}px - 5px), calc(var(--z) * ${clip.duration}px - 12px))`

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    useEditor.getState().setAnimClip(clip.id)
  }
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const st = useEditor.getState()
    if (!st.selection.includes(clip.id)) st.select(withLinked(st.project, [clip.id]))
    onMenu({
      x: e.clientX, y: e.clientY, kind: 'clip',
      clipId: clip.id, linked: !!clip.linkId, trackKind: track.kind
    })
  }
  if (tiny) {
    return (
      <div
        className={cls}
        data-clip={clip.id}
        style={{ left: zpx(clip.start), width: `max(4px, ${zpx(clip.duration)})`, ...tint }}
        title={offline ? t('offlineClip') : clip.disabled ? t('clipDisabled') : clip.label ?? asset?.name}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    )
  }
  return (
    <div
      className={cls}
      data-clip={clip.id}
      style={{ left: zpx(clip.start), width: `max(4px, ${zpx(clip.duration)})`, ...tint }}
      title={clip.disabled ? t('clipDisabled') : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {track.kind === 'video' && asset?.thumbnail && !isText && (
        <img className="clip-thumb" src={asset.thumbnail} alt="" draggable={false} />
      )}
      {track.kind === 'video' && !isText && w > 90 && (asset?.thumbnailEnd || asset?.thumbnail) && (
        <img
          className="clip-thumb end"
          src={asset.thumbnailEnd ?? asset.thumbnail}
          alt=""
          draggable={false}
        />
      )}
      {track.kind === 'audio' && visW > 0 && (
        <canvas ref={waveRef} className="clip-wave" style={{ left: zpx(vis0 / zoom), width: zpx(visW / zoom) }} />
      )}
      {levelPath ? (
        <svg className="level-curve" style={{ height: levelUsable + levelPad * 2 }}
          viewBox={`0 0 ${clip.duration} ${levelUsable + levelPad * 2}`} preserveAspectRatio="none">
          <polyline className="level-curve-hit" points={levelPath} onPointerDown={startLevelDrag}>
            <title>{t('levelPointsHint')}</title>
          </polyline>
          <polyline className="level-curve-line" points={levelPath} />
        </svg>
      ) : (
        <div
          className="level-hit"
          style={{ top: levelY - 4 }}
          title={`${Math.round(level * 100)}% · ${t('levelPointsHint')}`}
          onPointerDown={startLevelDrag}
        >
          <div className="level-line" />
        </div>
      )}
      {w > 30 && sortedKfs(levelAnim ?? { value: 1 }).map((k, i) => (
        <div
          key={i}
          className="level-point"
          data-level-point={i}
          style={{ left: `calc(${zpx(k.time)} - 4px)`, top: yOfLevel(k.value) - 4 }}
          title={`${Math.round(k.value * 100)}%`}
          onPointerDown={startPointDrag(i)}
          onContextMenu={deletePoint(i)}
        />
      ))}
      {levelDrag !== null && (
        <div className="level-badge" style={{ top: Math.max(0, yOfLevel(levelDrag) - 22) }}>
          {Math.round(levelDrag * 100)}%
        </div>
      )}
      {fadeIn > 0 && <div className="fade-shade left" style={{ width: zpx(fadeIn) }} />}
      {fadeOut > 0 && <div className="fade-shade right" style={{ width: zpx(fadeOut) }} />}
      {loopMarks.map((x) => (
        <div key={x} className="loop-mark" style={{ left: zpx(x) }} title={t('loopMark')} />
      ))}
      <span className="clip-label">
        {offline && <span className="clip-offline" title={t('offlineClip')}><Icon name="unlink" size={11} /></span>}
        {clip.kind === 'remotion' && <Icon name="atom" size={11} />}
        {clip.linkId && <Icon name="link" size={11} />}
        <span>
          {isText ? `T: ${clip.text}` : clip.label}
          {speed !== 1 ? ` ×${speed.toFixed(2)}` : ''}
        </span>
        {loops && <Icon name="loop" size={11} />}
        {reversing !== undefined
          ? <><Spinner size={11} /> {Math.round(reversing * 100)}%</>
          : asset?.reverseOf
            ? <Icon name="rewind" size={11} />
            : null}
      </span>
      {reversing !== undefined && (
        <div className="reverse-progress" style={{ width: `${Math.round(reversing * 100)}%` }} />
      )}
      {tipIn && <div className="tip-strip left" style={{ width: zpx(tipIn.duration) }} />}
      {tipOut && <div className="tip-strip right" style={{ width: zpx(tipOut.duration) }} />}
      {track.kind === 'video' && w > 40 && (
        <>
          <div
            className={`clip-tip left ${tipIn ? 'set' : ''}`}
            role="button"
            title={t('edgeTipHint')}
            aria-label={t('edgeTipHint')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openTipMenu('in')}
          />
          <div
            className={`clip-tip right ${tipOut ? 'set' : ''}`}
            role="button"
            title={t('edgeTipHint')}
            aria-label={t('edgeTipHint')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openTipMenu('out')}
          />
        </>
      )}
      <div className="trim-handle left" />
      <div className="trim-handle right" />
      {w > 30 && (
        <>
          <div
            className="fade-handle left"
            style={{ left: fadeInX }}
            title={t('fadeInHandle')}
            onPointerDown={startFadeDrag('fadeIn')}
            onContextMenu={openFadeMenu('in')}
          />
          <div
            className="fade-handle right"
            style={{ right: fadeOutX }}
            title={t('fadeOutHandle')}
            onPointerDown={startFadeDrag('fadeOut')}
            onContextMenu={openFadeMenu('out')}
          />
          <div
            className="extend-handle"
            title={t('extendRightHint')}
            onPointerDown={startExtendDrag('right')}
          />
          <div
            className="extend-handle left"
            title={t('extendLeftHint')}
            onPointerDown={startExtendDrag('left')}
          />
        </>
      )}
      {speedBadge && createPortal(
        <div
          className={speedBadge.snapped ? 'speed-badge snapped' : 'speed-badge'}
          style={{ left: speedBadge.x + 14, top: speedBadge.y - 30 }}
        >
          ×{speedBadge.speed.toFixed(2)}
        </div>,
        document.body
      )}
      {modeBadge && createPortal(
        <div className="speed-badge" style={{ left: modeBadge.x + 14, top: modeBadge.y - 30 }}>
          <Icon name={modeBadge.icon} size={13} /> {modeBadge.text}
        </div>,
        document.body
      )}
    </div>
  )
})
