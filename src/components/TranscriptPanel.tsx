// The transcript panel (card I10), landed from canvas I (design-source/canvas/I,
// RULES.md): a «Транскрипт» tab in the left side panel that reads the edit as a
// script. Words are I4's (`placeWords`, timeline order); a selection IS the
// timeline range; deleting words is `cutWords` (a silence-snapped ripple, one
// undo step); the agent's pauses, retakes and shorts are the timeline flags'
// own store, decided with the flags' own gestures.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useEditor, useSettings, projectDuration, withLinked } from '@/state/store'
import { placeWords, type PlacedWord } from '@/engine/words'
import {
  useSilences, setSilenceState, applySilences, confirmAllSilences, cuttable, proposalTip, playAround, type Silence
} from '@/engine/silences'
import { cutWords, paragraphs, nowIndex, searchHits, fmtT, useWordCuts, type Para } from '@/engine/transcript'
import { logError } from '@/engine/log'
import { useT, trf, trPlural } from '@/i18n'
import { useTextUi } from './TextTools'
import { Icon } from './icons'

/** a stretch with no words longer than this is one «без расшифровки» row */
const NOSPEECH_MIN = 2
const LOW_P = 0.5

const num = (x: number, d = 1) => (useSettings.getState().lang === 'ru' ? x.toFixed(d).replace('.', ',') : x.toFixed(d))
const mmss = (t: number) => {
  const s = Math.round(Math.max(0, t))
  return s >= 3600 ? fmtT(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const seek = (t: number) => useEditor.getState().setPlayhead(t)
const isRetake = (x: Silence) => x.kind !== 'silence' && x.kind !== 'short'
const stateCls = (x: Silence) => (x.state === 'proposed' ? '' : ` ${x.state}`)
/** a flag's gestures: LMB confirms (Alt unmarks), RMB keeps, double click plays */
const gestures = (x: Silence) => ({
  onClick: (e: React.MouseEvent) => { e.stopPropagation(); setSilenceState(x.id, e.altKey ? 'proposed' : 'confirmed') },
  onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setSilenceState(x.id, 'rejected') },
  onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); playAround(x) },
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation()
})

/** what each word and paragraph carries: proposals, chips, reasons, scissors marks */
interface Ann {
  retake: Map<number, Silence>
  chips: Map<number, Silence[]>
  reasons: Map<number, Silence[]>
  marks: Map<number, { at: number; len: number }[]>
}

/** the last word started before t (−1 if none) */
const lastBefore = (words: PlacedWord[], t: number) => {
  let lo = 0, hi = words.length - 1, k = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].t0 < t) { k = m; lo = m + 1 } else hi = m - 1 }
  return k
}

const Paragraph = memo(function Paragraph({ para, words, now, selA, selB, hits, cur, ann, pending }: {
  para: Para; words: PlacedWord[]; now: number; selA: number; selB: number
  hits: string; cur: number; ann: Ann; pending: boolean
}) {
  const t = useT()
  const hitSet = new Set(hits ? hits.split(',').map(Number) : [])
  const out: ReactNode[] = []
  let group: { x: Silence; kids: ReactNode[] } | null = null
  const flush = () => {
    if (group) out.push(<span key={`r${group.x.id}`} className={`tx-retake${stateCls(group.x)}`}>{group.kids}</span>)
    group = null
  }
  for (let k = para.a; k <= para.b; k++) {
    const w = words[k]
    const x = ann.retake.get(k)
    if ((group as { x: Silence } | null)?.x !== x) flush()
    if (x && !group) group = { x, kids: [] }
    const into = group ? (group as { kids: ReactNode[] }).kids : out
    for (const m of ann.marks.get(k) ?? []) {
      const tip = trf('txCutMark', { len: num(m.len) })
      into.push(<span key={`m${m.at}`} className="tx-cut" title={tip} aria-label={tip}><Icon name="split" size={12} /></span>, ' ')
    }
    const cls = ['tx-w']
    if (w.p !== undefined && w.p < LOW_P) cls.push('tx-low')
    if (k === now) cls.push('tx-now')
    if (k >= selA && k <= selB) cls.push('tx-sel')
    if (k === cur) cls.push('tx-cur')
    else if (hitSet.has(k)) cls.push('tx-hit')
    into.push(
      <span key={k} className={cls.join(' ')} data-i={k} aria-current={k === now || undefined}
            title={w.p !== undefined && w.p < LOW_P ? t('txLow') : undefined}>{w.w}</span>, ' '
    )
    for (const c of ann.chips.get(k) ?? []) {
      const len = num(c.end - c.start)
      into.push(
        <button key={`g${c.id}`} className={`tx-gap${stateCls(c)}`} title={proposalTip(c)} aria-label={trf('txPause', { len })} {...gestures(c)}>
          <Icon name={c.state === 'confirmed' ? 'check' : 'mute'} size={9} strokeWidth={2.5} />{len}
        </button>, ' '
      )
    }
  }
  flush()
  return (
    <div className="tx-para" role="listitem">
      <button className="tx-time" title={trf('txGoTo', { time: fmtT(para.t0) })} onClick={() => seek(para.t0)}>{fmtT(para.t0)}</button>
      <p className={`tx-text${pending ? ' tx-pending' : ''}`}>{out}</p>
      {(ann.reasons.get(para.a) ?? []).map((x) => (
        <div key={x.id} className={`tx-reason${x.state === 'rejected' ? ' rejected' : ''}`}>
          <Icon name="bot" size={13} />
          <span>{x.reason} · {trf('txSecs', { len: num(x.end - x.start) })}</span>
          <button className="ghost icon-only" title={t('txReasonCut')} aria-label={t('txReasonCut')} onClick={() => setSilenceState(x.id, 'confirmed')}><Icon name="check" size={13} /></button>
          <button className="ghost icon-only" title={t('txReasonKeep')} aria-label={t('txReasonKeep')} onClick={() => setSilenceState(x.id, 'rejected')}><Icon name="close" size={13} /></button>
          <button className="ghost icon-only" title={t('txReasonPlay')} aria-label={t('txReasonPlay')} onClick={() => playAround(x)}><Icon name="play" size={13} /></button>
        </div>
      ))}
    </div>
  )
})

export function TranscriptPanel() {
  const t = useT()
  useSettings((s) => s.lang)
  const project = useEditor((s) => s.project)
  const range = useEditor((s) => s.range)
  const items = useSilences((s) => s.items)
  const marks = useWordCuts((s) => s.marks)
  const run = useTextUi((s) => s.run)
  const words = useMemo(() => placeWords(project), [project.texts, project.tracks]) // eslint-disable-line react-hooks/exhaustive-deps
  const paras = useMemo(() => paragraphs(words), [words])
  const now = useEditor((s) => nowIndex(words, s.playhead))
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const [follow, setFollow] = useState(true)
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const drag = useRef<{ anchor: number; down: number; moved: boolean } | null>(null)
  const anchor = useRef(-1)
  /** Enter's first press goes to the first hit, the next ones walk on */
  const walked = useRef(false)

  // the selection IS the range: the words whose middle lies inside it
  const [selA, selB] = useMemo(() => {
    if (!range) return [-1, -1]
    let a = -1, b = -1
    words.forEach((w, k) => { const m = (w.t0 + w.t1) / 2; if (m >= range.start && m <= range.end) { if (a < 0) a = k; b = k } })
    return [a, b]
  }, [words, range])
  const hits = useMemo(() => searchHits(words, query), [words, query])
  const curHit = hits.length ? hits[Math.min(cur, hits.length - 1)] : -1

  const ann = useMemo<Ann>(() => {
    const a: Ann = { retake: new Map(), chips: new Map(), reasons: new Map(), marks: new Map() }
    const paraOf = (k: number) => paras.find((p) => k >= p.a && k <= p.b)?.a ?? -1
    for (const x of items) {
      if (x.kind === 'silence') {
        const k = lastBefore(words, x.start + 1e-6)
        if (k >= 0) a.chips.set(k, [...(a.chips.get(k) ?? []), x])
      } else if (isRetake(x)) {
        let first = -1
        words.forEach((w, k) => { const m = (w.t0 + w.t1) / 2; if (m >= x.start && m <= x.end) { a.retake.set(k, x); if (first < 0) first = k } })
        const p = paraOf(first >= 0 ? first : Math.max(0, lastBefore(words, x.start)))
        if (p >= 0 && x.reason) a.reasons.set(p, [...(a.reasons.get(p) ?? []), x])
      }
    }
    for (const m of marks) {
      const k = Math.min(words.length - 1, lastBefore(words, m.at - 1e-3) + 1)
      if (k >= 0) a.marks.set(k, [...(a.marks.get(k) ?? []), m])
    }
    return a
  }, [items, marks, words, paras])

  // rows: paragraphs, «без расшифровки» stretches, shorts around their paragraphs
  const rows = useMemo(() => {
    const dur = projectDuration(project)
    // a clip that carries words — or is the linked twin of one — is speech, even where it is quiet
    const heard = new Set(withLinked(project, [...new Set(words.flatMap((w) => (w.clipId ? [w.clipId] : [])))]))
    const gap = (from: number, to: number) => {
      if (to - from < NOSPEECH_MIN) return null
      const m = (from + to) / 2
      const c = project.tracks.flatMap((tk) => tk.clips).find((c) => c.start <= m && c.start + c.duration > m && !heard.has(c.id))
      if (!c) return null
      const name = c.label || project.assets.find((x) => x.id === (c as { assetId?: string }).assetId)?.name || ''
      return { from, to, name }
    }
    const shorts = items.filter((x) => x.kind === 'short').sort((a, b) => a.start - b.start)
    const out: ({ k: 'gap'; from: number; to: number; name: string } | { k: 'paras'; short: Silence | null; n: number; list: Para[] })[] = []
    paras.forEach((p, i) => {
      const g = gap(i ? paras[i - 1].t1 : 0, p.t0)
      if (g) out.push({ k: 'gap', ...g })
      const sh = shorts.find((x) => p.t0 >= x.start - 0.05 && p.t0 < x.end) ?? null
      const last = out[out.length - 1]
      if (last?.k === 'paras' && last.short === sh && sh) last.list.push(p)
      else out.push({ k: 'paras', short: sh, n: sh ? shorts.indexOf(sh) + 1 : 0, list: [p] })
    })
    const tail = paras.length ? gap(paras[paras.length - 1].t1, dur) : null
    if (tail) out.push({ k: 'gap', ...tail })
    return out
  }, [paras, words, items, project])

  // follow: keep the word under the playhead in view
  useEffect(() => {
    if (!follow || now < 0) return
    const el = body.current?.querySelector<HTMLElement>('[aria-current]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [now, follow])

  const select = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    useEditor.getState().setRange({ start: words[lo].t0, end: words[hi].t1 })
  }
  const cut = async () => {
    if (busy || selA < 0) return
    setBusy(true)
    try { await cutWords(words, selA, selB) } catch (e) { logError(t('txTab'), String((e as Error)?.message ?? e)) } finally { setBusy(false) }
  }
  const go = (i: number) => {
    if (!hits.length) return
    const n = (i + hits.length) % hits.length
    walked.current = true
    setCur(n)
    setFollow(false)
    seek(words[hits[n]].t0)
    requestAnimationFrame(() => body.current?.querySelector('.tx-cur')?.scrollIntoView({ block: 'center' }))
  }
  const recognize = () => {
    const s = useEditor.getState()
    const clip = s.selection.length === 1 ? s.project.tracks.flatMap((tk) => tk.clips).find((c) => c.id === s.selection[0]) : undefined
    const assetId = (clip as { assetId?: string } | undefined)?.assetId
    if (assetId) useTextUi.getState().openTranscribe({ kind: 'asset', assetId })
    else if (s.range) useTextUi.getState().openTranscribe({ kind: 'range', start: s.range.start, end: s.range.end })
    else useTextUi.getState().openTranscribe({ kind: 'range', start: 0, end: projectDuration(s.project) })
  }
  const docs = [...new Set(words.map((w) => w.docId))].map((id) => project.texts?.find((d) => d.id === id)).filter(Boolean)
  const docHere = words[now >= 0 ? now : 0]?.docId ?? docs[0]?.id
  const docName = project.texts?.find((d) => d.id === docHere)?.name ?? ''
  const canRecognize = projectDuration(project) > 0

  const head = (
    <div className="panel-head">
      <span>{t('txTab')}</span>
      <button className="ghost icon-only" title={t('txRecognize')} aria-label={t('txRecognize')} disabled={!canRecognize || !!run} onClick={recognize}>
        <Icon name="captions" size={14} />
      </button>
      <button className="ghost icon-only" title={trf('txAsSubs', { doc: docName })} aria-label={trf('txAsSubs', { doc: docName })}
              disabled={!docHere} onClick={() => docHere && useTextUi.getState().openDoc(docHere)}>
        <Icon name="srt" size={14} />
      </button>
    </div>
  )

  const progress = run && (
    <div className="tx-tools tx-progress">
      <div className="export-progress">
        <div>{t('trWorking')} {Math.round(run.progress * 100)} %</div>
        <progress value={run.progress} max={1} />
        {run.live && <div className="dim tr-live">{run.live}</div>}
      </div>
      <button className="ghost" onClick={() => window.kadr.transcribeCancel()}>{t('cancel')}</button>
    </div>
  )

  if (!words.length) {
    const off = (project.texts ?? []).find((d) => d.words?.length)
    return (
      <div className="tx-panel">
        {head}
        {progress}
        {!run && (
          <div className="tx-body">
            <div className="tx-empty">
              <b>{t('txEmptyHead')}</b>
              <span>{t('txEmptyBody')}</span>
              {off && <span>{trf('txOffTimeline', { doc: off.name })}</span>}
              <button className="primary" disabled={!canRecognize} onClick={recognize}><Icon name="captions" size={14} /> {t('txRecognize')}</button>
              <span className="dim">{t('txEmptyScope')}</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  const counts = {
    pauses: items.filter((x) => x.kind === 'silence').length,
    retakes: items.filter((x) => x.kind === 'retake').length,
    shorts: items.filter((x) => x.kind === 'short').length,
    other: items.filter((x) => isRetake(x) && x.kind !== 'retake').length
  }
  const picked = items.filter((x) => x.kind === 'short' && x.state === 'confirmed').length
  const toCut = cuttable().length
  const selLen = selA >= 0 ? words[selB].t1 - words[selA].t0 : 0
  const nSel = selA >= 0 ? selB - selA + 1 : 0
  const cutLen = marks.reduce((a, m) => a + m.len, 0)
  const total = projectDuration(project)

  return (
    <div className="tx-panel">
      {head}
      {progress || (
        <div className="tx-tools">
          <input type="search" className="bin-search tx-search" placeholder={t('txSearch')} aria-label={t('txSearch')} value={query}
                 onChange={(e) => { setQuery(e.target.value); setCur(0); walked.current = false }}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(walked.current ? cur + (e.shiftKey ? -1 : 1) : cur) } }} />
          {query.trim() && (
            <>
              <span className="tx-count">{trf('txHits', { i: hits.length ? Math.min(cur, hits.length - 1) + 1 : 0, n: hits.length })}</span>
              <button className="ghost icon-only" title={t('txPrev')} aria-label={t('txPrev')} disabled={!hits.length} onClick={() => go(cur - 1)}><Icon name="chevronUp" size={13} /></button>
              <button className="ghost icon-only" title={t('txNext')} aria-label={t('txNext')} disabled={!hits.length} onClick={() => go(cur + 1)}><Icon name="chevronDown" size={13} /></button>
            </>
          )}
          <button className={`ghost icon-only${follow ? ' toggled' : ''}`} aria-pressed={follow} title={t('txFollow')} aria-label={t('txFollow')}
                  onClick={() => setFollow(!follow)}>
            <Icon name="target" size={14} />
          </button>
        </div>
      )}
      {items.length > 0 && (
        <div className="tx-props">
          <span className="flex1">
            {[counts.pauses && trf('txPauses', { n: counts.pauses }), counts.retakes && trf('txRetakes', { n: counts.retakes }),
              counts.other && trf('txOther', { n: counts.other }), counts.shorts && trf('txShorts', { n: counts.shorts })].filter(Boolean).join(' · ')}
          </span>
          {counts.pauses + counts.retakes + counts.other > 0 && (
            <>
              <button className="ghost" onClick={confirmAllSilences}><Icon name="check" size={13} /> {t('silConfirmAll')}</button>
              <button disabled={!toCut} onClick={() => applySilences('confirmed')}><Icon name="trash" size={13} /> {trf('silApply', { n: toCut })}</button>
            </>
          )}
          {counts.shorts > 0 && (
            <button className="ghost" disabled={!picked} title={t('txExportTip')} onClick={() => useEditor.getState().setExportOpen(true)}>
              <Icon name="download" size={13} /> {trf('txExportPicked', { n: picked })}
            </button>
          )}
        </div>
      )}
      <div
        ref={body}
        className="tx-body"
        role="list"
        tabIndex={0}
        onWheel={() => setFollow(false)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) { setFollow(false); return } // the scrollbar
          const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i
          if (run || i === undefined || e.button !== 0) return
          e.preventDefault()
          body.current?.focus()
          const k = Number(i)
          if (e.shiftKey && anchor.current >= 0) { select(anchor.current, k); return }
          anchor.current = k
          drag.current = { anchor: k, down: k, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i
          if (i === undefined || (!d.moved && Number(i) === d.down)) return
          d.moved = true
          select(d.anchor, Number(i))
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (!d || d.moved) return
          seek(words[d.down].t0)
          if (useEditor.getState().range) useEditor.getState().setRange(null)
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selA >= 0 && !run) { e.preventDefault(); void cut() }
          else if (e.key === 'Escape') useEditor.getState().setRange(null)
          else if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) setFollow(false)
        }}
      >
        {rows.map((r, i) => r.k === 'gap' ? (
          <div key={`n${i}`} className="tx-nospeech">
            <span>{fmtT(r.from)}</span>
            <span>{trf('txNoSpeech', { time: fmtT(r.to), clip: r.name })}</span>
          </div>
        ) : (() => {
          const list = r.list.map((p) => {
            const inP = (k: number) => k >= p.a && k <= p.b
            const pHits = query.trim() ? hits.filter(inP).join(',') : ''
            return (
              <Paragraph key={p.a} para={p} words={words} now={inP(now) ? now : -1}
                         selA={selB >= p.a && selA <= p.b ? selA : -1} selB={selB >= p.a && selA <= p.b ? selB : -1}
                         hits={pHits} cur={inP(curHit) ? curHit : -1} ann={ann} pending={!!run} />
            )
          })
          if (!r.short) return list
          const x = r.short
          return (
            <div key={`s${x.id}`} className={`tx-short${x.state === 'confirmed' ? ' confirmed' : ''}`}>
              <div className="tx-short-head" title={proposalTip(x)}>
                <Icon name="bot" size={13} />
                <span><b>{trf('txShort', { n: r.n })}</b> · «{x.reason}» · {mmss(x.end - x.start)}</span>
                {x.state === 'confirmed' ? (
                  <button className="ghost toggled" aria-pressed="true" title={t('txUnpickTip')} onClick={() => setSilenceState(x.id, 'proposed')}>
                    <Icon name="check" size={13} /> {t('txPicked')}
                  </button>
                ) : (
                  <button className="ghost" aria-pressed="false" title={t('txPickTip')} onClick={() => setSilenceState(x.id, 'confirmed')}>{t('txPick')}</button>
                )}
              </div>
              {list}
            </div>
          )
        })())}
      </div>
      {!follow && now >= 0 && (
        <button className="tx-follow" onClick={() => setFollow(true)}>
          <Icon name="target" size={13} /> {trf('txBack', { time: fmtT(words[now].t0) })}
        </button>
      )}
      {nSel > 0 && !run ? (
        <div className="tx-selbar">
          <span className="flex1">{trf('txSel', { n: nSel, words: trPlural('txWords', nSel), len: num(selLen) })}</span>
          <button className="ghost icon-only" title={t('txPlaySel')} aria-label={t('txPlaySel')} onClick={() => useEditor.getState().playInOut()}>
            <Icon name="play" size={13} />
          </button>
          <button className="danger" title={t('txCutHint')} disabled={busy} onClick={() => void cut()}>
            <Icon name="split" size={13} /> {t('txCut')}
          </button>
        </div>
      ) : marks.length > 0 && (
        <div className="tx-selbar">
          <span className="dim"><Icon name="split" size={13} /></span>
          <span className="flex1">{trf('txDone', { n: marks.length, places: trPlural('txPlaces', marks.length), len: num(cutLen) })}</span>
          <button className="ghost" onClick={() => useEditor.getState().undo()}><Icon name="undo" size={13} /> {t('undoShort')}</button>
        </div>
      )}
      <div className="tx-foot">
        {trf('txFoot', {
          n: words.length, words: trPlural('txWords', words.length), len: mmss(total),
          docs: docs.length <= 2 ? docs.map((d) => d!.name).join(', ') : `${docs.length} ${trPlural('txDocs', docs.length)}`
        })}
      </div>
    </div>
  )
}
