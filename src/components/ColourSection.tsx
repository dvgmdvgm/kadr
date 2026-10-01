// J6: the Inspector's «Цвет» section, landed from canvas J
// (design-source/canvas/J, RULES 4–14, 17): Коррекция (J1), LUT (J2),
// Наложение (J3), Ключ (J4), Колёса and Кривые (J7, RULES 15–16) as disclosure
// groups with a summary and a reset, «До и после» and «Сбросить весь цвет» in
// the head. Every write goes through src/engine/colourEdit.ts (one undo step per
// gesture — node scripts/check-colour-ui.mjs).
import { useRef } from 'react'
import type { Clip, Project } from '@shared/types'
import type { GradeKey } from '@shared/colour'
import { GRADE_RANGE } from '@shared/colour'
import { CURVE_CHS, WHEEL_KEYS, curveFn, wheelChannel, type CurveCh, type Wheel, type WheelKey } from '@shared/curves'
import { BLEND_MODES, type BlendMode } from '@shared/blend'
import { useEditor, findClip } from '@/state/store'
import { useT, type TKey } from '@/i18n'
import {
  colourGesture, colourKey, setParam, setKeyColour, toggleKf, resetParam, resetGroup, resetColour, setBlend,
  setKeyMode, setLut, removeLut, paramAnim, paramValue, paramDefault, clipRel, kfState, hasColour,
  setWheel, resetWheel, addCurvePoint, moveCurvePoint, removeCurvePoint,
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

// ── J7 ────────────────────────────────────────────────────────────────────────
const WHEEL_LABEL: Record<WheelKey, TKey> = { lift: 'cgLift', gamma: 'cgGamma', gain: 'cgGain' }
const CH_LABEL: Record<CurveCh, TKey> = { y: 'cgChY', r: 'cgChR', g: 'cgChG', b: 'cgChB' }
const W0: Wheel = { x: 0, y: 0, level: 0 }
/** the hue a puck points at, as one of six names; -1 = no shift */
const hueOf = (w: Wheel) => Math.hypot(w.x, w.y) < 0.02 ? -1
  : Math.round((((Math.atan2(w.y, w.x) * 180) / Math.PI + 360) % 360) / 60) % 6
const hueKey = (i: number) => `cgHue${i}` as TKey
/** Russian plural of «точка» (the English strings are the same for 2 and 5) */
const ptsKey = (n: number): TKey =>
  n % 10 === 1 && n % 100 !== 11 ? 'cgPts1' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'cgPts2' : 'cgPts5'

/** the disc behind the puck IS the wheel's function: mid-grey pushed by each position's shift */
let disc: string | null = null
function discImage() {
  if (disc) return disc
  const S = 136, cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(S, S)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / (S / 2) - 1, dy = (y + 0.5) / (S / 2) - 1, r = Math.hypot(dx, dy)
    const w = { x: dx / Math.max(1, r), y: dy / Math.max(1, r), level: 0 }
    const i = (y * S + x) * 4
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(Math.min(1, Math.max(0, 0.36 + 0.4 * wheelChannel(w, c))) * 255)
    img.data[i + 3] = Math.round(Math.min(1, Math.max(0, (1 - r) * (S / 2))) * 255)
  }
  ctx.putImageData(img, 0, 0)
  return (disc = cv.toDataURL())
}

function WheelControl({ id, k, w }: { id: string; k: WheelKey; w: Wheel }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<[number, number] | null>(null)
  const label = t(WHEEL_LABEL[k])
  const at = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1]
  }
  // a drag reads the wheel as the store has it now, not as this render saw it
  const cur = () => findClip(useEditor.getState().project, id)?.clip.wheels?.[k] ?? W0
  const hue = hueOf(w)
  return (
    <div className="cg-wheel" data-wheel={k}>
      <div ref={ref} className="cg-disc" role="slider" tabIndex={0} data-act={`cg-disc-${k}`}
        aria-label={t('cgWheelColour').replace('{label}', label)}
        aria-valuetext={hue < 0 ? t('cgHueNone') : t(hueKey(hue))}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          colourGesture()
          const p = at(e)
          last.current = p
          // Shift starts a fine drag where the puck is; a plain press puts it under the cursor
          if (!e.shiftKey) setWheel(id, k, { x: p[0], y: p[1] })
        }}
        onPointerMove={(e) => {
          const l = last.current
          if (!l) return
          const p = at(e), f = e.shiftKey ? 0.2 : 1, c = cur()
          last.current = p
          setWheel(id, k, { x: c.x + (p[0] - l[0]) * f, y: c.y + (p[1] - l[1]) * f })
        }}
        onPointerUp={() => { last.current = null }}
        onPointerCancel={() => { last.current = null }}
        onDoubleClick={() => resetWheel(id, k)}
        onKeyDown={(e) => {
          const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key]
          if (!d) return
          e.preventDefault()
          colourKey(`wheels.${k}`)
          const s = e.shiftKey ? 0.005 : 0.02, c = cur()
          setWheel(id, k, { x: c.x + d[0] * s, y: c.y + d[1] * s })
        }}>
        <img src={discImage()} alt="" draggable={false} />
        <span className="cg-puck" style={{ left: `${50 + w.x * 50}%`, top: `${50 + w.y * 50}%` }} />
      </div>
      <span>{label}</span>
      <input type="range" min={-1} max={1} step={0.01} value={w.level} data-act={`cg-level-${k}`}
        aria-label={t('cgWheelLevel').replace('{label}', label)}
        onPointerDown={colourGesture} onKeyDown={() => colourKey(`wheels.${k}`)}
        onChange={(e) => setWheel(id, k, { level: Number(e.target.value) })} />
      <span className="fx-val">{fmt(w.level, true)}</span>
    </div>
  )
}

function CurveGraph({ clip }: { clip: Clip }) {
  const t = useT()
  const ch = useColourUi((s) => s.curveCh)
  const ref = useRef<SVGSVGElement>(null)
  const drag = useRef(-1)
  const id = clip.id
  const pts = clip.curves?.[ch] ?? []
  const f = curveFn(pts)
  const at = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]
  }
  /** the point within ~5 px of the cursor, or -1 */
  const hit = (x: number, y: number) => {
    const live = findClip(useEditor.getState().project, id)?.clip.curves?.[ch] ?? []
    let best = -1, bd = 5 / (ref.current?.getBoundingClientRect().width || 240)
    live.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d <= bd) { bd = d; best = i } })
    return best
  }
  const line = 'M' + Array.from({ length: 101 }, (_, i) => `${i} ${(100 - f(i / 100) * 100).toFixed(2)}`).join('L')
  return (
    <svg ref={ref} className="cg-curve" viewBox="0 0 100 100" role="img" data-act="cg-curve"
      aria-label={t('cgCurveLabel').replace('{ch}', ch.toUpperCase())}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        colourGesture()
        const [x, y] = at(e)
        const i = hit(x, y)
        // a click off the points adds one ON the curve; the drag then takes it to the cursor
        drag.current = i >= 0 ? i : addCurvePoint(id, ch, x, f(Math.min(1, Math.max(0, x))))
      }}
      onPointerMove={(e) => { if (drag.current >= 0) moveCurvePoint(id, ch, drag.current, ...at(e)) }}
      onPointerUp={() => { drag.current = -1 }}
      onPointerCancel={() => { drag.current = -1 }}
      onDoubleClick={(e) => { const i = hit(...at(e)); if (i >= 0) removeCurvePoint(id, ch, i) }}>
      <g className="cg-grid">
        {[25, 50, 75].map((v) => <path key={v} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" d={`M${v} 0V100M0 ${v}H100`} />)}
        <path stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" d="M0 100L100 0" />
      </g>
      <g data-ch={ch}>
        <path fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" d={line} />
        {pts.map(([x, y], i) => <circle key={i} cx={x * 100} cy={100 - y * 100} r={2.2} fill="currentColor" />)}
      </g>
    </svg>
  )
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

  // Колёса · Кривые (J7)
  const curveCh = useColourUi((s) => s.curveCh)
  const wheelSum = WHEEL_KEYS.map((k) => {
    const w = clip.wheels?.[k] ?? W0
    const h = hueOf(w)
    if (h < 0 && w.level === 0) return ''
    return [t(WHEEL_LABEL[k]).toLowerCase(), h >= 0 ? t(hueKey(h)) : '', w.level ? fmt(w.level, true) : ''].filter(Boolean).join(' ')
  }).filter(Boolean).join(', ')
  const curveSum = CURVE_CHS.filter((ch) => clip.curves?.[ch]?.length)
    .map((ch) => { const n = clip.curves![ch]!.length; return `${t(CH_LABEL[ch]).toLowerCase()}: ${n} ${t(ptsKey(n))}` }).join(', ')

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

      {group('wheels', t('cgGroupWheels'), wheelSum || t('cgNeutral'), !!clip.wheels, () => (
        <>
          <div className="cg-wheels">
            {WHEEL_KEYS.map((k) => <WheelControl key={k} id={id} k={k} w={clip.wheels?.[k] ?? W0} />)}
          </div>
          <div className="cg-hint">{t('cgWheelHint')}</div>
        </>
      ))}

      {group('curves', t('cgGroupCurves'), curveSum || t('cgNeutral'), !!clip.curves, () => (
        <>
          <div className="cg-seg" role="group" aria-label={t('cgCurveCh')}>
            {CURVE_CHS.map((ch) => (
              <button key={ch} className={`ghost${ch === curveCh ? ' toggled' : ''}`} aria-pressed={ch === curveCh}
                data-act={`cg-ch-${ch}`} title={t(CH_LABEL[ch])} onClick={() => useColourUi.setState({ curveCh: ch })}>
                {ch.toUpperCase()}
              </button>
            ))}
          </div>
          <CurveGraph clip={clip} />
          <div className="cg-hint">{t('cgCurveHint')}</div>
        </>
      ))}
    </>
  )
}
