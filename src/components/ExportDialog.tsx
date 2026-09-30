import { useEffect, useRef, useState } from 'react'
import type { ExportPreset, ExportProgress } from '@shared/types'
import {
  PRESETS, presetName, videoCodecLabel, audioCodecLabel, allPresets, isUserPreset, useExportPresets,
  saveExportPreset, renameExportPreset, deleteExportPreset
} from '@/presets'
import { fileNameFrom, withOutput } from '@shared/exportPresets'
import { X264_PRESETS, VIDEO_ENCODERS, type OutputFit, type VideoEncoder } from '@shared/rawEncode'
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
  const quality: 'abr' | 'crf' = effective('export.quality', snap).value === 'crf' ? 'crf' : 'abr'
  const crf = Number(effective('export.crf', snap).value)
  const x264Preset = String(effective('export.x264Preset', snap).value)
  // G5: the encoder the user chose, and the hardware ones that open here (null = still probing)
  const chosenEncoder = String(effective('export.videoEncoder', snap).value) as VideoEncoder
  const [hwEncoders, setHwEncoders] = useState<string[] | null>(null)
  // G4: the dialog's own size / fps / bitrate over the preset's (0 = the preset's) and the fit
  const num = (k: SettingKey) => Number(effective(k, snap).value) || 0
  const out = {
    width: num('export.width'), height: num('export.height'), fps: num('export.fps'), bitrate: num('export.bitrate'),
    fit: String(effective('export.fit', snap).value) as OutputFit
  }
  const custom = out.width > 0 || out.height > 0 || out.fps > 0 || out.bitrate > 0
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

  useEffect(() => {
    if (open) void window.kadr.hwEncoders().then(setHwEncoders, () => setHwEncoders([]))
  }, [open])

  if (!open) return null
  const running = status.kind === 'running'
  const presets = [...userPresets, ...PRESETS]
  const preset = presets.find((p) => p.id === presetId) ?? PRESETS[0]
  // rate control is x264's (G3): VP9 and MP3 keep their preset as it is
  const x264 = preset.ffmpegVideo === 'copy' && !preset.audioOnly
  const shaped = preset.audioOnly ? preset : withOutput(preset, out)
  const works = (e: VideoEncoder) => e === 'x264' || !!hwEncoders?.includes(`h264_${e}`)
  // one chosen on another machine (or not probed yet) encodes on x264 — the select says so
  const videoEncoder: VideoEncoder = works(chosenEncoder) ? chosenEncoder : 'x264'
  const hw = videoEncoder !== 'x264'
  const job: ExportPreset = x264 ? { ...shaped, rateControl: quality, crf, x264Preset, videoEncoder } : shaped
  const own = isUserPreset(preset)
  const fileName = fileNameFrom(setting<string>('export.fileName'),
    { project: project.name, preset: presetName(preset), date: new Date() })

  const resetOutput = () => (['export.width', 'export.height', 'export.fps', 'export.bitrate'] as const)
    .forEach((k) => put(k, null))

  function choose(id: string) {
    put('export.preset', id)
    // a preset IS a size, rate and bitrate: choosing one drops the dialog's own
    resetOutput()
    const p = allPresets().find((x) => x.id === id)
    // a user preset carries its render options
    if (p && isUserPreset(p)) {
      put('export.motionBlur', p.motionBlur)
      put('export.frameBlending', p.frameBlending)
      put('export.fastEncoder', p.fastEncoder)
      put('export.quality', p.rateControl ?? 'abr')
      put('export.crf', p.crf ?? 18)
      put('export.x264Preset', p.x264Preset ?? 'faster')
      put('export.videoEncoder', p.videoEncoder ?? 'x264')
      put('export.fit', p.fit ?? 'fit')
    }
  }

  function commitName() {
    const name = naming?.name.trim()
    if (naming && name) {
      if (naming.mode === 'rename') renameExportPreset(preset.id, name)
      else choose(saveExportPreset(job, { motionBlur, frameBlending, fastEncoder }, name).id)
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
      job,
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
  const width = job.width === 'project' ? project.width : job.width
  const height = job.height === 'project' ? project.height : job.height
  const fps = job.fps === 'project' ? project.fps : job.fps
  // committed on blur / Enter: a half-typed «1» of «1080» must not become the size
  const numIn = (k: SettingKey, v: number, label: string, min: number, max: number, step: number | 'any' = 1) => (
    <input type="number" aria-label={label} key={`${k}:${v}`} defaultValue={v} min={min} max={max} step={step}
           disabled={running}
           onBlur={(e) => {
             const n = Number(e.target.value.replace(',', '.'))
             if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) { if (n !== v) put(k, n) }
             else e.target.value = String(v)
           }}
           onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
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
          <div className="insp-field">
            <span>{t('exSize')}</span>
            <span className="export-size">
              {numIn('export.width', width, t('exWidth'), 16, 8192, 2)}×{numIn('export.height', height, t('exHeight'), 16, 8192, 2)}
              {asProject(job.width)}
              {custom && (
                <button className="ghost icon-only" title={t('exReset')} aria-label={t('exReset')} disabled={running}
                        onClick={resetOutput}><Icon name="undo" /></button>
              )}
            </span>
          </div>
          {(width !== project.width || height !== project.height) && (
            <div className="insp-field">
              <span>{t('exFit')}</span>
              <select aria-label={t('exFit')} value={out.fit} disabled={running}
                      onChange={(e) => put('export.fit', e.target.value)}>
                <option value="fit">{t('exFitFit')}</option>
                <option value="fill">{t('exFitFill')}</option>
                <option value="stretch">{t('exFitStretch')}</option>
              </select>
            </div>
          )}
          <div className="insp-field">
            <span>{t('exFps')}</span>
            <span className="export-size">{numIn('export.fps', fps, t('exFps'), 1, 240, 'any')} {t('fpsUnit')}{asProject(job.fps)}</span>
          </div>
          {/* the fast encoder is Chromium's: it takes no x264 rate control */}
          {value(t('exCodec'), videoCodecLabel(fastEncoder ? shaped : job))}
          {!(x264 && quality === 'crf' && !fastEncoder) && (
            <div className="insp-field">
              <span>{t('exBitrate')}</span>
              <span className="export-size">
                {numIn('export.bitrate', +(job.videoBitrate / 1e6).toFixed(1), t('exBitrate'), 0.1, 400, 'any')} {t('mbpsUnit')}
              </span>
            </div>
          )}
          {x264 && (
            <>
              <div className="insp-field">
                <span>{t('exEncoder')}</span>
                <select aria-label={t('exEncoder')} value={videoEncoder} disabled={running || fastEncoder}
                        title={fastEncoder ? t('fastEncoderHint') : undefined}
                        onChange={(e) => put('export.videoEncoder', e.target.value)}>
                  {VIDEO_ENCODERS.map((e) => (
                    <option key={e} value={e} disabled={!works(e)}>
                      {t(`enc${e}`)}{hwEncoders && !works(e) ? ` — ${t('encMissing')}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="insp-field">
                <span>{t('exQuality')}</span>
                <select aria-label={t('exQuality')} value={quality} disabled={running || fastEncoder}
                        title={fastEncoder ? t('fastEncoderHint') : undefined}
                        onChange={(e) => put('export.quality', e.target.value)}>
                  <option value="abr">{t('exQualityAbr')}</option>
                  <option value="crf">{t(hw ? 'exQualityCq' : 'exQualityCrf')}</option>
                </select>
              </div>
              {quality === 'crf' && (
                <div className="insp-field" title={t(hw ? 'exCqHint' : 'exCrfHint')}>
                  <span>{t(hw ? 'exCq' : 'exCrf')}</span>
                  <input type="number" aria-label={t(hw ? 'exCq' : 'exCrf')} min={0} max={51} step={1} value={crf}
                         disabled={running || fastEncoder}
                         onChange={(e) => {
                           const n = Math.round(Number(e.target.value))
                           if (e.target.value !== '' && n >= 0 && n <= 51) put('export.crf', n)
                         }} />
                </div>
              )}
              {!hw && <div className="insp-field">
                <span>{t('exSpeed')}</span>
                <select aria-label={t('exSpeed')} value={x264Preset} disabled={running || fastEncoder}
                        onChange={(e) => put('export.x264Preset', e.target.value)}>
                  {X264_PRESETS.map((p) => <option key={p} value={p}>{t(`x264${p}`)}</option>)}
                </select>
              </div>}
            </>
          )}
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
