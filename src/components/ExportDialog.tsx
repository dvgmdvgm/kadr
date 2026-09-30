import { useEffect, useRef, useState } from 'react'
import type { ExportProgress } from '@shared/types'
import { PRESETS, presetName, videoCodecLabel, audioCodecLabel } from '@/presets'
import { startExport, type ExportHandle } from '@/engine/exporter'
import { useVoiceUi } from '@/engine/voiceCheck'
import { useEditor, setting, projectDuration } from '@/state/store'
import { useT } from '@/i18n'
import { Icon } from './icons'
import { Modal } from './Modal'

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; phase: ExportProgress['phase']; progress: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

export function ExportDialog() {
  const checking = useVoiceUi((v) => v.phase === 'check')
  const t = useT()
  const open = useEditor((s) => s.exportOpen)
  const range = useEditor((s) => s.range)
  const project = useEditor((s) => s.project)
  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const [motionBlur, setMotionBlur] = useState(true)
  const [frameBlending, setFrameBlending] = useState(true)
  const [fastEncoder, setFastEncoder] = useState(false)
  // «Экспорт» settings: each opening starts from them
  useEffect(() => {
    if (!open) return
    const p = setting<string>('export.preset')
    setPresetId(PRESETS.some((x) => x.id === p) ? p : PRESETS[0].id)
    setMotionBlur(setting('export.motionBlur') === true)
    setFrameBlending(setting('export.frameBlending') === true)
  }, [open])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const handle = useRef<ExportHandle | null>(null)

  useEffect(() => {
    return window.kadr.onExportProgress((p) => {
      if (p.phase === 'done') setStatus({ kind: 'done' })
      else if (p.phase === 'error') setStatus({ kind: 'error', message: p.message ?? '' })
      else if (p.phase === 'cancelled') setStatus({ kind: 'cancelled' })
      else setStatus({ kind: 'running', phase: p.phase, progress: p.progress })
    })
  }, [])

  if (!open) return null
  const running = status.kind === 'running'
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]

  async function begin() {
    const s = useEditor.getState()
    const ext = preset.container
    const out = await window.kadr.exportDialog(s.project.name, ext)
    if (!out) return
    s.setPlaying(false)
    setStatus({ kind: 'running', phase: 'video', progress: 0 })
    const h = startExport(
      s.project,
      preset,
      out,
      (p) => setStatus({ kind: 'running', phase: p.phase, progress: p.progress }),
      s.range,
      { motionBlur, frameBlending, encoder: fastEncoder ? 'webcodecs' : 'x264' }
    )
    handle.current = h
    h.done.catch((err) => {
      if (String(err?.message).includes('cancelled')) setStatus({ kind: 'cancelled' })
      else setStatus({ kind: 'error', message: String(err?.message ?? err) })
    })
  }

  function cancel() {
    handle.current?.cancel()
    window.kadr.exportCancel()
  }

  function close() {
    if (running) return
    setStatus({ kind: 'idle' })
    useEditor.getState().setExportOpen(false)
  }

  const phaseLabel =
    status.kind === 'running'
      ? status.phase === 'fragments'
        ? t('renderingFragments')
        : status.phase === 'video'
          ? t('renderingVideo')
          : t('mixingAudio')
      : ''

  const asProject = (v: unknown) => (v === 'project' ? ` · ${t('exAsProject')}` : '')
  const width = preset.width === 'project' ? project.width : preset.width
  const height = preset.height === 'project' ? project.height : preset.height
  const fps = preset.fps === 'project' ? project.fps : preset.fps
  const sec = t('secUnit')
  const value = (label: string, v: string) => (
    <div className="insp-field"><span>{label}</span><span className="export-value">{v}</span></div>
  )

  // the status lives in the footer: at the 640 px minimum the body scrolls,
  // and a progress bar under the last section would be out of sight
  const statusLine =
    status.kind === 'running' ? (
      <div className="export-progress">
        <div>{phaseLabel}</div>
        <progress value={status.progress} max={1} />
        <div className="dim">{Math.round(status.progress * 100)}%</div>
      </div>
    ) : status.kind === 'done' ? (
      <div className="export-ok"><Icon name="check" /> {t('exportDone')}</div>
    ) : status.kind === 'cancelled' ? (
      <div className="dim">{t('exportCancelled')}</div>
    ) : status.kind === 'error' ? (
      <div className="export-err">
        <Icon name="alert" size={15} />
        <span>{t('exportError')}: {status.message}</span>
      </div>
    ) : null

  return (
    <Modal
      title={t('export')}
      onClose={close}
      closeDisabled={running}
      titleIcon={<Icon name="download" size={17} />}
      wide
      actions={
        <>
          {statusLine && <div className="export-status">{statusLine}</div>}
          {running ? (
            <button onClick={cancel}>{t('cancel')}</button>
          ) : (
            <button className="primary" disabled={checking} onClick={begin}
                    title={checking ? t('dfLong') : undefined}>
              <Icon name="download" /> {t('startExport')}
            </button>
          )}
        </>
      }
    >
      <div className="insp-section">{t('preset')}</div>
      <select className="export-preset" aria-label={t('preset')} value={presetId} disabled={running}
              onChange={(e) => setPresetId(e.target.value)}>
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{presetName(p)}</option>
        ))}
      </select>

      <div className="insp-section">{t('exVideo')}</div>
      {preset.audioOnly ? (
        <div className="dim">{t('exNoVideo')}</div>
      ) : (
        <>
          {value(t('exSize'), `${width}×${height}${asProject(preset.width)}`)}
          {value(t('exFps'), `${fps} fps${asProject(preset.fps)}`)}
          {value(t('exCodec'), videoCodecLabel(preset))}
          <label className="anim-check export-mb">
            <input
              type="checkbox"
              checked={motionBlur}
              disabled={running}
              onChange={(e) => setMotionBlur(e.target.checked)}
            />
            {t('motionBlur')}
          </label>
          <label className="anim-check export-mb" title={t('frameBlendingHint')}>
            <input
              type="checkbox"
              checked={frameBlending}
              disabled={running}
              onChange={(e) => setFrameBlending(e.target.checked)}
            />
            {t('frameBlending')}
          </label>
          <label className="anim-check export-mb" title={t('fastEncoderHint')}>
            <input
              type="checkbox"
              checked={fastEncoder}
              disabled={running}
              onChange={(e) => setFastEncoder(e.target.checked)}
            />
            {t('fastEncoder')}
          </label>
        </>
      )}

      <div className="insp-section">{t('exAudio')}</div>
      {value(t('exCodec'), audioCodecLabel(preset))}

      <div className="insp-section">{t('exRange')}</div>
      {value(t('duration'), range
        ? `${t('exportRange')}: ${range.start.toFixed(2)}–${range.end.toFixed(2)} ${sec}`
        : `${t('wholeProject')} · ${projectDuration(project).toFixed(2)} ${sec}`)}
      {!range && <div className="dim">{t('rangeHint')}</div>}

      <div className="insp-section">{t('exFile')}</div>
      {value(t('exFormat'), `${preset.container.toUpperCase()} (.${preset.container})`)}
      <div className="dim">{t('exAskPath')}</div>
    </Modal>
  )
}
