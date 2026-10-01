// K9 (canvas K, RULES 12 and 22): sound effects — a clip's in the Inspector's
// «Эффекты звука», a track's in the mixer strip's slots. One block per effect
// (the visual effects' `fx-block` vocabulary): on/off, its sliders, remove.
// Every add, remove and on/off is one undo step; a slider drag is one too.
import { useEffect, useRef, useState } from 'react'
import type { Clip, Track } from '@shared/types'
import { FX_PARAMS, fxDefaults, fxParam, type AudioFx, type AudioFxType, type FxParam } from '@shared/audioFx'
import { useEditor, uid } from '@/state/store'
import { useT, trf, type TKey } from '@/i18n'
import { useDenoise, denoisedPath, denoiseState } from '@/engine/denoise'
import { Icon } from './icons'
import { CtxMenu } from './CtxMenu'

export const FX_NAME: Record<AudioFxType, TKey> = { eq: 'afxEq', comp: 'afxComp', deess: 'afxDeess', denoise: 'afxDenoise' }
const PARAM_NAME: Record<string, TKey> = {
  hp: 'afpHp', lowGain: 'afpLowGain', lowFreq: 'afpLowFreq', midGain: 'afpMidGain', midFreq: 'afpMidFreq', midQ: 'afpMidQ',
  highGain: 'afpHighGain', highFreq: 'afpHighFreq', threshold: 'afpThreshold', ratio: 'afpRatio', knee: 'afpKnee',
  attack: 'afpAttack', release: 'afpRelease', makeup: 'afpMakeup', freq: 'afpFreq', range: 'afpRange', nr: 'afpNr'
}
const UNIT: Record<FxParam['unit'], TKey | ''> = { Hz: 'afuHz', dB: 'afuDb', ms: 'afuMs', '': '', ':1': '' }

export type FxOwner = { clip: Clip } | { track: Track }
const listOf = (o: FxOwner) => ('clip' in o ? o.clip.audioFx : o.track.audioFx) ?? []
function write(o: FxOwner, list: AudioFx[]) {
  const st = useEditor.getState()
  const audioFx = list.length ? list : undefined
  if ('clip' in o) st.updateClip(o.clip.id, { audioFx })
  else st.updateTrack(o.track.id, { audioFx })
}

/** add one effect (one undo step); returns its id */
export function addFx(o: FxOwner, type: AudioFxType): string {
  const fx: AudioFx = { id: uid(), type, enabled: true, params: fxDefaults(type) }
  useEditor.getState().pushHistory('hEffect')
  write(o, [...listOf(o), fx])
  return fx.id
}
export function patchFx(o: FxOwner, id: string, patch: Partial<AudioFx>) {
  write(o, listOf(o).map((f) => (f.id === id ? { ...f, ...patch } : f)))
}
export function removeFx(o: FxOwner, id: string) {
  useEditor.getState().pushHistory('hEffect')
  write(o, listOf(o).filter((f) => f.id !== id))
}
export function toggleFx(o: FxOwner, id: string) {
  const f = listOf(o).find((x) => x.id === id)
  if (!f) return
  useEditor.getState().pushHistory('hEffect')
  patchFx(o, id, { enabled: !f.enabled })
}

function valueText(t: (k: TKey) => string, p: FxParam, v: number): string {
  if (p.key === 'hp' && v <= 0) return t('afpOff')
  const k = p.unit === 'Hz' && v >= 1000
  const n = k ? String(+(v / 1000).toFixed(2)) : String(+v.toFixed(p.step < 1 ? 1 : 0))
  const u = p.unit === ':1' ? ':1' : k ? ` ${t('afuKhz')}` : UNIT[p.unit] ? ` ${t(UNIT[p.unit] as TKey)}` : ''
  return `${n.replace('-', '−')}${u}`
}

/** the denoise copy's state under its slider: being prepared, or why it failed */
function DenoiseNote({ clip, nr }: { clip: Clip; nr: number }) {
  const t = useT()
  const path = useEditor((s) => s.project.assets.find((a) => a.id === clip.assetId)?.path)
  useDenoise((s) => s.files)
  useDenoise((s) => s.status)
  useEffect(() => { if (path) denoisedPath(path, nr) }, [path, nr]) // starts the build if nobody has yet
  if (!path) return null
  const st = denoiseState(path, nr)
  if (st === 'ready') return null
  return (
    <div className="cg-hint" data-denoise={st === 'busy' ? 'busy' : 'failed'}>
      <span>{st === 'busy' ? t('afxDenoiseBusy') : trf('afxDenoiseFail', { error: st })}</span>
    </div>
  )
}

export function FxBlock({ owner, fx }: { owner: FxOwner; fx: AudioFx }) {
  const t = useT()
  // a drag, or a run of keys until the slider loses focus, is one undo step (as the Inspector's sound rows)
  const run = useRef(false)
  return (
    <div className="fx-block" data-afx={fx.type}>
      <div className="fx-head">
        <label>
          <input type="checkbox" checked={fx.enabled} data-act="afx-on" onChange={() => toggleFx(owner, fx.id)} />
          <span>{t(FX_NAME[fx.type])}</span>
        </label>
        <button className="fx-del" data-act="afx-del" title={t('fxDelete')} aria-label={t('fxDelete')}
                onClick={() => removeFx(owner, fx.id)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {FX_PARAMS[fx.type].map((p) => {
        const v = fxParam(fx, p.key)
        const label = t(PARAM_NAME[p.key])
        return (
          <label className="insp-field fx-slider" key={p.key} data-afp={p.key}>
            <span>{label}</span>
            <input
              type="range" aria-label={label} min={p.min} max={p.max} step={p.step} value={v}
              onPointerDown={() => { run.current = true; useEditor.getState().pushHistory('hEffect') }}
              onKeyDown={() => { if (!run.current) { run.current = true; useEditor.getState().pushHistory('hEffect') } }}
              onPointerUp={() => { run.current = false }}
              onBlur={() => { run.current = false }}
              onDoubleClick={() => { useEditor.getState().pushHistory('hEffect'); patchFx(owner, fx.id, { params: { ...fx.params, [p.key]: p.def } }) }}
              onChange={(e) => patchFx(owner, fx.id, { params: { ...fx.params, [p.key]: Number(e.target.value) } })}
            />
            <span className="fx-val" style={{ width: 'auto', minWidth: 52, whiteSpace: 'nowrap' }}>{valueText(t, p, v)}</span>
          </label>
        )
      })}
      {fx.type === 'denoise' && fx.enabled && 'clip' in owner && <DenoiseNote clip={owner.clip} nr={fxParam(fx, 'nr')} />}
    </div>
  )
}

/** the type menu of «+ Эффект» */
export function FxAddMenu({ x, y, types, onPick, onClose }: {
  x: number; y: number; types: AudioFxType[]; onPick: (t: AudioFxType) => void; onClose: () => void
}) {
  const t = useT()
  useEffect(() => {
    document.addEventListener('pointerdown', onClose)
    return () => document.removeEventListener('pointerdown', onClose)
  }, [onClose])
  return (
    <CtxMenu x={x} y={y}>
      {types.map((ty) => (
        <button key={ty} data-afx-add={ty} onClick={() => { onPick(ty); onClose() }}>{t(FX_NAME[ty])}</button>
      ))}
    </CtxMenu>
  )
}

/**
 * Inspector, «Эффекты звука» (RULES 22): the clip's effects, «+ Эффект клипа»
 * and where the track's are. Denoise is offered on an audio track's clip only —
 * it swaps the element's file, and a video clip's element is its picture too.
 */
export function ClipFxSection({ clip }: { clip: Clip }) {
  const t = useT()
  const onAudioTrack = useEditor((s) => s.project.tracks.some((tr) => tr.kind === 'audio' && tr.clips.some((c) => c.id === clip.id)))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => setMenu(null), [clip.id])
  const list = clip.audioFx ?? []
  const types: AudioFxType[] = ['eq', 'comp', 'deess', ...(onAudioTrack && !list.some((f) => f.type === 'denoise') ? ['denoise' as const] : [])]
  const owner = { clip }
  return (
    <>
      <div className="insp-section">{t('inFx')}</div>
      {list.map((fx) => <FxBlock key={fx.id} owner={owner} fx={fx} />)}
      <button className="fx-add" data-act="afx-add" onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.left, y: r.bottom + 4 })
      }} onPointerDown={(e) => e.stopPropagation()}>
        <Icon name="plus" size={13} /> {t('inFxAdd')}
      </button>
      <div className="cg-hint">{t('inFxWhere')}</div>
      {menu && <FxAddMenu x={menu.x} y={menu.y} types={types} onPick={(ty) => addFx(owner, ty)} onClose={() => setMenu(null)} />}
    </>
  )
}
