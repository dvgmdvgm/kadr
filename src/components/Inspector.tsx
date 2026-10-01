import { useEffect, useMemo, useRef, useState } from 'react'
import type { Anim, Clip, ClipFit, Effect, FragmentInspect, FragmentParamDecl, FxPreset, TextStyle } from '@shared/types'
import { useEditor, useFxPresets, findClip, uid, type ProjectSettingsPatch } from '@/state/store'
import { GLOW_DEFAULTS } from '@/gl/glow'
import { useT } from '@/i18n'
import { bakeAudio, bakeState, bakePlan } from '@/engine/audioReact'
import { audibleTracksInRange } from '@/engine/subtitles'
import { useFragmentParams, paramValues, setParam, resetParams, rememberParamValues } from '@/engine/fragmentParams'
import { CtxMenu } from './CtxMenu'
import { Icon, Spinner } from './icons'
import { fontChoices } from '@/engine/fonts'
import { audioTwin } from '@/engine/timelineSelect'
import { RESOLUTION_PRESETS, FPS_PRESETS, exactFps, fpsLabel } from '@shared/projectFormat'
import { evalAnim } from '@/engine/anim'
import { KF_EPS } from './animUtils'
import { beginMixGesture, setClipAnimAt, toggleKeyAt } from '@/engine/mixer'
import { faderPos, posDb, dbToGain, gainToDb, dbText, panText } from '@shared/fader'

function Num({
  label, value, step = 1, min, max, onChange,
  onFocus = () => useEditor.getState().pushHistory('hEdit'),
  onCommit
}: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange?: (v: number) => void
  onFocus?: () => void
  /** typed digits stay a draft until Enter or leaving the field (a value that
      rounds, like W/H to even, would otherwise rewrite «1» as 2 mid-typing);
      the spinner arrows still apply at once */
  onCommit?: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = Number(draft)
    setDraft(null)
    if (draft.trim() !== '' && !Number.isNaN(v)) onCommit!(v)
  }
  return (
    <label className="insp-field">
      <span>{label}</span>
      <input
        type="number"
        value={draft ?? Number(value.toFixed(3))}
        step={step}
        min={min}
        max={max}
        onFocus={onFocus}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        onChange={(e) => {
          if (onCommit && (e.nativeEvent as InputEvent).inputType) { setDraft(e.target.value); return }
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) (onCommit ?? onChange!)(v)
        }}
      />
    </label>
  )
}

export function Inspector() {
  const t = useT()
  const clipId = useEditor((s) => s.selection[0])
  const found = useEditor((s) => (clipId ? findClip(s.project, clipId) : null))

  return (
    <div className="inspector">
      <div className="panel-head">
        <span>{t('inspector')}</span>
      </div>
      <div className="insp-body">
        {found ? <ClipProps clip={found.clip} /> : <ProjectProps />}
      </div>
    </div>
  )
}

let settingsSession = 0

function ProjectProps() {
  const t = useT()
  const project = useEditor((s) => s.project)
  // one undo step per focus of a field, taken on its first real change
  const session = useRef(0)
  const focus = () => { session.current = ++settingsSession }
  const patch = (p: ProjectSettingsPatch) =>
    useEditor.getState().updateProjectSettings(p, session.current)
  // a list pick is one undo step of its own
  const pick = (p: ProjectSettingsPatch) => useEditor.getState().updateProjectSettings(p)
  const res = RESOLUTION_PRESETS.findIndex(([w, h]) => w === project.width && h === project.height)
  // a hand-typed 29.97 shows as the 29,97 preset and keeps its value until picked
  const rate = FPS_PRESETS.findIndex(([n, d]) => n / d === exactFps(project.fps))
  const [resCustom, setResCustom] = useState(false)
  const [fpsCustom, setFpsCustom] = useState(false)
  const transparent = project.background === 'transparent'
  // unticking «Прозрачный» brings back the colour it replaced
  const lastOpaque = useRef('#000000')
  if (!transparent) lastOpaque.current = project.background

  return (
    <>
      <div className="insp-section">{t('projectSettings')}</div>
      <label className="insp-field">
        <span>{t('label')}</span>
        <input value={project.name} onFocus={focus} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label className="insp-field">
        <span>{t('resolution')}</span>
        <select data-act="project-res" value={resCustom || res < 0 ? 'custom' : String(res)} onChange={(e) => {
          if (e.target.value === 'custom') { setResCustom(true); return }
          const [width, height] = RESOLUTION_PRESETS[Number(e.target.value)]
          setResCustom(false)
          pick({ width, height })
        }}>
          {RESOLUTION_PRESETS.map(([w, h], i) => <option key={i} value={i}>{w} × {h}</option>)}
          <option value="custom">{t('setResCustom')}</option>
        </select>
      </label>
      {(resCustom || res < 0) && (
        <>
          <Num label={`${t('resolution')} W`} value={project.width} step={2} min={16}
            onFocus={focus} onCommit={(v) => patch({ width: Math.max(16, Math.round(v / 2) * 2) })} />
          <Num label={`${t('resolution')} H`} value={project.height} step={2} min={16}
            onFocus={focus} onCommit={(v) => patch({ height: Math.max(16, Math.round(v / 2) * 2) })} />
        </>
      )}
      <label className="insp-field">
        <span>{t('framerate')}</span>
        <select data-act="project-fps" value={fpsCustom || rate < 0 ? 'custom' : String(rate)} onChange={(e) => {
          if (e.target.value === 'custom') { setFpsCustom(true); return }
          const [n, d] = FPS_PRESETS[Number(e.target.value)]
          setFpsCustom(false)
          pick({ fps: n / d })
        }}>
          {FPS_PRESETS.map(([n, d], i) => <option key={i} value={i}>{fpsLabel(n / d).replace('.', ',')}</option>)}
          <option value="custom">{t('setResCustom')}</option>
        </select>
      </label>
      {(fpsCustom || rate < 0) && (
        <Num label={t('framerate')} value={project.fps} step={1} min={1} max={240}
          onFocus={focus} onCommit={(v) => patch({ fps: Math.min(240, Math.max(1, v)) })} />
      )}
      <div className="insp-field">
        <span>{t('setBg')}</span>
        <span className="insp-inline">
          {!transparent && (
            <input type="color" data-act="project-bg" aria-label={t('setBg')} value={project.background}
              onFocus={focus} onChange={(e) => patch({ background: e.target.value })} />
          )}
          <label className="insp-inline">
            <input type="checkbox" data-act="project-bg-transparent" checked={transparent}
              onChange={(e) => pick({ background: e.target.checked ? 'transparent' : lastOpaque.current })} />
            {t('bgTransparent')}
          </label>
        </span>
      </div>
    </>
  )
}

/** F2: every TextStyle field. Colour pickers and number fields take one undo
    step per focus; a checkbox or a list choice is a step of its own. */
function TextStyleRows({ style, set }: { style: TextStyle; set: (p: Partial<TextStyle>) => void }) {
  const t = useT()
  const hist = () => useEditor.getState().pushHistory('hEdit')
  const step = (p: Partial<TextStyle>) => { hist(); set(p) }
  const [fonts, setFonts] = useState<{ project: string[]; system: string[] } | null>(null)
  // the system list needs a user gesture: asked on the first press of the list
  const loadFonts = () => { if (!fonts) void fontChoices(useEditor.getState().projectPath).then(setFonts) }
  const listed = fonts ? [...fonts.project, ...fonts.system] : []
  const color = (k: 'color' | 'outlineColor' | 'background' | 'shadowColor', label: string) => (
    <input type="color" aria-label={label} value={style[k] || '#000000'} onFocus={hist} onChange={(e) => set({ [k]: e.target.value })} />
  )
  return (
    <>
      <label className="insp-field">
        <span>{t('font')}</span>
        <select data-act="text-font" value={style.fontFamily} onPointerDown={loadFonts} onFocus={loadFonts}
          onChange={(e) => step({ fontFamily: e.target.value })}>
          {!listed.includes(style.fontFamily) && <option value={style.fontFamily}>{style.fontFamily}</option>}
          {!!fonts?.project.length && (
            <optgroup label={t('fontsProject')}>
              {fonts.project.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
          )}
          {fonts && (
            <optgroup label={t('fontsSystem')}>
              {fonts.system.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <Num label={t('fontSize')} value={style.fontSize} min={8} max={500}
        onChange={(v) => set({ fontSize: v })} />
      <label className="insp-field">
        <span>{t('bold')}</span>
        <input type="checkbox" checked={style.bold} onChange={(e) => step({ bold: e.target.checked })} />
      </label>
      <label className="insp-field">
        <span>{t('italic')}</span>
        <input type="checkbox" data-act="text-italic" checked={style.italic} onChange={(e) => step({ italic: e.target.checked })} />
      </label>
      <label className="insp-field">
        <span>{t('align')}</span>
        <select data-act="text-align" value={style.align} onChange={(e) => step({ align: e.target.value as TextStyle['align'] })}>
          <option value="left">{t('alignLeft')}</option>
          <option value="center">{t('alignCenter')}</option>
          <option value="right">{t('alignRight')}</option>
        </select>
      </label>
      <label className="insp-field">
        <span>{t('color')}</span>
        {color('color', t('color'))}
      </label>
      <label className="insp-field">
        <span>{t('outline')}</span>
        {color('outlineColor', t('outline'))}
      </label>
      <Num label={`${t('outline')} px`} value={style.outlineWidth} min={0} max={40}
        onChange={(v) => set({ outlineWidth: v })} />
      <label className="insp-field">
        <span>{t('background')}</span>
        <span className="insp-inline">
          <input type="checkbox" data-act="text-bg" checked={!!style.background} aria-label={t('background')}
            onChange={(e) => step({ background: e.target.checked ? '#000000' : '' })} />
          {!!style.background && color('background', t('background'))}
        </span>
      </label>
      {!!style.background && (
        <Num label={t('bgPad')} value={style.backgroundPad} step={0.05} min={0} max={4}
          onChange={(v) => set({ backgroundPad: v })} />
      )}
      <label className="insp-field">
        <span>{t('shadow')}</span>
        <span className="insp-inline">
          <input type="checkbox" data-act="text-shadow" checked={!!style.shadowColor} aria-label={t('shadow')}
            onChange={(e) => step(e.target.checked
              ? { shadowColor: '#000000', ...(style.shadowBlur || style.shadowX || style.shadowY ? {} : { shadowBlur: 8, shadowX: 4, shadowY: 4 }) }
              : { shadowColor: '' })} />
          {!!style.shadowColor && color('shadowColor', t('shadow'))}
        </span>
      </label>
      {!!style.shadowColor && (
        <>
          <Num label={t('shadowBlur')} value={style.shadowBlur} min={0} max={200} onChange={(v) => set({ shadowBlur: v })} />
          <Num label={t('shadowX')} value={style.shadowX} min={-500} max={500} onChange={(v) => set({ shadowX: v })} />
          <Num label={t('shadowY')} value={style.shadowY} min={-500} max={500} onChange={(v) => set({ shadowY: v })} />
        </>
      )}
      <Num label={t('lineHeight')} value={style.lineHeight} step={0.05} min={0.5} max={4}
        onChange={(v) => set({ lineHeight: v })} />
      <Num label={t('letterSpacing')} value={style.letterSpacing} step={0.5} min={-50} max={200}
        onChange={(v) => set({ letterSpacing: v })} />
      <Num label={t('wrapWidth')} value={style.wrapWidth} step={10} min={0} max={10000}
        onChange={(v) => set({ wrapWidth: Math.max(0, v) })} />
    </>
  )
}

function ClipProps({ clip }: { clip: Clip }) {
  const t = useT()
  const update = (patch: Partial<Clip>) => useEditor.getState().updateClip(clip.id, patch)
  const named = useRef(false)
  const visual = useEditor((s) => clip.kind !== 'media' || s.project.assets.some((a) => a.id === clip.assetId && a.kind !== 'audio'))
  const project = useEditor((s) => s.project)
  const twin = useMemo(() => audioTwin(project, clip), [project, clip])
  const setAnim = (key: keyof Clip['transform'], v: number) =>
    update({ transform: { ...clip.transform, [key]: { ...clip.transform[key], value: v } } })
  const setStyle = (patch: Partial<TextStyle>) =>
    update({ textStyle: { ...clip.textStyle!, ...patch } })

  return (
    <>
      <div className="insp-section">{t('clipName')}</div>
      <label className="insp-field">
        <span>{t('label')}</span>
        {/* F2 lands here; one undo step per focus, taken on the first keystroke */}
        <input
          data-act="clip-name"
          value={clip.label ?? ''}
          onFocus={() => { named.current = false }}
          onChange={(e) => {
            if (!named.current) { useEditor.getState().pushHistory('hEdit'); named.current = true }
            update({ label: e.target.value })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }}
        />
      </label>
      {clip.kind === 'text' && clip.textStyle && (
        <>
          <label className="insp-field tall">
            <span>{t('text')}</span>
            <textarea
              rows={3}
              value={clip.text ?? ''}
              onFocus={() => useEditor.getState().pushHistory('hEdit')}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <TextStyleRows style={clip.textStyle} set={setStyle} />
        </>
      )}
      {visual && (
        <>
          {/* K6 (canvas K, RULES 24): a sound has no position */}
          <div className="insp-section">{t('position')}</div>
          <Num label="X" value={clip.transform.x.value} onChange={(v) => setAnim('x', v)} />
          <Num label="Y" value={clip.transform.y.value} onChange={(v) => setAnim('y', v)} />
          <Num label={t('scale')} value={clip.transform.scale.value} step={0.05} min={0.01} max={20}
            onChange={(v) => setAnim('scale', v)} />
          <Num label={t('rotation')} value={clip.transform.rotation.value} step={1}
            onChange={(v) => setAnim('rotation', v)} />
          <Num label={t('opacity')} value={clip.transform.opacity.value} step={0.05} min={0} max={1}
            onChange={(v) => setAnim('opacity', v)} />
          {/* F4: each choice is its own undo step */}
          <label className="insp-field">
            <span>{t('fit')}</span>
            <select data-act="clip-fit" value={clip.fit ?? 'contain'} onChange={(e) => {
              useEditor.getState().pushHistory('hEdit')
              update({ fit: e.target.value === 'contain' ? undefined : e.target.value as ClipFit })
            }}>
              <option value="contain">{t('fitContain')}</option>
              <option value="cover">{t('fitCover')}</option>
              <option value="stretch">{t('fitStretch')}</option>
            </select>
          </label>
          {(['flipX', 'flipY'] as const).map((k) => (
            <label className="insp-field" key={k}>
              <span>{t(k)}</span>
              <input type="checkbox" data-act={`clip-${k}`} checked={!!clip[k]} onChange={(e) => {
                useEditor.getState().pushHistory('hEdit')
                update({ [k]: e.target.checked || undefined })
              }} />
            </label>
          ))}
        </>
      )}
      <div className="insp-section">{t('inSound')}</div>
      {twin && clip.muted ? (
        // an AV import: the picture's own sound is off because it plays from the audio clip
        <div className="insp-field">
          <span>{t('audioOnTwin').replace('{track}', twin.track.name)}</span>
          <button data-act="select-twin" title={t('audioOnTwinHint')}
            onClick={() => useEditor.getState().select([twin.clip.id])}>
            <Icon name="link" size={13} /> {twin.clip.label}
          </button>
        </div>
      ) : (
        <>
          <SoundRow clip={clip} k="gain" />
          {!!clip.gain.keyframes?.length && (
            <div className="cg-hint"><Icon name="diamond" size={12} style={{ color: 'var(--c-sel)' }} /><span>{t('inGainKeyed')}</span></div>
          )}
          <SoundRow clip={clip} k="pan" />
          <label className="insp-field">
            <span>{t('muted')}</span>
            <input type="checkbox" checked={clip.muted}
              onChange={(e) => { useEditor.getState().pushHistory('hEdit'); update({ muted: e.target.checked }) }} />
          </label>
        </>
      )}
      {clip.kind === 'remotion' && <FragmentParamsSection clip={clip} />}
      {clip.kind === 'remotion' && <AudioReactSection clip={clip} />}
      {visual && <EffectsSection clip={clip} />}
    </>
  )
}

/**
 * K6 (canvas K, RULES 22–23): a clip's volume (the mixer's fader taper on a
 * range, in dB) or pan. Keyed, the row shows the value under the playhead and
 * an edit sets a key there (never `.value`, K1 finding 2); outside the clip a
 * keyed row is disabled. A drag or a run of arrow keys is one undo step.
 */
function SoundRow({ clip, k }: { clip: Clip; k: 'gain' | 'pan' }) {
  const t = useT()
  const playhead = useEditor((s) => s.playhead)
  const run = useRef(false)
  const def = k === 'gain' ? 1 : 0
  const a: Anim = clip[k] ?? { value: def }
  const rel = playhead - clip.start
  const inside = rel >= 0 && rel <= clip.duration
  const keyed = !!a.keyframes?.length
  const v = keyed ? evalAnim(a, Math.min(clip.duration, Math.max(0, rel))) : a.value
  const atKey = keyed && inside && a.keyframes!.some((kf) => Math.abs(kf.time - rel) < KF_EPS)
  const off = keyed && !inside
  const label = k === 'gain' ? t('volume') : t('inPan')
  const write = (x: number) => setClipAnimAt(clip.id, k, x, useEditor.getState().playhead)
  return (
    <div className="cg-row" data-row={k} title={off ? t('inKeyedOutside') : t(k === 'gain' ? 'inGainTitle' : 'inPanTitle')}>
      <span className={keyed || v !== def ? 'cg-set' : ''}
            onDoubleClick={() => { if (!off) { beginMixGesture(); write(def) } }}>{label}</span>
      <input
        type="range" aria-label={label} disabled={off}
        min={k === 'gain' ? 0 : -1} max={1} step={k === 'gain' ? 0.001 : 0.01}
        value={k === 'gain' ? faderPos(gainToDb(v)) : v}
        onPointerDown={() => { run.current = true; beginMixGesture() }}
        onKeyDown={() => { if (!run.current) { run.current = true; beginMixGesture() } }}
        onBlur={() => { run.current = false }}
        onPointerUp={() => { run.current = false }}
        onChange={(e) => {
          const x = Number(e.target.value)
          write(k === 'gain' ? dbToGain(posDb(x)) : x)
        }}
      />
      <span className="fx-val" style={{ width: 'auto', whiteSpace: 'nowrap' }}>{k === 'gain' ? `${dbText(gainToDb(v))} dB` : panText(v)}</span>
      <button
        className={`cg-kf${atKey ? ' on' : keyed ? ' cg-animated' : ''}`} data-act={`kf-${k}`}
        disabled={!inside} aria-pressed={atKey}
        title={atKey ? t('inKfDel') : keyed ? t('inKfAnim') : t('inKfAdd')}
        aria-label={atKey ? t('inKfDel') : t('inKfAdd')}
        onClick={() => toggleKeyAt(clip.id, k, useEditor.getState().playhead)}
      >
        <Icon name="diamond" size={12} />
      </button>
    </div>
  )
}

/**
 * «Реакция на звук»: bake the sound under a fragment into its folder
 * (audio.json + audio.ts, see src/engine/audioReact.ts) so the composition can
 * move with the music. Shows whether the bake still matches what is under the
 * clip — a moved clip or an edited track makes it stale.
 */
function AudioReactSection({ clip }: { clip: Clip }) {
  const t = useT()
  const project = useEditor((s) => s.project)
  const [source, setSource] = useState(clip.audioBake?.source ?? 'mix')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setSource(clip.audioBake?.source ?? 'mix')
    setNote('')
    setError('')
  }, [clip.id])
  const plan = useMemo(() => bakePlan(project, clip, 'mix'), [project, clip])
  const tracks = useMemo(
    // the tracks heard under the composition itself, not in the analysis context around it
    () => (plan ? audibleTracksInRange(project, Math.max(0, plan.t0), plan.t0 + plan.frames * plan.step) : []),
    [project, plan]
  )
  const state = bakeState(project, clip)
  const src = source === 'mix' || tracks.some((tr) => tr.id === source) ? source : 'mix'

  const bake = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await bakeAudio(clip.id, { source: src })
      setNote(r.audible
        ? t('arDone').replace('{bpm}', r.bpm.toFixed(1)).replace('{n}', String(r.beats))
        : t('arSilent'))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section"><Icon name="reactive" size={13} /> {t('arTitle')}</div>
      <div className={`ar-state ${state}`} data-ar-state={state}>
        {state === 'none' ? t('arNone') : state === 'fresh' ? t('arFresh') : t('arStale')}
      </div>
      <label className="insp-field">
        <span>{t('arSource')}</span>
        <select value={src} disabled={busy} onChange={(e) => setSource(e.target.value)} data-act="ar-source">
          <option value="mix">{t('arMix')}</option>
          {tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </select>
      </label>
      <button data-act="ar-bake" disabled={busy} onClick={bake}>
        {busy ? <Spinner /> : <Icon name="reactive" />}{' '}
        {busy ? t('arWorking') : state === 'none' ? t('arBake') : t('arRebake')}
      </button>
      {note && <div className="dim">{note}</div>}
      {error && <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>}
      <div className="dim ar-hint">{t('arHint')}</div>
    </>
  )
}

/**
 * The fragment's own parameters (defineParams in @kadr/runtime): sliders that
 * move the preview live and are saved into the fragment's params.json.
 */
function FragmentParamsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const fid = clip.fragmentId!
  const [ins, setIns] = useState<FragmentInspect | null>(null)
  const [loading, setLoading] = useState(false)
  const [gen, setGen] = useState(0)
  useFragmentParams((s) => s.live[fid]) // re-render while a value is dragged
  useEffect(() => {
    let alive = true
    setLoading(true)
    window.kadr.fragmentInspect(fid)
      .then((r) => {
        if (!alive) return
        if (r.ok) rememberParamValues(fid, r.paramValues)
        setIns(r)
      })
      .catch((e) => { if (alive) setIns({ ok: false, error: String((e as Error)?.message ?? e) }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fid, gen])
  const decl: Record<string, FragmentParamDecl> = ins?.ok ? ins.params ?? {} : {}
  const names = Object.keys(decl)
  const values = paramValues(fid, decl, ins?.ok ? ins.paramValues : undefined)
  const set = (k: string, v: number | boolean | string) => setParam(fid, k, v)
  return (
    <>
      <div className="insp-section">
        <Icon name="sliders" size={13} /> {t('fpTitle')}
        <button className="fx-del fp-reload" data-act="fp-reload" aria-label={t('fpReload')} title={t('fpReload')}
          disabled={loading} onClick={() => setGen((g) => g + 1)}>
          {loading ? <Spinner /> : <Icon name="reload" size={13} />}
        </button>
      </div>
      {ins && !ins.ok && <div className="tr-error"><Icon name="alert" size={15} /><span>{ins.error.split('\n')[0]}</span></div>}
      {ins?.ok && !names.length && <div className="dim ar-hint">{t('fpNone')}</div>}
      {names.map((k) => {
        const d = decl[k]
        const v = values[k]
        const label = d.label || k
        if (typeof d.value === 'boolean') {
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type="checkbox" checked={v === true} onChange={(e) => set(k, e.target.checked)} />
            </label>
          )
        }
        if (typeof d.value === 'string') {
          const color = /^#[0-9a-f]{6}$/i.test(String(d.value))
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type={color ? 'color' : 'text'} value={String(v)} onChange={(e) => set(k, e.target.value)} />
            </label>
          )
        }
        const n = Number(v)
        const step = d.step ?? (d.min != null && d.max != null ? (d.max - d.min) / 200 : 0.01)
        const ranged = d.min != null && d.max != null && d.max > d.min
        const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)))
        return (
          <label key={k} className="insp-field fx-slider fp-num" data-param={k}>
            <span>{label}</span>
            {ranged && (
              <input type="range" value={n} min={d.min} max={d.max} step={step}
                onChange={(e) => set(k, Number(e.target.value))} />
            )}
            <input type="number" value={Number(n.toFixed(digits))} step={step} min={d.min} max={d.max}
              onChange={(e) => { const x = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(x)) set(k, x) }} />
          </label>
        )
      })}
      {names.length > 0 && (
        <button data-act="fp-reset" onClick={() => void resetParams(fid)}>{t('fpReset')}</button>
      )}
    </>
  )
}

function Slider({
  label, value, min, max, step, onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="insp-field fx-slider">
      <span>{label}</span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onPointerDown={() => useEditor.getState().pushHistory('hEffect')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fx-val">{Number(value.toFixed(2))}</span>
    </label>
  )
}

function EffectsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [name, setName] = useState('')
  const fxPresets = useFxPresets((s) => s.presets)
  const update = (effects: Effect[]) => useEditor.getState().updateClip(clip.id, { effects })
  const effects = clip.effects ?? []
  const addGlow = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'glow', enabled: true, params: { ...GLOW_DEFAULTS } }])
  }
  const addBlur = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'blur', enabled: true, params: { size: 20 } }])
  }
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])
  // selection moved to another clip — the open menu refers to stale effects
  useEffect(() => setMenu(null), [clip.id])
  const saveFx = () => {
    const nm = name.trim()
    if (!nm || !effects.length) return
    useFxPresets.getState().savePreset({
      name: nm,
      effects: effects.map((e) => ({ ...e, params: { ...e.params } }))
    })
    setName('')
  }
  const applyFx = (p: FxPreset) => {
    useEditor.getState().pushHistory('hPreset')
    update(p.effects.map((e) => ({ ...e, id: uid(), params: { ...e.params } })))
    setMenu(null)
  }
  return (
    <>
      <div className="insp-section fx-section-head">
        <span>{t('effects')}</span>
        <button
          className={`fx-preset-btn${menu ? ' active' : ''}`}
          data-act="fx-presets"
          title={t('fxPresetsHint')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
          }}
        >
          <Icon name="star" size={12} /> {t('presets')}
        </button>
      </div>
      {effects.map((fx) =>
        fx.type === 'glow' ? (
          <GlowControls key={fx.id} clip={clip} fx={fx} />
        ) : fx.type === 'blur' ? (
          <BlurControls key={fx.id} clip={clip} fx={fx} />
        ) : null
      )}
      {!effects.some((e) => e.type === 'glow') && (
        <button className="fx-add" data-act="add-glow" onClick={addGlow}>
          <Icon name="plus" size={13} /> <Icon name="glow" size={14} /> {t('fxGlow')}
        </button>
      )}
      {!effects.some((e) => e.type === 'blur') && (
        <button className="fx-add" data-act="add-blur" onClick={addBlur}>
          <Icon name="plus" size={13} /> <Icon name="blur" size={14} /> {t('fxBlur')}
        </button>
      )}
      {menu && (
        <CtxMenu x={menu.x} y={menu.y} className="preset-menu fx-preset-menu">
          <div className="ctx-title dim">{t('presets')} — {t('effects')}</div>
          {fxPresets.length === 0 && <div className="ctx-empty dim">{t('noPresets')}</div>}
          {fxPresets.map((p) => (
            <div className="preset-item" key={p.id}>
              <button onClick={() => applyFx(p)}>{p.name}</button>
              <button
                className="preset-del"
                title={t('deletePreset')}
                aria-label={t('deletePreset')}
                onClick={() => useFxPresets.getState().deletePreset(p.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <div className="preset-save-row">
            <input
              value={name}
              placeholder={t('presetName')}
              aria-label={t('presetName')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveFx()
              }}
            />
            <button disabled={!name.trim() || !effects.length} onClick={saveFx}>
              {t('presetSave')}
            </button>
          </div>
        </CtxMenu>
      )}
    </>
  )
}

function BlurControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const size = typeof fx.params.size === 'number' ? fx.params.size : 20
  return (
    <div className="fx-block">
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span><Icon name="blur" size={14} /> {t('fxBlur')}</span>
        </label>
        <button
          className="fx-del"
          title={t('fxDelete')}
          onClick={() => {
            st().pushHistory('hEffect')
            st().updateClip(clip.id, {
              effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
            })
          }}
          aria-label={t('fxDelete')}
        ><Icon name="trash" size={14} /></button>
      </div>
      <Slider label={t('fxBlurSize')} value={size} min={0} max={300} step={1}
        onChange={(v) => patchFx({ params: { ...fx.params, size: v } })} />
    </div>
  )
}

function GlowControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const setP = (key: string, v: number | string) =>
    patchFx({ params: { ...fx.params, [key]: v } })
  const num = (key: keyof typeof GLOW_DEFAULTS) => {
    const v = fx.params[key]
    return typeof v === 'number' ? v : (GLOW_DEFAULTS[key] as number)
  }
  return (
    <div className="fx-block">
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span><Icon name="glow" size={14} /> {t('fxGlow')}</span>
        </label>
        <button
          className="fx-del"
          title={t('fxDelete')}
          onClick={() => {
            st().pushHistory('hEffect')
            st().updateClip(clip.id, {
              effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
            })
          }}
          aria-label={t('fxDelete')}
        ><Icon name="trash" size={14} /></button>
      </div>
      <label className="insp-field">
        <span>{t('color')}</span>
        <input
          type="color"
          value={typeof fx.params.color === 'string' ? fx.params.color : GLOW_DEFAULTS.color}
          onFocus={() => st().pushHistory('hEffect')}
          onChange={(e) => setP('color', e.target.value)}
        />
      </label>
      <Slider label={t('fxSize')} value={num('size')} min={4} max={400} step={1}
        onChange={(v) => setP('size', v)} />
      <Slider label={t('fxIntensity')} value={num('intensity')} min={0} max={3} step={0.05}
        onChange={(v) => setP('intensity', v)} />
      <Slider label={t('fxSaturation')} value={num('saturation')} min={0} max={2} step={0.05}
        onChange={(v) => setP('saturation', v)} />
      <Slider label={t('fxSmoke')} value={num('smoke')} min={0} max={1} step={0.05}
        onChange={(v) => setP('smoke', v)} />
      <Slider label={t('fxSpeed')} value={num('speed')} min={0} max={3} step={0.05}
        onChange={(v) => setP('speed', v)} />
      <Slider label={t('fxParticles')} value={num('particles')} min={0} max={1} step={0.05}
        onChange={(v) => setP('particles', v)} />
    </div>
  )
}
