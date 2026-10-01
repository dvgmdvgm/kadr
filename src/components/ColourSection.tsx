// J6: the Inspector's «Цвет» section, landed from canvas J
// (design-source/canvas/J, RULES 4–14, 17): Коррекция (J1), LUT (J2),
// Наложение (J3), Ключ (J4) as disclosure groups with a summary and a reset,
// «До и после» and «Сбросить весь цвет» in the head. Колёса and Кривые are
// J7's. Every write goes through src/engine/colourEdit.ts (one undo step per
// gesture — node scripts/check-colour-ui.mjs).
import type { Clip, Project } from '@shared/types'
import type { GradeKey } from '@shared/colour'
import { GRADE_RANGE } from '@shared/colour'
import { BLEND_MODES, type BlendMode } from '@shared/blend'
import { useEditor } from '@/state/store'
import { useT, type TKey } from '@/i18n'
import {
  colourGesture, colourKey, setParam, setKeyColour, toggleKf, resetParam, resetGroup, resetColour, setBlend,
  setKeyMode, setLut, removeLut, paramAnim, paramValue, paramDefault, clipRel, kfState, hasColour,
  type ColourParam, type ColourGroup
} from '@/engine/colourEdit'
import { useColourUi } from '@/engine/colourUi'
import { lutStatus, reloadLut, useLutLoads } from '@/engine/lut'
import { logError } from '@/engine/log'
import { Icon } from './icons'

const fmt = (v: number, signed: boolean) => {
  const r = Number(v.toFixed(2))
  return (signed && r > 0 ? '+' : '') + String(Object.is(r, -0) ? 0 : r)
}
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p
const BLEND_LABEL: Record<BlendMode, TKey> = {
  normal: 'blendNormal', screen: 'blendScreen', multiply: 'blendMultiply', add: 'blendAdd',
  overlay: 'blendOverlay', softLight: 'blendSoftLight', difference: 'blendDifference'
}
const GRADE_LABEL: Record<GradeKey, TKey> = {
  temperature: 'cgTemperature', tint: 'cgTint', exposure: 'cgExposure', contrast: 'cgContrast',
  highlights: 'cgHighlights', shadows: 'cgShadows', saturation: 'cgSaturation'
}
/** an animatable parameter is «changed» when it is keyed or off its neutral value */
const changed = (c: Clip, p: ColourParam) => {
  const a = paramAnim(c, p)
  return !!a && (!!a.keyframes?.length || a.value !== paramDefault(p))
}

/** J3's limit: inside an overlap transition or an edge effect the mode does nothing */
function inTransition(p: Project, c: Clip) {
  if ((c.transitionIn?.duration ?? 0) > 0.001 || (c.transitionOut?.duration ?? 0) > 0.001) return true
  const tr = p.tracks.find((t) => t.clips.some((x) => x.id === c.id))
  return !!tr?.clips.some((x) => x.id !== c.id && x.start < c.start + c.duration - 1e-6 && x.start + x.duration > c.start + 1e-6)
}

export function ColourSection({ clip }: { clip: Clip }) {
  const t = useT()
  const playhead = useEditor((s) => s.playhead)
  const project = useEditor((s) => s.project)
  const projectPath = useEditor((s) => s.projectPath)
  const open = useColourUi((s) => s.open)
  const compare = useColourUi((s) => s.compare)
  const picking = useColourUi((s) => s.picking)
  useLutLoads((s) => s.n) // a LUT that finished loading changes what the group says
  const rel = clipRel(clip, playhead)
  const id = clip.id

  const row = (p: ColourParam, label: string, min: number, max: number, step: number, signed: boolean) => {
    const v = paramValue(clip, p, rel ?? 0)
    const kf = kfState(clip, p, rel)
    const set = changed(clip, p)
    return (
      <div className="cg-row" key={p} data-param={p} title={t('cgRowTitle').replace('{label}', label)}>
        <span className={set ? 'cg-set' : undefined} onDoubleClick={() => resetParam(id, p)}>{label}</span>
        <input type="range" min={min} max={max} step={step} value={v} aria-label={label}
          onPointerDown={colourGesture} onKeyDown={() => colourKey(p)}
          onChange={(e) => setParam(id, p, Number(e.target.value))} />
        <span className="fx-val">{fmt(v, signed)}</span>
        <button className={`cg-kf${kf === 'on' ? ' on' : kf === 'animated' ? ' cg-animated' : ''}`}
          data-act="cg-kf" disabled={kf === 'outside'} aria-pressed={kf === 'on'}
          title={t(kf === 'on' ? 'cgKfDel' : kf === 'animated' ? 'cgKfAddHere' : kf === 'outside' ? 'cgKfOutside' : 'cgKfAdd')}
          aria-label={t(kf === 'on' ? 'cgKfDel' : 'cgKfAdd')}
          onClick={() => toggleKf(id, p)}>
          <Icon name="diamond" size={12} />
        </button>
      </div>
    )
  }
  const grade = (k: GradeKey) => {
    const [lo, hi] = GRADE_RANGE[k]
    return row(`grade.${k}`, t(GRADE_LABEL[k]), lo, hi, k === 'exposure' ? 0.05 : 0.01, true)
  }
  const group = (g: ColourGroup, title: string, sum: string, mod: boolean, body: () => React.ReactNode) => {
    const isOpen = open.includes(g)
    const reset = t('cgReset').replace('{group}', title)
    return (
      <div className="cg-group" data-group={g}>
        <div className="cg-head">
          <button className="cg-toggle" aria-expanded={isOpen} data-act={`cg-toggle-${g}`}
            onClick={() => useColourUi.getState().toggleGroup(g)}>
            <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            {title}
            {mod && <span className="cg-mod" title={t('cgModified')} />}
            <span className="cg-sum">{sum}</span>
          </button>
          <button className="ghost icon-only" data-act={`cg-reset-${g}`} title={reset} aria-label={reset}
            disabled={!mod} onClick={() => resetGroup(id, g)}>
            <Icon name="reload" size={13} />
          </button>
        </div>
        {isOpen && body()}
      </div>
    )
  }

  // Коррекция
  const nGrade = (Object.keys(GRADE_LABEL) as GradeKey[]).filter((k) => changed(clip, `grade.${k}`)).length

  // LUT
  const lut = clip.lut
  const st = lut ? lutStatus(lut.path) : null
  const lutFile = lut ? fileName(lut.path) : ''
  const pickLut = async () => {
    try {
      const src = await window.kadr.openLutDialog()
      if (!src) return
      setLut(id, projectPath ? await window.kadr.lutImport(src, projectPath) : src)
    } catch (e) {
      logError(t('lgLut'), String((e as Error)?.message ?? e))
    }
  }
  const lutSize = st?.state === 'ok' ? (st.lut.dim === 3 ? `${st.lut.size}³` : `1D ${st.lut.size}`) : ''
  const relPath = lut && projectPath && lut.path.replace(/\\/g, '/').includes('/kadr-lib/luts/')
    ? 'kadr-lib/luts/' + lutFile : lut?.path ?? ''

  // Ключ
  const key = clip.key
  const keyMode = key?.mode ?? 'off'

  return (
    <>
      <div className="insp-section">
        {t('cgTitle')}
        <button className={`ghost icon-only${compare ? ' toggled' : ''}`} style={{ marginLeft: 'auto' }}
          data-act="cg-compare" aria-pressed={compare} title={t('cgCompare')} aria-label={t('cgCompare')}
          onClick={() => useColourUi.setState({ compare: !compare })}>
          <Icon name="compare" size={13} />
        </button>
        <button className="ghost icon-only" data-act="cg-reset-all" title={t('cgResetAll')} aria-label={t('cgResetAll')}
          disabled={!hasColour(clip)} onClick={() => resetColour(id)}>
          <Icon name="reload" size={13} />
        </button>
      </div>

      {group('prim', t('cgGroupPrim'),
        nGrade ? t('cgChanged').replace('{n}', String(nGrade)).replace('{m}', '7') : t('cgNeutral'),
        !!clip.grade, () => (
          <>
            <div className="cg-sub">{t('cgWb')}</div>
            {grade('temperature')}{grade('tint')}
            <div className="cg-sub">{t('cgTone')}</div>
            {grade('exposure')}{grade('contrast')}{grade('highlights')}{grade('shadows')}
            <div className="cg-sub">{t('cgColourSub')}</div>
            {grade('saturation')}
          </>
        ))}

      {group('lut', t('cgGroupLut'),
        !lut ? t('cgNone') : st && (st.state === 'missing' || st.state === 'bad') ? t('cgLutMissingSum')
          : t('cgLutSum').replace('{file}', lutFile).replace('{pct}', String(Math.round(paramValue(clip, 'lut.intensity', rel ?? 0) * 100))),
        !!lut, () => !lut ? (
          <>
            <button className="fx-add" data-act="cg-lut-pick" style={{ width: '100%' }} onClick={pickLut}>
              <Icon name="folderOpen" size={13} /> {t('cgLutPick')}
            </button>
            <div className="cg-hint" style={{ marginTop: 'var(--s3)' }}>{t(projectPath ? 'cgLutCopies' : 'cgLutUnsaved')}</div>
          </>
        ) : st && (st.state === 'missing' || st.state === 'bad') ? (
          <>
            <div className="tr-error" data-act="cg-lut-error"><Icon name="alert" size={15} />
              <span>{t(st.state === 'missing' ? 'cgLutMissing' : 'cgLutBad').replace('{file}', lutFile)}</span>
            </div>
            <div className="insp-field">
              <button className="cg-file" data-act="cg-lut-pick" title={t('cgLutPick')} onClick={pickLut}>
                <Icon name="folderOpen" size={13} /> {t('cgLutPick')}
              </button>
              <button className="ghost icon-only" data-act="cg-lut-reread" title={t('cgLutReread')} aria-label={t('cgLutReread')}
                onClick={() => void reloadLut(lut.path)}>
                <Icon name="reload" size={13} />
              </button>
            </div>
            {row('lut.intensity', t('cgIntensity'), 0, 1, 0.01, false)}
          </>
        ) : (
          <>
            <div className="insp-field">
              <button className="cg-file" data-act="cg-lut-pick" onClick={pickLut}
                title={t('cgLutWhere').replace('{path}', relPath).replace(' · {size}', lutSize ? ` · ${lutSize}` : '')}>
                <Icon name="film" size={13} /> {lutFile}
              </button>
              <button className="ghost icon-only" data-act="cg-lut-remove" title={t('cgLutRemove')} aria-label={t('cgLutRemove')}
                onClick={() => removeLut(id)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            {row('lut.intensity', t('cgIntensity'), 0, 1, 0.01, false)}
          </>
        ))}

      {group('blend', t('cgGroupBlend'), t(BLEND_LABEL[clip.blend ?? 'normal']), !!clip.blend, () => (
        <>
          <label className="insp-field">
            <span>{t('cgBlendMode')}</span>
            <select data-act="cg-blend" value={clip.blend ?? 'normal'} onChange={(e) => setBlend(id, e.target.value as BlendMode)}>
              {BLEND_MODES.map((m) => <option key={m} value={m}>{t(BLEND_LABEL[m])}</option>)}
            </select>
          </label>
          {clip.blend && inTransition(project, clip) && (
            <div className="cg-hint"><Icon name="alert" size={13} /><span>{t('cgBlendTransition')}</span></div>
          )}
        </>
      ))}

      {group('key', t('cgGroupKey'),
        !key ? t('cgOff') : t(key.mode === 'chroma' ? 'cgChromaSum' : 'cgLumaSum').replace('{hex}', key.colour.toUpperCase()),
        !!key, () => (
          <>
            <div className="cg-seg" role="group" aria-label={t('cgGroupKey')}>
              {(['off', 'chroma', 'luma'] as const).map((m) => (
                <button key={m} className={`ghost${m === keyMode ? ' toggled' : ''}`} aria-pressed={m === keyMode}
                  data-act={`cg-key-${m}`} onClick={() => setKeyMode(id, m)}>
                  {t(m === 'off' ? 'cgKeyOff' : m === 'chroma' ? 'cgChroma' : 'cgLuma')}
                </button>
              ))}
            </div>
            {key && (
              <>
                <div className="insp-field">
                  <span>{t('cgKeyColour')}</span>
                  <span className="insp-inline" style={{ flex: 1, justifyContent: 'flex-end' }}>
                    <span className="cg-hex">{key.colour.toUpperCase()}</span>
                    <input type="color" data-act="cg-key-colour" value={key.colour} aria-label={t('cgKeyColour')}
                      onPointerDown={colourGesture} onFocus={colourGesture}
                      onChange={(e) => setKeyColour(id, e.target.value)} />
                    <button className={`ghost icon-only${picking === id ? ' toggled' : ''}`} data-act="cg-pipette"
                      aria-pressed={picking === id} title={t('cgPipette')} aria-label={t('cgPipette')}
                      onClick={() => useColourUi.setState({ picking: picking === id ? null : id })}>
                      <Icon name="pipette" size={14} />
                    </button>
                  </span>
                </div>
                {picking === id && (
                  <div className="cg-hint"><Icon name="pipette" size={13} /><span>{t('cgPipetteHint')}</span></div>
                )}
                {row('key.tolerance', t('cgTolerance'), 0, 1, 0.01, false)}
                {row('key.softness', t('cgSoftness'), 0, 1, 0.01, false)}
                {key.mode === 'chroma' && (
                  <>
                    {row('key.spill', t('cgSpill'), 0, 1, 0.01, false)}
                    <div className="cg-hint"><Icon name="alert" size={13} /><span>{t('cgSpillWarn')}</span></div>
                  </>
                )}
              </>
            )}
          </>
        ))}
    </>
  )
}
