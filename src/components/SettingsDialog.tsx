// «Настройки»: every setting that exists (shared/settings.ts) on one screen,
// landed from canvas D (design-source/canvas/D, RULES 1–15). Values apply on
// change — the store writes the diff to userData/settings.json; «Готово» only
// closes. Each row shows where its value comes from (default / yours / an env
// variable, which locks it) and whether it waits for a restart.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Modal } from './Modal'
import { Icon } from './icons'
import { useT, type TKey } from '@/i18n'
import { useSettings } from '@/state/store'
import { TRANSITIONS } from '@/gl/transitions'
import { PRESETS } from '@/presets'
import { playDoneChime } from '@/engine/chime'
import { useTtsUi } from './TtsDialog'
import { KeysSection, KeysHeadActions } from './KeysSection'
import {
  SETTINGS, awaitsRestart, running,
  type SettingDef, type SettingKey, type SettingSection, type SettingValue, type SettingsSnapshot
} from '@shared/settings'
import type { ClaudeStatus, ToolCheck } from '@shared/types'

export const useSettingsUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

type T = (k: TKey) => string
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
const num = (v: number, lang: string) => (lang === 'ru' ? String(v).replace('.', ',') : String(v))

const useSnap = () => useSettings((s) => s.snap)
const def = (k: SettingKey): SettingDef => SETTINGS[k]
const src = (k: SettingKey, snap: SettingsSnapshot) =>
  snap.env[k] !== undefined ? 'env' : snap.user[k] !== undefined ? 'user' : 'default'
const setKey = (k: SettingKey, v: SettingValue | null) => useSettings.getState().set(k, v)

/** a row's controls report an invalid value here (RULES 11), in the row's unit */
const RowError = createContext<{ report(msg: string): void; unit: string }>({ report: () => {}, unit: '' })

// ------------------------------------------------------------------ a row

function Badges({ keys, t }: { keys: SettingKey[]; t: T }) {
  const snap = useSnap()
  const env = keys.find((k) => src(k, snap) === 'env')
  const restart = keys.some((k) => def(k).restart)
  const pending = keys.some((k) => awaitsRestart(k, snap))
  return (
    <>
      {env
        ? <span className="set-badge set-badge-env" title={fill(t('setEnvDetail'), { name: def(env).env! })}>
            <Icon name="lock" size={11} />{def(env).env}
          </span>
        : keys.some((k) => src(k, snap) === 'user')
          ? <span className="set-badge set-badge-user">{t('setSrcUser')}</span>
          : <span className="set-badge set-badge-default">{t('setSrcDefault')}</span>}
      {restart && (
        <span className={`set-badge set-badge-restart${pending ? ' pending' : ''}`}>
          <Icon name="reload" size={11} />{t(pending ? 'setRestartPending' : 'setRestart')}
        </span>
      )}
    </>
  )
}

function ResetSlot({ keys, shown, t }: { keys: SettingKey[]; shown: string; t: T }) {
  const snap = useSnap()
  if (!keys.some((k) => src(k, snap) === 'user')) return <span className="set-slot" />
  const title = fill(t('setResetTo'), { value: shown })
  return (
    <button className="ghost icon-only set-reset" title={title} aria-label={title}
            onClick={() => keys.forEach((k) => setKey(k, null))}>
      <Icon name="reload" size={14} />
    </button>
  )
}

/**
 * One setting (or a few that read as one, like resolution). `shown` is the
 * default as the reset button names it. A tall row puts the control under
 * the label (paths, arguments) with a detail line below.
 */
function Row({ label, keys, shown, children, tall, detail, unit }: {
  label: string; keys: SettingKey[]; shown: string; children: ReactNode
  tall?: boolean; detail?: ReactNode; unit?: string
}) {
  const t = useT()
  const snap = useSnap()
  const [err, setErr] = useState('')
  const env = keys.find((k) => src(k, snap) === 'env')
  const pending = keys.find((k) => awaitsRestart(k, snap))
  const lines = [
    env && fill(t('setEnvDetail'), { name: def(env).env! }),
    pending && fill(t('setNowRunning'), { value: String(running(pending, snap)) || shown })
  ].filter(Boolean)
  const below = (
    <>
      {err && <span className="set-error" role="alert">{err}</span>}
      {(lines.length > 0 || detail) && (
        <span className="set-detail">{[...lines, ...(detail ? [detail] : [])].map((l, i) => <span key={i}>{i ? '. ' : ''}{l}</span>)}</span>
      )}
    </>
  )
  if (tall) {
    return (
      <RowError.Provider value={{ report: setErr, unit: unit ?? '' }}>
        <div className="insp-field tall">
          <span className="set-label">
            <span>{label}</span>
            <Badges keys={keys} t={t} />
            <ResetSlot keys={keys} shown={shown} t={t} />
          </span>
          <span className="set-control">{children}</span>
          {below}
        </div>
      </RowError.Provider>
    )
  }
  return (
    <RowError.Provider value={{ report: setErr, unit: unit ?? '' }}>
      <div className="insp-field">
        <span>{label}</span>
        <span className="set-field-col">
          <span className="set-control">
            <Badges keys={keys} t={t} />
            {children}
            {unit !== undefined && <span className="set-unit dim">{unit}</span>}
            <ResetSlot keys={keys} shown={shown} t={t} />
          </span>
          {below}
        </span>
      </div>
    </RowError.Provider>
  )
}

// ------------------------------------------------------------------ controls

const locked = (k: SettingKey, snap: SettingsSnapshot) => src(k, snap) === 'env'
const val = (k: SettingKey, snap: SettingsSnapshot) =>
  snap.env[k] ?? snap.user[k] ?? SETTINGS[k].default

function Check({ k, label }: { k: SettingKey; label: string }) {
  const snap = useSnap()
  return <input type="checkbox" aria-label={label} checked={val(k, snap) === true} disabled={locked(k, snap)}
                onChange={(e) => setKey(k, e.target.checked)} />
}

function Choice({ k, label, options, width }: {
  k: SettingKey; label: string; options: [SettingValue, string][]; width?: number
}) {
  const snap = useSnap()
  const v = val(k, snap)
  return (
    <select aria-label={label} value={String(v)} disabled={locked(k, snap)} style={width ? { width } : undefined}
            onChange={(e) => {
              const o = options.find(([x]) => String(x) === e.target.value)
              if (o) setKey(k, o[0])
            }}>
      {!options.some(([x]) => String(x) === String(v)) && <option value={String(v)}>{String(v)}</option>}
      {options.map(([x, l]) => <option key={String(x)} value={String(x)}>{l}</option>)}
    </select>
  )
}

/** a number; an out-of-range value stays typed, marked, and is not written (RULES 11) */
function Num({ k, label, step }: { k: SettingKey; label: string; step?: number }) {
  const t = useT()
  const lang = useSettings((s) => s.lang)
  const snap = useSnap()
  const { report, unit } = useContext(RowError)
  const u = (n: number) => `${num(n, lang)}${unit && unit !== '%' ? ` ${unit}` : unit}`
  const v = val(k, snap) as number
  const [text, setText] = useState(String(v))
  const [bad, setBad] = useState(false)
  useEffect(() => { if (!bad) setText(String(v)) }, [v, bad])
  const d = def(k)
  return (
    <input type="number" aria-label={label} value={text} step={step ?? 'any'} min={d.min} max={d.max}
           disabled={locked(k, snap)} aria-invalid={bad || undefined}
           onChange={(e) => {
             setText(e.target.value)
             const n = Number(e.target.value.replace(',', '.'))
             const low = d.min !== undefined && n < d.min
             const high = d.max !== undefined && n > d.max
             if (e.target.value.trim() === '' || !Number.isFinite(n) || low || high) {
               setBad(true)
               report(fill(t(high ? 'setMaxError' : 'setMinError'),
                 { min: u(d.min ?? 0), max: u(d.max ?? 0), value: u(v) }))
               return
             }
             setBad(false)
             report('')
             setKey(k, n)
           }}
           onBlur={() => { if (bad) { setBad(false); setText(String(v)); report('') } }} />
  )
}

/** text; empty = the default, shown as the placeholder (the schema keeps no empty strings) */
function Text({ k, label, placeholder, mono }: { k: SettingKey; label: string; placeholder?: string; mono?: boolean }) {
  const snap = useSnap()
  return (
    <input type="text" aria-label={label} value={String(snap.env[k] ?? snap.user[k] ?? '')}
           placeholder={placeholder ?? String(SETTINGS[k].default)} disabled={locked(k, snap)} className={mono ? 'set-mono' : undefined}
           onChange={(e) => setKey(k, e.target.value.trim() === '' ? null : e.target.value)} />
  )
}

function ChooseDir({ k, t }: { k: SettingKey; t: T }) {
  const snap = useSnap()
  return (
    <button disabled={locked(k, snap)} onClick={async () => {
      const dir = await window.kadr.pickDirectory()
      if (dir) setKey(k, dir)
    }}>{t('setChoose')}</button>
  )
}

/** «Проверить»: the tool's version line, or why it does not run */
function useToolCheck(k: SettingKey) {
  const t = useT()
  const [res, setRes] = useState<ToolCheck | 'busy' | null>(null)
  const run = async () => {
    setRes('busy')
    const snap = useSettings.getState().snap
    const v = src(k, snap) === 'default' ? '' : String(val(k, snap))
    setRes(await window.kadr.probeTool(k, v).catch((e) => ({ ok: false, cmd: '', line: String(e?.message ?? e) })))
  }
  const button = <button onClick={() => void run()} disabled={res === 'busy'}>{t('setCheck')}</button>
  const line = res === 'busy'
    ? <>{t('setChecking')}</>
    : res
      ? <span title={res.full}>{fill(t(res.ok ? 'setFound' : 'setNotFound'), { version: res.line, why: res.line })}</span>
      : null
  return { button, line }
}

function ToolRow({ k, label, hint, placeholder }: { k: SettingKey; label: string; hint?: string; placeholder?: string }) {
  const check = useToolCheck(k)
  return (
    <Row label={label} keys={[k]} shown={placeholder ?? String(SETTINGS[k].default)} tall
         detail={check.line ?? hint}>
      <Text k={k} label={label} placeholder={placeholder} mono />
      {check.button}
    </Row>
  )
}

// ------------------------------------------------------------------ sections

type SectionId = SettingSection | 'keys' | 'voice' | 'privacy'
const SECTIONS: [SectionId, TKey][] = [
  ['general', 'setSecGeneral'], ['newProject', 'setSecNewProject'], ['editing', 'setSecEditing'],
  ['keys', 'setSecKeys'], ['mouse', 'setSecMouse'], ['playback', 'setSecPlayback'], ['save', 'setSecSave'],
  ['export', 'setSecExport'], ['storage', 'setSecStorage'], ['tools', 'setSecTools'],
  ['speech', 'setSecSpeech'], ['claude', 'setSecAI'], ['voice', 'setSecVoice'], ['privacy', 'setSecPrivacy']
]

const RESOLUTIONS: [number, number][] = [[1920, 1080], [3840, 2160], [1080, 1920]]
const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]

function General({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setLang')} keys={['general.lang']} shown="Русский">
        <Choice k="general.lang" label={t('setLang')} options={[['ru', 'Русский'], ['en', 'English']]} width={158} />
      </Row>
      <Row label={t('setScale')} keys={['general.uiScale']} shown="100 %">
        <Choice k="general.uiScale" label={t('setScale')} options={[90, 100, 110, 125, 150].map((n) => [n, `${n} %`])} width={158} />
      </Row>
      <div className="insp-section">{t('setChimeHead')}</div>
      <Row label={t('setChime')} keys={['general.chime']} shown={t('setOn')}>
        <Check k="general.chime" label={t('setChime')} />
      </Row>
      <Row label={t('setChimeVol')} keys={['general.chimeVolume']} shown="100 %" unit="%">
        <Num k="general.chimeVolume" label={t('setChimeVol')} step={5} />
        <button className="ghost" onClick={() => playDoneChime()}>{t('setChimePlay')}</button>
      </Row>
    </>
  )
}

function NewProject({ t }: { t: T }) {
  const snap = useSnap()
  const w = val('newProject.width', snap) as number
  const h = val('newProject.height', snap) as number
  const preset = RESOLUTIONS.findIndex(([a, b]) => a === w && b === h)
  const [custom, setCustom] = useState(preset < 0)
  return (
    <>
      <p className="dim">{t('setNewNote')}</p>
      <Row label={t('setRes')} keys={['newProject.width', 'newProject.height']} shown="1920 × 1080">
        <select aria-label={t('setRes')} value={custom || preset < 0 ? 'custom' : String(preset)}
                onChange={(e) => {
                  if (e.target.value === 'custom') { setCustom(true); return }
                  const [a, b] = RESOLUTIONS[Number(e.target.value)]
                  setCustom(false)
                  setKey('newProject.width', a)
                  setKey('newProject.height', b)
                }}>
          {RESOLUTIONS.map(([a, b], i) => <option key={i} value={i}>{a} × {b}</option>)}
          <option value="custom">{t('setResCustom')}</option>
        </select>
        {(custom || preset < 0) && (
          <>
            <Num k="newProject.width" label={t('setRes')} step={2} />
            <span className="dim">×</span>
            <Num k="newProject.height" label={t('setRes')} step={2} />
          </>
        )}
      </Row>
      <Row label={t('setFps')} keys={['newProject.fps']} shown="30">
        <Choice k="newProject.fps" label={t('setFps')} options={FPS.map((f) => [f, String(f).replace('.', ',')])} width={92} />
      </Row>
      <Row label={t('setBg')} keys={['newProject.background']} shown="#000000">
        <input type="color" aria-label={t('setBg')} value={String(val('newProject.background', snap))}
               onChange={(e) => setKey('newProject.background', e.target.value)} />
      </Row>
      <Row label={t('setTracks')} keys={['newProject.videoTracks', 'newProject.audioTracks']} shown="2 + 1">
        <Num k="newProject.videoTracks" label={`${t('setTracks')}: ${t('setTracksV')}`} step={1} />
        <span className="dim">{t('setTracksV')}</span>
        <Num k="newProject.audioTracks" label={`${t('setTracks')}: ${t('setTracksA')}`} step={1} />
        <span className="dim">{t('setTracksA')}</span>
      </Row>
    </>
  )
}

function Editing({ t }: { t: T }) {
  const lang = useSettings((s) => s.lang)
  const sec = t('setSec')
  return (
    <>
      <div className="insp-section">{t('setDurHead')}</div>
      <Row label={t('setStill')} keys={['editing.stillDuration']} shown={`5 ${sec}`} unit={sec}>
        <Num k="editing.stillDuration" label={t('setStill')} step={0.5} />
      </Row>
      <Row label={t('setTextDur')} keys={['editing.textDuration']} shown={`4 ${sec}`} unit={sec}>
        <Num k="editing.textDuration" label={t('setTextDur')} step={0.5} />
      </Row>
      <div className="insp-section">{t('setTransHead')}</div>
      <Row label={t('setTrans')} keys={['editing.transition']} shown={t('trCrossfade')}>
        <Choice k="editing.transition" label={t('setTrans')} width={158}
                options={TRANSITIONS.map((tr) => [tr.id, t(tr.nameKey)])} />
      </Row>
      <Row label={t('setEdgeDur')} keys={['editing.edgeDuration']} shown={`${num(0.5, lang)} ${sec}`} unit={sec}>
        <Num k="editing.edgeDuration" label={t('setEdgeDur')} step={0.1} />
      </Row>
      <Row label={t('setFade')} keys={['editing.fade']} shown={`0 ${sec}`} unit={sec}>
        <Num k="editing.fade" label={t('setFade')} step={0.1} />
      </Row>
      <div className="insp-section">{t('setTlHead')}</div>
      <Row label={t('setTrackH')} keys={['editing.trackHeight']} shown="56 px" unit="px">
        <Num k="editing.trackHeight" label={t('setTrackH')} step={1} />
      </Row>
      <Row label={t('setSnapR')} keys={['editing.snapRadius']} shown="10 px" unit="px">
        <Num k="editing.snapRadius" label={t('setSnapR')} step={1} />
      </Row>
      <Row label={t('setSnapBeats')} keys={['editing.snapBeats']} shown={t('setOn')}>
        <Check k="editing.snapBeats" label={t('setSnapBeats')} />
      </Row>
      <Row label={t('setSplit')} keys={['editing.splitScope']} shown={t('setSplitSel')}>
        <Choice k="editing.splitScope" label={t('setSplit')} width={240}
                options={[['selection', t('setSplitSel')], ['all', t('setSplitAll')]]} />
      </Row>
      <Row label={t('setConfirmDel')} keys={['editing.confirmDelete']} shown={t('setOn')}>
        <Check k="editing.confirmDelete" label={t('setConfirmDel')} />
      </Row>
    </>
  )
}

function Mouse({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setWheel')} keys={['mouse.wheel']} shown={t('setWheelZoom')}>
        <Choice k="mouse.wheel" label={t('setWheel')} width={240}
                options={[['zoom', t('setWheelZoom')], ['scroll', t('setWheelScroll')]]} />
      </Row>
      <Row label={t('setZoomSpeed')} keys={['mouse.zoomSpeed']} shown="1×" unit="×">
        <Num k="mouse.zoomSpeed" label={t('setZoomSpeed')} step={0.25} />
      </Row>
      <Row label={t('setSpeedMod')} keys={['mouse.speedModifier']} shown={t('setModCtrlAlt')}>
        <Choice k="mouse.speedModifier" label={t('setSpeedMod')} width={158}
                options={[['ctrlOrAlt', t('setModCtrlAlt')], ['ctrl', 'Ctrl'], ['alt', 'Alt']]} />
      </Row>
      <Row label={t('setEdgeZone')} keys={['mouse.edgeZone']} shown="8 px" unit="px">
        <Num k="mouse.edgeZone" label={t('setEdgeZone')} step={1} />
      </Row>
    </>
  )
}

function Playback({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setProxies')} keys={['playback.proxies']} shown={t('setOn')}>
        <Check k="playback.proxies" label={t('setProxies')} />
      </Row>
      <Row label={t('setProxyMin')} keys={['playback.proxyMinSide']} shown="720 px" unit="px">
        <Num k="playback.proxyMinSide" label={t('setProxyMin')} step={60} />
      </Row>
      <Row label={t('setLimiter')} keys={['playback.previewLimiter']} shown={t('setOn')}>
        <Check k="playback.previewLimiter" label={t('setLimiter')} />
      </Row>
    </>
  )
}

function Save({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setAutosave')} keys={['save.interval']} shown={`5 ${t('setMin')}`} unit={t('setMin')}>
        <Num k="save.interval" label={t('setAutosave')} step={1} />
      </Row>
      <Row label={t('setOps')} keys={['save.ops']} shown="25">
        <Num k="save.ops" label={t('setOps')} step={1} />
      </Row>
      <Row label={t('setKeep')} keys={['save.keep']} shown="10">
        <Num k="save.keep" label={t('setKeep')} step={1} />
      </Row>
      <Row label={t('setCap')} keys={['save.capMB']} shown="500 MB" unit={t('setMB')}>
        <Num k="save.capMB" label={t('setCap')} step={50} />
      </Row>
    </>
  )
}

function Export({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setPreset')} keys={['export.preset']} shown={PRESETS[0].name}>
        <Choice k="export.preset" label={t('setPreset')} width={240}
                options={PRESETS.map((p) => [p.id, p.name])} />
      </Row>
      <Row label={t('setMblur')} keys={['export.motionBlur']} shown={t('setOn')}>
        <Check k="export.motionBlur" label={t('setMblur')} />
      </Row>
      <Row label={t('setFblend')} keys={['export.frameBlending']} shown={t('setOn')}>
        <Check k="export.frameBlending" label={t('setFblend')} />
      </Row>
    </>
  )
}

function Storage({ t, onOpenStorage }: { t: T; onOpenStorage(): void }) {
  return (
    <>
      <Row label={t('setCacheRoot')} keys={['storage.cacheRoot']} shown={t('setUserData')} tall>
        <Text k="storage.cacheRoot" label={t('setCacheRoot')} placeholder={t('setUserData')} mono />
        <ChooseDir k="storage.cacheRoot" t={t} />
      </Row>
      <Row label={t('setDecodedCap')} keys={['storage.decodedCapGB']} shown="10 GB" unit={t('setGB')}>
        <Num k="storage.decodedCapGB" label={t('setDecodedCap')} step={1} />
      </Row>
      <Row label={t('setTempDir')} keys={['storage.tempDir']} shown={t('setSysTemp')} tall>
        <Text k="storage.tempDir" label={t('setTempDir')} placeholder={t('setSysTemp')} mono />
        <ChooseDir k="storage.tempDir" t={t} />
      </Row>
      <div className="insp-field">
        <span>{t('setDisk')}</span>
        <button onClick={onOpenStorage}><Icon name="layers" /> {t('setOpenStorage')}</button>
      </div>
    </>
  )
}

function Tools({ t }: { t: T }) {
  return (
    <>
      <div className="insp-section">{t('setToolsEnc')}</div>
      <ToolRow k="tools.ffmpeg" label="ffmpeg" />
      <ToolRow k="tools.ffprobe" label="ffprobe" />
      <div className="insp-section">Python</div>
      <ToolRow k="tools.speechPython" label={t('setSpeechPy')} placeholder={t('setAuto')} hint={t('setSpeechPyHint')} />
      <ToolRow k="tools.detectorPython" label={t('setDetPy')} placeholder={t('setAuto')} hint={t('setDetPyHint')} />
      <div className="insp-section">{t('setToolsFrag')}</div>
      <Row label={t('setFragDir')} keys={['tools.fragmentsDir']} shown="~/kadr-fragments" tall>
        <Text k="tools.fragmentsDir" label={t('setFragDir')} placeholder="~/kadr-fragments" mono />
        <ChooseDir k="tools.fragmentsDir" t={t} />
      </Row>
      <Row label={t('setFragPort')} keys={['tools.fragmentsPort']} shown="5621">
        <Num k="tools.fragmentsPort" label={t('setFragPort')} step={1} />
      </Row>
    </>
  )
}

function Speech({ t }: { t: T }) {
  return (
    <>
      <Row label={t('setModel')} keys={['speech.model']} shown="large-v3">
        <Choice k="speech.model" label={t('setModel')} width={240} options={[
          ['large-v3', `large-v3 — ${t('trBest')}`], ['medium', `medium — ${t('trFaster')}`], ['base', `base — ${t('trDraft')}`]]} />
      </Row>
      <Row label={t('setLanguage')} keys={['speech.language']} shown={t('trAuto')}>
        <Choice k="speech.language" label={t('setLanguage')} width={158}
                options={[['auto', t('trAuto')], ['ru', 'Русский'], ['en', 'English']]} />
      </Row>
      <Row label={t('setWords')} keys={['speech.wordsPerCue']} shown={`3 ${t('trSplitWords')}`}>
        <Choice k="speech.wordsPerCue" label={t('setWords')} width={158} options={[
          [1, t('trSplit1')], [2, `2 ${t('trSplitWords')}`], [3, `3 ${t('trSplitWords')}`],
          [4, `4 ${t('trSplitWords')}`], [0, t('trSplitPhrases')]]} />
      </Row>
    </>
  )
}

function Claude({ t }: { t: T }) {
  const [st, setSt] = useState<ClaudeStatus | null>(null)
  const probe = () => {
    setSt(null)
    void window.kadr.claudeStatus()
      .then(setSt)
      .catch((e) => setSt({ loggedIn: null, error: String(e?.message ?? e), legacyArgs: null }))
  }
  useEffect(probe, [])
  const auth = !st
    ? t('setAuthPending')
    : st.loggedIn === true
      ? `${t('setAuthYes')}${st.authMethod ? ` (${st.authMethod})` : ''}`
      : st.loggedIn === false ? t('setAuthNo') : fill(t('setAuthUnknown'), { why: st.error ?? '' })
  return (
    <>
      <div className="set-status">
        <Icon name={st?.loggedIn ? 'check' : 'bot'} size={14} />
        <span>{auth}</span>
        <button className="ghost" onClick={probe} disabled={!st}>{t('setAuthAgain')}</button>
      </div>
      {st?.legacyArgs && (
        <div className="set-warn" role="note">
          <Icon name="alert" size={14} />
          <span>{t('setLegacy')}</span>
          <button onClick={() => window.kadr.revealClaudeEnv()}>{t('setShowFile')}</button>
        </div>
      )}
      <div className="insp-section">{t('setLaunchHead')}</div>
      <Row label={t('setCmd')} keys={['claude.command']} shown="claude">
        <Text k="claude.command" label={t('setCmd')} placeholder="claude" mono />
      </Row>
      <Row label={t('setExtra')} keys={['claude.extraArgs']} shown={t('setEmpty')} tall detail={t('setExtraHint')}>
        <Text k="claude.extraArgs" label={t('setExtra')} mono />
      </Row>
      <Row label={t('setModel')} keys={['claude.model']} shown={t('setModelPh')}>
        <Text k="claude.model" label={t('setModel')} placeholder={t('setModelPh')} mono />
      </Row>
      <Row label={t('setPerm')} keys={['claude.permissionMode']} shown={t('setPermDefault')}>
        <Choice k="claude.permissionMode" label={t('setPerm')} width={240} options={[
          ['default', t('setPermDefault')], ['acceptEdits', t('setPermAccept')],
          ['auto', t('setPermAuto')], ['plan', t('setPermPlan')]]} />
      </Row>
      <div className="insp-section">{t('setConnHead')}</div>
      <Row label={t('setStrict')} keys={['claude.strictMcp']} shown={t('setOn')} detail={t('setStrictHint')}>
        <Check k="claude.strictMcp" label={t('setStrict')} />
      </Row>
      <Row label={t('setEmbed')} keys={['claude.embedChats']} shown={t('setOn')} detail={t('setEmbedHint')}>
        <Check k="claude.embedChats" label={t('setEmbed')} />
      </Row>
      <p className="dim">{t('setNextOpen')}</p>
    </>
  )
}

function Voice({ t, onClose }: { t: T; onClose(): void }) {
  const hasKey = useTtsUi((s) => s.hasKey)
  return (
    <>
      <div className="insp-field">
        <span>{t('setTtsKey')}</span>
        <span className="set-badge set-badge-default">{t(hasKey ? 'ttsKeySet' : 'ttsKeyNone')}</span>
      </div>
      <div className="insp-field">
        <span>{t('setTtsMore')}</span>
        <button onClick={() => { onClose(); useTtsUi.getState().openSettings() }}>{t('setOpenTts')}</button>
      </div>
    </>
  )
}

function Privacy({ t }: { t: T }) {
  return (
    <ul className="set-privacy">
      <li>{t('setPrivacy1')}</li>
      <li>{t('setPrivacy2')}</li>
      <li>{t('setPrivacy3')}</li>
      <li>{t('setPrivacy4')}</li>
    </ul>
  )
}

// ------------------------------------------------------------------ the dialog

export function SettingsDialog({ onOpenStorage, onRelaunch }: { onOpenStorage(): void; onRelaunch(): void }) {
  const t = useT()
  const open = useSettingsUi((s) => s.open)
  const snap = useSnap()
  const [sec, setSec] = useState<SectionId>('general')
  if (!open) return null
  const close = () => useSettingsUi.getState().setOpen(false)
  const keysOf = (s: SectionId) => (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].section === s)
  const resettable = keysOf(sec).some((k) => src(k, snap) === 'user')
  const pending = (Object.keys(SETTINGS) as SettingKey[]).some((k) => awaitsRestart(k, snap))
  const body: Record<SectionId, ReactNode> = {
    general: <General t={t} />, newProject: <NewProject t={t} />, editing: <Editing t={t} />,
    keys: <KeysSection t={t} />, mouse: <Mouse t={t} />, playback: <Playback t={t} />, save: <Save t={t} />, export: <Export t={t} />,
    storage: <Storage t={t} onOpenStorage={() => { close(); onOpenStorage() }} />, tools: <Tools t={t} />,
    speech: <Speech t={t} />, claude: <Claude t={t} />, voice: <Voice t={t} onClose={close} />, privacy: <Privacy t={t} />
  }
  return (
    <Modal
      title={t('setTitle')}
      onClose={close}
      className="settings-modal"
      bare
      actions={
        <>
          {pending && (
            <span className="set-restart-note"><Icon name="reload" size={13} />{t('setRestartNote')}</span>
          )}
          {pending && (
            <button data-act="relaunch" onClick={() => { close(); onRelaunch() }}>{t('setRestartBtn')}</button>
          )}
          <button className="primary" onClick={close}>{t('setDone')}</button>
        </>
      }
    >
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('setTitle')}>
          {SECTIONS.map(([id, key]) => (
            <button key={id} className={`ghost settings-nav-item${sec === id ? ' active' : ''}`}
                    aria-current={sec === id ? 'page' : undefined} data-sec={id}
                    onClick={() => setSec(id)}>
              {t(key)}
            </button>
          ))}
        </nav>
        <div className="modal-body settings-main" key={sec}>
          <div className="settings-section-head">
            <h3>{t(SECTIONS.find(([id]) => id === sec)![1])}</h3>
            {sec === 'keys' && <KeysHeadActions />}
            {resettable && (
              <button className="ghost" onClick={() => keysOf(sec).forEach((k) => setKey(k, null))}>
                {t('setResetSection')}
              </button>
            )}
          </div>
          {body[sec]}
        </div>
      </div>
    </Modal>
  )
}
