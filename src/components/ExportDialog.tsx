import { useEffect, useRef, useState } from 'react'
import type { ExportProgress } from '@shared/types'
import {
  PRESETS, presetName, videoCodecLabel, audioCodecLabel, allPresets, isUserPreset, useExportPresets,
  saveExportPreset, renameExportPreset, deleteExportPreset
} from '@/presets'
import { fileNameFrom } from '@shared/exportPresets'
import { effective, type SettingKey } from '@shared/settings'
import { startExport, type ExportHandle } from '@/engine/exporter'
import { useVoiceUi } from '@/engine/voiceCheck'
import { useEditor, useSettings, setting, projectDuration } from '@/state/store'
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
  const userPresets = useExportPresets((s) => s.presets)
  // the «Экспорт» settings ARE the dialog's state: every change is written
  // back, so the next opening (and the next launch) starts from the last choice
  const snap = useSettings((s) => s.snap)
  const on = (k: SettingKey) => effective(k, snap).value === true
  const presetId = String(effective('export.preset', snap).value)
  const motionBlur = on('export.motionBlur')
  const frameBlending = on('export.frameBlending')
  const fastEncoder = on('export.fastEncoder')
  const put = useSettings.getState().set
  // the preset name being typed: null = not editing; `mode` says what OK does
  const [naming, setNaming] = useState<{ mode: 'save' | 'rename'; name: string } | null>(null)
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
  const presets = [...userPresets, ...PRESETS]
  const preset = presets.find((p) => p.id === presetId) ?? PRESETS[0]
  const own = isUserPreset(preset)
  const fileName = fileNameFrom(setting<string>('export.fileName'),
    { project: project.name, preset: presetName(preset), date: new Date() })

  function choose(id: string) {
    put('export.preset', id)
    const p = allPresets().find((x) => x.id === id)
    // a user preset carries its render options
    if (p && isUserPreset(p)) {
      put('export.motionBlur', p.motionBlur)
      put('export.frameBlending', p.frameBlending)
      put('export.fastEncoder', p.fastEncoder)
    }
  }

  function commitName() {
    const name = naming?.name.trim()
    if (naming && name) {
      if (naming.mode === 'rename') renameExportPreset(preset.id, name)
      else choose(saveExportPreset(preset, { motionBlur, frameBlending, fastEncoder }, name).id)
    }
    setNaming(null)
  }

  async function begin() {
    const s = useEditor.getState()
    const ext = preset.container
    const out = await window.kadr.exportDialog(fileName, ext)
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
      {naming ? (
        <div className="export-preset-row">
          <input type="text" className="export-preset" aria-label={t('exPresetName')} autoFocus
                 placeholder={t('exPresetName')} value={naming.name}
                 onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') commitName()
                   // Escape leaves the name field, not the dialog
                   if (e.key === 'Escape') { e.stopPropagation(); setNaming(null) }
                 }} />
          <button className="primary" disabled={!naming.name.trim()} onClick={commitName}>{t('save')}</button>
          <button onClick={() => setNaming(null)}>{t('cancel')}</button>
        </div>
      ) : (
        <div className="export-preset-row">
          <select className="export-preset" aria-label={t('preset')} value={preset.id} disabled={running}
                  onChange={(e) => choose(e.target.value)}>
            {userPresets.length > 0 && (
              <optgroup label={t('exMyPresets')}>
                {userPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            )}
            <optgroup label={t('exBuiltin')}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{presetName(p)}</option>)}
            </optgroup>
          </select>
          <button className="ghost icon-only" title={t('exSaveAs')} aria-label={t('exSaveAs')} disabled={running}
                  onClick={() => setNaming({ mode: 'save', name: '' })}><Icon name="save" /></button>
          <button className="ghost icon-only" title={t('exRename')} aria-label={t('exRename')} disabled={running || !own}
                  onClick={() => setNaming({ mode: 'rename', name: preset.name })}><Icon name="pencil" /></button>
          <button className="ghost icon-only" title={t('exDeletePreset')} aria-label={t('exDeletePreset')}
                  disabled={running || !own}
                  onClick={() => { deleteExportPreset(preset.id); put('export.preset', null) }}><Icon name="trash" /></button>
        </div>
      )}

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
              onChange={(e) => put('export.motionBlur', e.target.checked)}
            />
            {t('motionBlur')}
          </label>
          <label className="anim-check export-mb" title={t('frameBlendingHint')}>
            <input
              type="checkbox"
              checked={frameBlending}
              disabled={running}
              onChange={(e) => put('export.frameBlending', e.target.checked)}
            />
            {t('frameBlending')}
          </label>
          <label className="anim-check export-mb" title={t('fastEncoderHint')}>
            <input
              type="checkbox"
              checked={fastEncoder}
              disabled={running}
              onChange={(e) => put('export.fastEncoder', e.target.checked)}
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
      {value(t('exName'), `${fileName}.${preset.container}`)}
      <div className="dim">{t('exAskPath')}</div>
    </Modal>
  )
}
