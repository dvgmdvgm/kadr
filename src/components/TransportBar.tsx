import { useEffect, useState } from 'react'
import { useEditor, projectDuration } from '@/state/store'
import { useSettings } from '@/state/store'
import { snapshotFrame } from '@/engine/snapshot'
import { usePopout, togglePreviewWindow } from '@/engine/popout'
import { useT, type TKey } from '@/i18n'
import { Icon, Spinner } from './icons'
import { logWarn } from '@/engine/log'
import { useOnion, toggleOnion } from '@/engine/onion'
import { formatTime, parseTimecode } from '@/engine/timelineMath'
import { CtxMenu } from './CtxMenu'
import type { SettingKey } from '@shared/settings'


export function TransportBar() {
  const t = useT()
  const [shot, setShot] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const playing = useEditor((s) => s.playing)
  const rate = useEditor((s) => s.playRate)
  const loop = useEditor((s) => s.loop)
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project.fps)
  const duration = useEditor((s) => projectDuration(s.project))
  const popped = usePopout((s) => s.win) !== null
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const st = useEditor.getState

  return (
    <div className="transport">
      <span className="bar-group">
        <button
          className="icon-only"
          data-act="undo"
          title={t('undo') + (undoLabel ? `: ${t(undoLabel as TKey)}` : '')}
          aria-label={t('undo')}
          disabled={!undoLabel}
          onClick={() => st().undo()}
        >
          <Icon name="undo" />
        </button>
        <button
          className="icon-only"
          data-act="redo"
          title={t('redo') + (redoLabel ? `: ${t(redoLabel as TKey)}` : '')}
          aria-label={t('redo')}
          disabled={!redoLabel}
          onClick={() => st().redo()}
        >
          <Icon name="redo" />
        </button>
      </span>
      <span className="sep" />
      <button className="icon-only" data-act="to-start" title={t('toStart')} aria-label={t('toStart')}
              onClick={() => st().setPlayhead(0)}>
        <Icon name="toStart" />
      </button>
      <button
        className="play"
        data-act="play"
        title={playing ? t('pause') : t('play')}
        aria-label={playing ? t('pause') : t('play')}
        onClick={() => st().setPlaying(!playing)}
      >
        <Icon name={playing ? 'pause' : 'play'} size={17} />
      </button>
      <button className="icon-only" data-act="to-end" title={t('toEnd')} aria-label={t('toEnd')}
              onClick={() => st().setPlayhead(projectDuration(st().project))}>
        <Icon name="toEnd" />
      </button>
      <button
        className={`icon-only${loop ? ' active' : ''}`}
        data-act="loop"
        title={loop ? t('loopOn') : t('loopOff')}
        aria-label={t('actLoop')}
        aria-pressed={loop}
        onClick={() => st().toggleLoop()}
      >
        <Icon name="loop" />
      </button>
      <span className="sep" />
      <button className="icon-only" data-act="split" title={t('split')} aria-label={t('split')}
              onClick={() => st().splitAtPlayhead()}>
        <Icon name="split" />
      </button>
      <button className="icon-only" data-act="delete" title={t('delete')} aria-label={t('delete')}
              onClick={() => st().deleteSelection()}>
        <Icon name="trash" />
      </button>
      <button className="icon-only" data-act="add-text" title={t('addText')} aria-label={t('addText')}
              onClick={() => st().insertTextClip(playhead)}>
        <Icon name="text" />
      </button>
      <button
        className="icon-only"
        data-act="snapshot"
        title={shot === 'fail' ? t('snapshotFail') : t('snapshot')}
        aria-label={t('snapshot')}
        disabled={shot === 'busy'}
        onClick={() => {
          setShot('busy')
          snapshotFrame({ interactive: true }).then(
            () => setShot('ok'),
            (err) => {
              if (String(err).includes('cancelled')) { setShot('idle'); return }
              logWarn('снимок', 'снимок кадра не удался', err)
              setShot('fail')
            }
          ).finally(() => setTimeout(() => setShot('idle'), 2000))
        }}
      >
        {shot === 'busy' ? <Spinner />
          : <Icon name={shot === 'ok' ? 'check' : shot === 'fail' ? 'close' : 'camera'} />}
      </button>
      <button
        className={`icon-only${popped ? ' active' : ''}`}
        data-act="popout"
        title={popped ? t('popin') : t('popout')}
        aria-label={popped ? t('popin') : t('popout')}
        onClick={() => togglePreviewWindow()}
      >
        <Icon name={popped ? 'popin' : 'popout'} />
      </button>
      <OnionControls />
      <PreviewMenu />
      <span className="time">
        {playing && rate !== 1 && (
          <span className="rate-badge" data-act="rate" title={t('rateLbl')}>
            {rate < 0 ? '−' : ''}{Math.abs(rate)}×
          </span>
        )}
        <TimecodeField playhead={playhead} fps={fps} /> <span className="dim">/ {formatTime(duration, fps)}</span>
        <span className="frame-counter dim">
          {' '}· {t('frameLbl')} {Math.floor(playhead * fps + 1e-6)}
          <span> / {Math.floor(duration * fps + 1e-6)}</span>
        </span>
      </span>
    </div>
  )
}

/** The playhead's timecode; a click turns it into a go-to field (parseTimecode). */
function TimecodeField({ playhead, fps }: { playhead: number; fps: number }) {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const close = () => { setText(null); setBad(false) }
  if (text === null) {
    return (
      <button className="tc" data-act="timecode" title={t('tcGoto')} aria-label={t('tcGoto')}
              onClick={() => setText(formatTime(playhead, fps))}>
        {formatTime(playhead, fps)}
      </button>
    )
  }
  return (
    <input
      className="tc-input"
      data-act="timecode-input"
      autoFocus
      spellCheck={false}
      value={text}
      aria-label={t('tcGoto')}
      aria-invalid={bad}
      title={bad ? t('tcBad') : t('tcGoto')}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => { setText(e.target.value); setBad(false) }}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); close() }
        if (e.key !== 'Enter') return
        const to = parseTimecode(text, fps, playhead)
        if (to === null) { setBad(true); return }
        useEditor.getState().setPlayhead(to)
        close()
      }}
    />
  )
}

export function LangSwitch() {
  const lang = useSettings((s) => s.lang)
  const setLang = useSettings((s) => s.setLang)
  return (
    <button
      className="lang"
      data-act="lang"
      title={lang === 'ru' ? 'Язык интерфейса: русский' : 'Interface language: English'}
      onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
    >
      <Icon name="language" size={14} /> {lang === 'ru' ? 'RU' : 'EN'}
    </button>
  )
}

/** the onion skin (engine/onion.ts): on/off, how strong, and «difference» */
function OnionControls() {
  const t = useT()
  const on = useOnion((s) => s.on)
  const opacity = useOnion((s) => s.opacity)
  const diff = useOnion((s) => s.diff)
  const clipId = useOnion((s) => s.clipId)
  const [none, setNone] = useState(false)
  const name = useEditor((s) => {
    const id = clipId
    const c = on && id ? s.project.tracks.flatMap((tr) => tr.clips).find((x) => x.id === id) : null
    return c ? c.label ?? s.project.assets.find((a) => a.id === c.assetId)?.name ?? '' : ''
  })
  const title = none ? t('onionNone') : on ? `${t('onionOff')} — ${name}` : t('onion')
  return (
    <span className="onion-ctl">
      <button
        className={`icon-only${on ? ' active' : ''}`}
        data-act="onion"
        title={title}
        aria-label={t('onion')}
        aria-pressed={on}
        onClick={() => {
          const ok = toggleOnion()
          setNone(!on && !ok)
          if (!on && !ok) setTimeout(() => setNone(false), 3000)
        }}
      >
        <Icon name="onion" />
      </button>
      {on && (
        <>
          <input type="range" min={0.05} max={1} step={0.05} value={opacity} data-act="onion-opacity"
            title={t('onionOpacity')} aria-label={t('onionOpacity')}
            onChange={(e) => useOnion.setState({ opacity: Number(e.target.value) })} />
          <button
            className={`icon-only${diff ? ' active' : ''}`}
            data-act="onion-diff"
            title={t('onionDiff')}
            aria-label={t('onionDiff')}
            aria-pressed={diff}
            onClick={() => useOnion.setState({ diff: !diff })}
          >
            <Icon name="transition" />
          </button>
        </>
      )}
    </span>
  )
}

/** «Вид превью»: quality (the canvas backing store only) and what is drawn over the frame */
function PreviewMenu() {
  const t = useT()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const quality = useSettings((s) => s.effective('playback.previewQuality').value)
  const on = (k: SettingKey) => useSettings.getState().effective(k).value === true
  // re-render when an overlay flips
  useSettings((s) => s.snap)
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
  const set = useSettings.getState().set
  const toggle = (k: SettingKey, act: string, label: string) => (
    <button data-act={act} role="menuitemcheckbox" aria-checked={on(k)} onClick={() => set(k, !on(k))}>
      <span className="ctx-check">{on(k) && <Icon name="check" size={13} />}</span>
      {label}
    </button>
  )
  return (
    <>
      <button
        className={`icon-only${at ? ' active' : ''}`}
        data-act="preview-menu"
        title={t('pvMenu')}
        aria-label={t('pvMenu')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (at) { setAt(null); return }
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <Icon name="eye" />
      </button>
      {at && (
        <CtxMenu x={at.x} y={at.y} className="preview-menu">
          <div className="ctx-title">{t('pvQuality')}</div>
          {(['full', 'half', 'quarter'] as const).map((q) => (
            <button key={q} data-act={`pv-${q}`} role="menuitemradio" aria-checked={quality === q}
                    onClick={() => { set('playback.previewQuality', q); setAt(null) }}>
              <span className="ctx-check">{quality === q && <Icon name="check" size={13} />}</span>
              {t(q === 'full' ? 'pvFull' : q === 'half' ? 'pvHalf' : 'pvQuarter')}
            </button>
          ))}
          <div className="ctx-title">{t('pvOverlays')}</div>
          {toggle('playback.safeGuides', 'pv-safe', t('pvSafe'))}
          {toggle('playback.thirds', 'pv-thirds', t('pvThirds'))}
          {toggle('playback.frameStats', 'pv-stats', t('pvStats'))}
        </CtxMenu>
      )}
    </>
  )
}
