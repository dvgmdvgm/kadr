import { useEffect, useState } from 'react'
import { FPS_PRESETS, fpsLabel } from '@shared/projectFormat'
import { mediaKindOfPath } from '@shared/sequences'
import { useImportSummary } from '@/engine/mediaImport'
import { useEditor } from '@/state/store'
import { Modal } from './Modal'
import { useT, trPlural, trf } from '../i18n'

const rate = ([n, d]: readonly [number, number]) => n / d
const nearestPreset = (fps: number) =>
  FPS_PRESETS.reduce((b, p, i) => (Math.abs(rate(p) - fps) < Math.abs(rate(FPS_PRESETS[b]) - fps) ? i : b), 0)

/**
 * What a dropped or picked folder (or a numbered run of stills) brings in,
 * asked BEFORE anything is imported (card H6): counts by kind, what was
 * skipped, and each run of frames — one clip at the chosen fps, or stills.
 */
export function ImportSummary() {
  const t = useT()
  const scan = useImportSummary((s) => s.scan)
  const answer = useImportSummary((s) => s.answer)
  const projectFps = useEditor((s) => s.project.fps)
  const [fpsIdx, setFpsIdx] = useState(0)
  const [clips, setClips] = useState<boolean[]>([])
  useEffect(() => {
    if (!scan) return
    setClips(scan.sequences.map(() => true))
    setFpsIdx(nearestPreset(projectFps))
  }, [scan])
  if (!scan || !answer) return null
  const fps = rate(FPS_PRESETS[fpsIdx])
  const count = (k: string) => scan.files.filter((f) => mediaKindOfPath(f) === k).length
  const counts = [['impVideo', count('video')], ['impAudio', count('audio')], ['impImages', count('image')]] as const
  const other = scan.files.length - counts.reduce((s, [, n]) => s + n, 0)
  const empty = !scan.files.length && !scan.sequences.length
  const cancel = () => answer(null)
  return (
    <Modal
      title={t('impTitle')}
      onClose={cancel}
      actions={empty ? <button onClick={cancel}>{t('close')}</button> : (
        <>
          <button onClick={cancel} data-act="import-cancel">{t('cancel')}</button>
          <button className="primary" data-act="import-go" onClick={() => answer({ fps, clips: scan.sequences.map((_, i) => clips[i] ?? true) })}>{t('impGo')}</button>
        </>
      )}
    >
      {empty ? <p>{t('impNone')}</p> : (
        <p data-act="import-counts">
          {counts.filter(([, n]) => n).map(([k, n]) => `${t(k)}: ${n}`).concat(other ? [`${t('impOther')}: ${other}`] : []).join(' · ')}
        </p>
      )}
      {scan.skipped > 0 && <p className="dim">{trf('impSkipped', { n: scan.skipped })}</p>}
      {scan.sequences.length > 0 && (
        <>
          <div className="dim">{t('impSeqHead')}</div>
          {scan.sequences.map((s, i) => (
            <label className="anim-check" key={s.pattern + s.first}>
              <input type="checkbox" data-act="import-seq" checked={clips[i] ?? true}
                     onChange={(e) => setClips((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />{' '}
              <span className="recent-name">{s.name}</span>{' '}
              <span className="recent-meta">
                {clips[i] ?? true
                  ? trf('impSeqClip', { n: s.count, frames: trPlural('impFrames', s.count), s: (s.count / fps).toFixed(1) })
                  : trf('impSeqStills', { n: s.count })}
              </span>
            </label>
          ))}
          <label className="anim-check">
            {t('impSeqFps')}{' '}
            <select data-act="import-fps" value={fpsIdx} onChange={(e) => setFpsIdx(Number(e.target.value))}>
              {FPS_PRESETS.map((p, i) => <option key={i} value={i}>{fpsLabel(rate(p))}</option>)}
            </select>
          </label>
        </>
      )}
    </Modal>
  )
}
