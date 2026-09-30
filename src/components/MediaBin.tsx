import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { useProxyProgress, wantsProxy, rebuildProxy } from '@/engine/proxy'
import { useOffline, openRelink } from '@/engine/offline'
import { importFiles, dropPayload, dragHasMedia, dropUsable, importDrop, useImportUi } from '@/engine/mediaImport'
import { useTextUi } from './TextTools'
import { useTtsUi } from './TtsDialog'
import { useT, trf } from '@/i18n'
import { Icon, Spinner } from './icons'
import { Modal } from './Modal'
import { CtxMenu } from './CtxMenu'
import { RecentList } from './RecentProjects'
import { useModelsUi, insertModelFragment, prepareForFragment } from '@/engine/models'
import { chromiumCanDecode } from '@/engine/codecs'
import { binView, usageCounts, BIN_SORTS, type BinSort } from '@shared/binView'
import { binRows, newBinName, type BinRow } from '@shared/bins'
import { fmtClock } from '@shared/exportEta'
import { fpsLabel } from '@shared/projectFormat'
import type { BinFolder, MediaAsset } from '@shared/types'

const NO_BINS: BinFolder[] = []
/** an in-bin drag (assets and/or folders) — never read by the timeline, which takes kadr/asset */
const BIN_DRAG = 'kadr/bin-items'
/** a row inside a folder steps in by one spacing token per level */
const indent = (depth: number) =>
  depth ? { paddingLeft: `calc(var(--s4) + ${depth} * var(--s5))` } : undefined

/** a layout convenience remembered per machine (never state that must persist) */
const pref = (k: string, dflt: string) => {
  try { return localStorage.getItem(k) ?? dflt } catch { return dflt }
}
const savePref = (k: string, v: string) => {
  try { localStorage.setItem(k, v) } catch { /* a convenience */ }
}

const SORT_LABEL = { added: 'binSortAdded', name: 'binSortName', duration: 'binSortDuration', type: 'binSortType' } as const

/** what a hovered tile scrubs: the proxy, else the original when Chromium plays it; else nothing */
function scrubSrc(a: MediaAsset, offline: boolean): string | null {
  if (a.kind !== 'video' || offline || !(a.duration > 0)) return null
  if (a.proxyPath) return window.kadr.fileUrl(a.proxyPath)
  return chromiumCanDecode(a.codec) && !a.hdr ? window.kadr.fileUrl(a.path) : null
}

/** the one decoder of the bin: exists only while a tile is hovered, seeks to the pointer
    (one seek in flight; the latest position is applied when it lands) */
function ScrubVideo({ src, t }: { src: string; t: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  const want = useRef(t)
  want.current = t
  useEffect(() => {
    const v = ref.current
    if (v && v.readyState >= 1 && !v.seeking) v.currentTime = t
  }, [t])
  const follow = () => {
    const v = ref.current
    if (v && Math.abs(v.currentTime - want.current) > 0.04) v.currentTime = want.current
  }
  return (
    <video ref={ref} className="bin-scrub" src={src} muted preload="auto" crossOrigin="anonymous"
           onLoadedMetadata={follow} onSeeked={follow} />
  )
}

export function MediaBin() {
  const t = useT()
  const assets = useEditor((s) => s.project.assets)
  const tracks = useEditor((s) => s.project.tracks)
  // an empty project: the bin's empty state is where a session starts, so it offers the recent list
  const noClips = tracks.every((tk) => !tk.clips.length)
  const texts = useEditor((s) => s.project.texts ?? [])
  const ttsReady = useTtsUi((s) => s.hasKey)
  const proxyJobs = useProxyProgress((s) => s.jobs)
  const offline = useOffline((s) => s.ids)
  const [busy, setBusy] = useState(false)
  const importing = useImportUi((s) => s.active > 0)
  const [sel, setSel] = useState<string[]>([])
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const lastClick = useRef<string | null>(null)
  const [textsOpen, setTextsOpen] = useState(() => localStorage.getItem('kadr.textsOpen') !== '0')
  const toggleTexts = () => {
    setTextsOpen((v) => {
      localStorage.setItem('kadr.textsOpen', v ? '0' : '1')
      return !v
    })
  }
  // H4: layout, sort and direction are remembered; the search and «Неиспользуемые» are not —
  // a bin that opens filtered hides media
  const [layout, setLayout] = useState(() => (pref('kadr.binView', 'grid') === 'list' ? 'list' : 'grid'))
  const [sort, setSort] = useState<BinSort>(() => {
    const v = pref('kadr.binSort', 'added') as BinSort
    return BIN_SORTS.includes(v) ? v : 'added'
  })
  const [desc, setDesc] = useState(() => pref('kadr.binDesc', '0') === '1')
  const [query, setQuery] = useState('')
  const [unusedOnly, setUnusedOnly] = useState(false)
  const [scrub, setScrub] = useState<{ id: string; frac: number } | null>(null)
  // H7: the item's context menu (transcribe, prepare for a fragment, the proxy choice)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    // capture: a panel that stops pointerdown (the preview, the timeline) must still close it
    const down = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.bin-menu')) off() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') off() }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', esc)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('blur', off)
    }
  }, [menu])
  const uses = useMemo(() => usageCounts(tracks), [tracks])
  const shown = useMemo(() => binView(assets, { query, sort, desc, unusedOnly }, uses),
    [assets, query, sort, desc, unusedOnly, uses])
  // H5: folders. Open/closed is a view state of this session, not an edit of the project
  const bins = useEditor((s) => s.project.bins ?? NO_BINS)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const renameCancel = useRef(false)
  const [confirmBin, setConfirmBin] = useState<{ bin: BinFolder; count: number } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const filtering = !!query.trim() || unusedOnly
  const rows = useMemo(() => binRows(bins, shown, assets, { collapsed, filtering }),
    [bins, shown, assets, collapsed, filtering])
  // what is on screen, top to bottom — a collapsed folder hides like a filter does
  const visible = useMemo(() => rows.flatMap((r) => (r.kind === 'asset' ? [r.asset] : [])), [rows])
  const shownIds = useMemo(() => new Set(visible.map((a) => a.id)), [visible])
  // a filter never lets hidden assets go with a selection-wide delete
  const shownSel = sel.filter((id) => shownIds.has(id))
  const hasContent = assets.length > 0 || bins.length > 0

  async function importMedia(folders = false) {
    const paths = await (folders ? window.kadr.openFolderDialog() : window.kadr.openMediaDialog())
    if (!paths.length) return
    setBusy(true)
    try {
      await importFiles(paths, null)
    } finally {
      setBusy(false)
    }
  }

  // OS files / browser image URLs dropped onto the bin are imported
  // without timeline placement
  const onBinDrop = (e: React.DragEvent) => {
    const payload = dropPayload(e)
    if (!dropUsable(payload)) return
    e.preventDefault()
    void importDrop(payload, null)
  }
  // H5: an in-bin drag lands in the folder under the pointer — a folder row, or the folder
  // of the asset it is over; anywhere else in the bin is the root
  const dropTarget = (e: React.DragEvent): string | null => {
    const el = e.target as Element
    const bin = el.closest?.('[data-bin]')?.getAttribute('data-bin')
    if (bin) return bin
    const id = el.closest?.('[data-asset]')?.getAttribute('data-asset')
    return (id && assets.find((a) => a.id === id)?.binId) || null
  }
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(BIN_DRAG)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const to = dropTarget(e) ?? ''
        if (to !== dropOn) setDropOn(to)
      } else if (dragHasMedia(e)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null)
    },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(BIN_DRAG)
      if (!raw) return onBinDrop(e)
      e.preventDefault()
      setDropOn(null)
      try {
        const { assets: a, bins: b } = JSON.parse(raw) as { assets: string[]; bins: string[] }
        useEditor.getState().moveToBin(a, b, dropTarget(e))
      } catch { /* not ours */ }
    }
  }
  const dragItems = (e: React.DragEvent, items: { assets: string[]; bins: string[] }) =>
    e.dataTransfer.setData(BIN_DRAG, JSON.stringify(items))

  const toggleBin = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (!n.delete(id)) n.add(id)
      return n
    })
  /** a new folder: with the shown selection in it, inside their folder when they share one */
  const newFolder = () => {
    const homes = new Set(shownSel.map((id) => assets.find((a) => a.id === id)?.binId ?? null))
    const parent = homes.size === 1 ? [...homes][0] : null
    if (!shownSel.length) resetFilter() // an empty folder would be hidden by a filter
    const id = useEditor.getState().addBin(newBinName(bins, t('binNewFolder')), parent, shownSel)
    if (parent) setCollapsed((c) => { const n = new Set(c); n.delete(parent); return n })
    renameCancel.current = false
    setEditing(id)
  }
  const finishRename = (id: string, value: string) => {
    if (!renameCancel.current) useEditor.getState().renameBin(id, value)
    renameCancel.current = false
    setEditing(null)
  }
  const requestBinDelete = (bin: BinFolder, count: number) => {
    if (count > 0 || bins.some((b) => b.parentId === bin.id)) setConfirmBin({ bin, count })
    else useEditor.getState().removeBin(bin.id)
  }

  // click selects, Ctrl toggles, Shift extends from the last clicked item over the SHOWN order
  const clickTile = (e: React.MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
    } else if (e.shiftKey && lastClick.current) {
      const order = visible.map((a) => a.id)
      const i0 = order.indexOf(lastClick.current)
      const i1 = order.indexOf(id)
      if (i0 >= 0 && i1 >= 0) {
        setSel(order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1))
        return // shift keeps the anchor
      }
      setSel([id])
    } else {
      setSel((s) => (s.length === 1 && s[0] === id ? [] : [id]))
    }
    lastClick.current = id
  }

  /** how many timeline clips reference these assets (for the confirm text) */
  const clipsUsing = (ids: string[]) => {
    const set = new Set(ids)
    return useEditor.getState().project.tracks
      .reduce((n, tr) => n + tr.clips.filter((c) => c.assetId && set.has(c.assetId)).length, 0)
  }

  /** the cross on a tile removes it (or the whole shown selection it belongs to) */
  const requestDelete = (ids: string[]) => {
    if (clipsUsing(ids) > 0) setConfirmIds(ids)
    else doDelete(ids)
  }
  const doDelete = (ids: string[]) => {
    useEditor.getState().removeAssets(ids)
    setSel((s) => s.filter((x) => !ids.includes(x)))
    setConfirmIds(null)
  }

  /** what a tile and a row share: select, drag to the timeline, double click inserts */
  const itemProps = (a: MediaAsset) => ({
    title: offline.has(a.id) ? `${t('offlineBadge')}: ${a.path}` : a.path,
    role: 'button',
    'aria-pressed': sel.includes(a.id),
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('kadr/asset', a.id)
      // into a folder: the whole shown selection when the dragged one is part of it
      dragItems(e, { assets: shownSel.length > 1 && shownSel.includes(a.id) ? shownSel : [a.id], bins: [] })
      e.dataTransfer.effectAllowed = 'copyMove'
    },
    onDragEnd: () => setDropOn(null),
    onClick: (e: React.MouseEvent) => clickTile(e, a.id),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, id: a.id })
    },
    onDoubleClick: () => {
      const s = useEditor.getState()
      s.insertClipFromAsset(a.id, null, s.playhead)
    }
  })
  const itemClass = (base: string, a: MediaAsset) =>
    `${base}${sel.includes(a.id) ? ' selected' : ''}${offline.has(a.id) ? ' offline' : ''}`
  const offlineBadge = (a: MediaAsset) => (
    <button className="proxy-badge offline" data-offline-badge={a.id} title={t('offlineBadge')}
            aria-label={t('offlineBadge')}
            onClick={(e) => { e.stopPropagation(); openRelink() }}>
      <Icon name="unlink" size={10} />
    </button>
  )
  const delButton = (a: MediaAsset) => (
    <button
      className="bin-del"
      title={t('binDelete')}
      aria-label={t('binDelete')}
      onClick={(e) => {
        e.stopPropagation()
        requestDelete(shownSel.length > 1 && shownSel.includes(a.id) ? shownSel : [a.id])
      }}
    >
      <Icon name="close" size={13} />
    </button>
  )
  const resetFilter = () => { setQuery(''); setUnusedOnly(false) }

  const tile = (a: MediaAsset) => {
    const src = scrubSrc(a, offline.has(a.id))
    const at = scrub?.id === a.id ? scrub.frac : null
    return (
      <div
        key={a.id}
        className={itemClass('bin-item', a)}
        data-asset={a.id}
        {...itemProps(a)}
        onMouseMove={src ? (e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setScrub({ id: a.id, frac: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) })
        } : undefined}
        onMouseLeave={src ? () => setScrub(null) : undefined}
      >
        {a.thumbnail ? (
          <img src={a.thumbnail} alt="" />
        ) : (
          <div className="bin-audio"><Icon name="audio" size={26} /></div>
        )}
        {at !== null && src && (
          <>
            <ScrubVideo src={src} t={at * a.duration} />
            <div className="bin-scrub-pos" style={{ left: `${at * 100}%` }} />
          </>
        )}
        {a.kind !== 'image' && a.duration > 0 && (
          <span className="bin-dur">{at !== null ? `${fmtClock(at * a.duration)} / ` : ''}{fmtClock(a.duration)}</span>
        )}
        {offline.has(a.id) ? (
          offlineBadge(a)
        ) : proxyJobs[a.id] !== undefined ? (
          <div className="proxy-badge building" title={t('proxyBuilding')}>
            <Spinner size={9} /> {Math.round(proxyJobs[a.id] * 100)}%
          </div>
        ) : a.proxyPath ? (
          <div className="proxy-badge" title={t('proxyReady')}>
            P
          </div>
        ) : null}
        {a.hasAudio && (
          <button
            className="tr-badge"
            title={t('transcribe')}
            aria-label={t('transcribe')}
            onClick={(e) => {
              e.stopPropagation()
              useTextUi.getState().openTranscribe({ kind: 'asset', assetId: a.id })
            }}
          >
            <Icon name="captions" size={13} />
          </button>
        )}
        {a.kind === 'video' && (
          <button
            className="tr-badge frag-media-badge"
            data-act="fragment-media"
            title={t('fragmentMediaHint')}
            aria-label={t('fragmentMediaHint')}
            onClick={(e) => {
              e.stopPropagation()
              void prepareForFragment(a.id)
            }}
          >
            <Icon name="film" size={13} />
          </button>
        )}
        {delButton(a)}
        <div className="bin-name">
          <span>{a.name}</span>
          {!!uses.get(a.id) && (
            <span className="bin-used" title={trf('binUsedHint', { n: uses.get(a.id)! })}>{uses.get(a.id)}</span>
          )}
        </div>
      </div>
    )
  }

  const folderRow = (r: Extract<BinRow<MediaAsset>, { kind: 'bin' }>) => {
    const b = r.bin
    const renaming = editing === b.id
    return (
      <div key={`bin:${b.id}`} className={`bin-row bin-folder${dropOn === b.id ? ' drop' : ''}`} data-bin={b.id}
           role="button" tabIndex={0} aria-expanded={r.open} title={t('binFolderHint')}
           style={indent(r.depth)}
           draggable={!renaming}
           onDragStart={(e) => { dragItems(e, { assets: [], bins: [b.id] }); e.dataTransfer.effectAllowed = 'move' }}
           onDragEnd={() => setDropOn(null)}
           onClick={() => { if (!renaming) toggleBin(b.id) }}
           onDoubleClick={() => { renameCancel.current = false; setEditing(b.id) }}
           onKeyDown={(e) => {
             if (renaming || e.target !== e.currentTarget) return
             if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBin(b.id) }
             else if (e.key === 'F2') { e.preventDefault(); renameCancel.current = false; setEditing(b.id) }
           }}>
        <Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={13} />
        <span className="bin-c-name">
          <Icon name="folder" size={13} />{' '}
          {renaming ? (
            <input className="bin-rename" autoFocus defaultValue={b.name} aria-label={t('binFolderName')}
                   onFocus={(e) => e.currentTarget.select()}
                   onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                   onKeyDown={(e) => {
                     e.stopPropagation()
                     if (e.key === 'Enter') e.currentTarget.blur()
                     else if (e.key === 'Escape') { renameCancel.current = true; e.currentTarget.blur() }
                   }}
                   onBlur={(e) => finishRename(b.id, e.currentTarget.value)} />
          ) : b.name}
        </span>
        <span className="bin-c-used dim" title={trf('binFolderCount', { n: r.count })}>{r.count}</span>
        <button className="bin-del" data-act="bin-folder-delete" title={t('binFolderDelete')}
                aria-label={t('binFolderDelete')}
                onClick={(e) => { e.stopPropagation(); requestBinDelete(b, r.count) }}>
          <Icon name="close" size={13} />
        </button>
      </div>
    )
  }

  const row = (a: MediaAsset, depth: number) => (
    <div key={a.id} className={itemClass('bin-row', a)} data-asset={a.id} {...itemProps(a)}
         style={indent(depth)}>
      {a.thumbnail
        ? <img className="bin-row-thumb" src={a.thumbnail} alt="" />
        : <span className="bin-row-thumb bin-audio"><Icon name="audio" size={12} /></span>}
      <span className="bin-c-name">{offline.has(a.id) && offlineBadge(a)}{a.name}</span>
      <span className="bin-c-dur">{a.kind === 'image' ? '—' : fmtClock(a.duration)}</span>
      <span className="bin-c-res">{a.kind === 'audio' ? '—' : `${a.width}×${a.height}`}</span>
      <span className="bin-c-fps">{a.kind === 'video' && a.fps ? fpsLabel(a.fps) : '—'}</span>
      <span className="bin-c-codec">{a.codec ?? '—'}</span>
      <span className={`bin-c-used${uses.get(a.id) ? '' : ' dim'}`}>{uses.get(a.id) ?? 0}</span>
      {delButton(a)}
    </div>
  )

  /** H7: the item menu. The proxy rows take the shown selection when the item is in it */
  const itemMenu = () => {
    const a = menu && assets.find((x) => x.id === menu.id)
    if (!menu || !a) return null
    const close = () => setMenu(null)
    const targets = (shownSel.length > 1 && shownSel.includes(a.id) ? shownSel : [a.id])
      .map((id) => assets.find((x) => x.id === id))
      .filter((x): x is MediaAsset => x?.kind === 'video')
    const mode = a.proxyMode ?? 'auto'
    const setMode = (m: 'auto' | 'always' | 'never') => {
      close()
      const change = targets.filter((x) => (x.proxyMode ?? 'auto') !== m)
      if (!change.length) return
      const st = useEditor.getState()
      st.pushHistory('hProxyMode')
      for (const x of change) st.updateAsset(x.id, { proxyMode: m === 'auto' ? undefined : m })
    }
    // an undecodable codec has no original the preview could show
    const undecodable = !chromiumCanDecode(a.codec)
    return (
      <CtxMenu x={menu.x} y={menu.y} className="bin-menu">
        {a.hasAudio && (
          <button data-act="bin-menu-transcribe" onClick={() => {
            close()
            useTextUi.getState().openTranscribe({ kind: 'asset', assetId: a.id })
          }}>{t('transcribe')}</button>
        )}
        {a.kind === 'video' && (
          <button data-act="bin-menu-fragment-media" title={t('fragmentMediaHint')}
                  onClick={() => { close(); void prepareForFragment(a.id) }}>{t('binMenuFragmentMedia')}</button>
        )}
        {a.kind === 'video' && (
          <>
            <div className="ctx-title">{t('binMenuProxy')}</div>
            {(['auto', 'always', 'never'] as const).map((m) => (
              <button key={m} data-act={`proxy-${m}`} role="menuitemradio" aria-checked={mode === m}
                      disabled={m === 'never' && undecodable}
                      title={m === 'never' && undecodable ? t('proxyNeverUndecodable') : t(`proxyHint_${m}`)}
                      onClick={() => setMode(m)}>
                <span className="ctx-check">{mode === m && <Icon name="check" size={13} />}</span>
                {t(`proxy_${m}`)}
              </button>
            ))}
            <button data-act="proxy-rebuild" disabled={!wantsProxy(a) || proxyJobs[a.id] !== undefined}
                    title={t('proxyRebuildHint')}
                    onClick={() => { close(); for (const x of targets) rebuildProxy(x.id) }}>
              <span className="ctx-check" />{t('proxyRebuild')}
            </button>
          </>
        )}
      </CtxMenu>
    )
  }

  const toolButton = (icon: 'grid' | 'list', label: string, on: boolean, act: () => void) => (
    <button className={`ghost icon-only${on ? ' toggled' : ''}`} title={label} aria-label={label}
            aria-pressed={on} onClick={act}>
      <Icon name={icon} size={13} />
    </button>
  )

  return (
    <div className="media-bin">
      <div className="panel-head">
        <span>{t('media')}</span>
        {shownSel.length > 0 && (
          <button
            className="bin-del-sel"
            data-act="delete-selected"
            title={t('binDeleteSel')}
            onClick={() => requestDelete(shownSel)}
          >
            <Icon name="trash" size={13} /> {shownSel.length}
          </button>
        )}
        {assets.some((a) => offline.has(a.id)) && (
          <button className="danger" data-act="relink" onClick={() => openRelink()}>
            <Icon name="unlink" size={13} /> {t('relinkBtn')}
          </button>
        )}
        {hasContent && (
          <button className="ghost icon-only" data-act="bin-new-folder" title={t('binNewFolderHint')}
                  aria-label={t('binNewFolder')} onClick={newFolder}>
            <Icon name="folderPlus" size={13} />
          </button>
        )}
        <button className="ghost icon-only" data-act="import-folder" title={t('impFolderHint')}
                aria-label={t('impFolder')} onClick={() => importMedia(true)} disabled={busy || importing}>
          <Icon name="folderOpen" size={13} />
        </button>
        <button data-act="import" onClick={() => importMedia()} disabled={busy || importing}>
          {busy || importing ? '…' : t('import')}
        </button>
      </div>
      {hasContent && (
        <div className="bin-tools">
          <input type="search" className="bin-search" data-act="bin-search" placeholder={t('binSearch')}
                 aria-label={t('binSearchLabel')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {toolButton('grid', t('binGrid'), layout === 'grid', () => { setLayout('grid'); savePref('kadr.binView', 'grid') })}
          {toolButton('list', t('binList'), layout === 'list', () => { setLayout('list'); savePref('kadr.binView', 'list') })}
          <select className="bin-sort" aria-label={t('binSortLabel')} value={sort}
                  onChange={(e) => { const v = e.target.value as BinSort; setSort(v); savePref('kadr.binSort', v) }}>
            {BIN_SORTS.map((k) => <option key={k} value={k}>{t(SORT_LABEL[k])}</option>)}
          </select>
          <button className="ghost icon-only" data-act="bin-dir" title={t(desc ? 'binDesc' : 'binAsc')}
                  aria-label={t(desc ? 'binDesc' : 'binAsc')}
                  onClick={() => { setDesc(!desc); savePref('kadr.binDesc', desc ? '0' : '1') }}>
            <Icon name={desc ? 'sortDesc' : 'sortAsc'} size={13} />
          </button>
          <button className={`ghost${unusedOnly ? ' toggled' : ''}`} data-act="bin-unused" aria-pressed={unusedOnly}
                  title={t('binUnusedHint')} onClick={() => setUnusedOnly(!unusedOnly)}>
            {t('binUnused')}
          </button>
        </div>
      )}
      {layout === 'list' && rows.length > 0 ? (
        <div className={`bin-list${dropOn === '' ? ' drop' : ''}`} {...dropProps}>
          <div className="bin-row bin-list-head" aria-hidden="true">
            <span className="bin-row-thumb" />
            <span className="bin-c-name">{t('binColName')}</span>
            <span className="bin-c-dur">{t('binColDur')}</span>
            <span className="bin-c-res">{t('binColRes')}</span>
            <span className="bin-c-fps">{t('binColFps')}</span>
            <span className="bin-c-codec">{t('binColCodec')}</span>
            <span className="bin-c-used" title={t('binUnusedHint')}>{t('binColUsed')}</span>
          </div>
          {rows.map((r) => (r.kind === 'bin' ? folderRow(r) : row(r.asset, r.depth)))}
        </div>
      ) : (
        <div className={`bin-grid${dropOn === '' ? ' drop' : ''}`} {...dropProps}>
          {!hasContent && <div className="hint">{t('emptyBin')}</div>}
          {!hasContent && noClips && (
            <div className="bin-recent">
              <div className="ctx-title">{t('recentTitle')}</div>
              <RecentList />
            </div>
          )}
          {hasContent && rows.length === 0 && (
            <div className="hint">
              {query.trim() ? trf('binNoMatch', { q: query.trim() }) : t('binNoUnused')}
              <br />
              <button className="ghost" data-act="bin-reset" onClick={resetFilter}>{t('binResetFilter')}</button>
            </div>
          )}
          {rows.map((r) => (r.kind === 'bin' ? folderRow(r) : tile(r.asset)))}
        </div>
      )}
      <ModelsSection />
      {itemMenu()}
      {confirmIds && (
        <Modal
          title={t('binConfirmTitle')}
          className="bin-confirm"
          onClose={() => setConfirmIds(null)}
          actions={
            <>
              <button onClick={() => setConfirmIds(null)}>{t('cancel')}</button>
              <button className="primary danger" onClick={() => doDelete(confirmIds)}>
                <Icon name="trash" /> {t('delete')}
              </button>
            </>
          }
        >
          <p>
            {t('binConfirmBody')
              .replace('{files}', String(confirmIds.length))
              .replace('{clips}', String(clipsUsing(confirmIds)))}
          </p>
          <p className="dim">{t('binConfirmUndo')}</p>
        </Modal>
      )}
      {confirmBin && (
        <Modal
          title={trf('binFolderConfirmTitle', { name: confirmBin.bin.name })}
          className="bin-confirm"
          onClose={() => setConfirmBin(null)}
          actions={
            <>
              <button onClick={() => setConfirmBin(null)}>{t('cancel')}</button>
              <button className="primary danger" data-act="bin-folder-confirm" onClick={() => {
                useEditor.getState().removeBin(confirmBin.bin.id)
                setConfirmBin(null)
              }}>
                <Icon name="trash" /> {t('binFolderDelete')}
              </button>
            </>
          }
        >
          <p>{trf('binFolderConfirmBody', { n: confirmBin.count })}</p>
          <p className="dim">{t('binConfirmUndo')}</p>
        </Modal>
      )}
      {texts.length > 0 && (
        <>
          <div
            className="panel-head texts-head"
            role="button"
            aria-expanded={textsOpen}
            onClick={toggleTexts}
            title={textsOpen ? t('textsCollapse') : t('textsExpand')}
          >
            <span>
              <Icon name={textsOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              {t('texts')} ({texts.length})
            </span>
          </div>
          {textsOpen && (
          <div className="text-list">
            {texts.map((d) => (
              <div className="text-item" key={d.id} title={d.path}>
                <button className="text-open" onClick={() => useTextUi.getState().openDoc(d.id)}>
                  <Icon name={d.format === 'srt' ? 'srt' : 'doc'} size={13} /> {d.name}
                </button>
                {ttsReady && (
                  <button
                    className="text-speak"
                    title={t('ttsBadge')}
                    aria-label={t('ttsBadge')}
                    onClick={() => useTtsUi.getState().openSpeak({ kind: 'doc', docId: d.id })}
                  >
                    <Icon name="speech" size={14} />
                  </button>
                )}
                <button
                  className="preset-del"
                  title={t('delete')}
                  aria-label={t('delete')}
                  onClick={() => {
                    if (useTextUi.getState().openDocId === d.id) useTextUi.getState().openDoc(null)
                    useEditor.getState().removeText(d.id)
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The project's 3D models (kadr-lib/models): a tile per model with its
 * thumbnail and real size; a double click (or the play badge) puts a ready 3D
 * fragment on the timeline at the playhead. Fragments use them as
 * `import m from '@lib/models/<name>.glb'` + useModel(m) from '@kadr/three'.
 */
/** the line a fragment imports a model with — code, the same in any UI language */
const importLine = (m: { name: string; file: string }) =>
  `import ${m.name.replace(/[^a-zA-Z0-9_$]/g, '_')} from '@lib/models/${m.file}'`

function ModelsSection() {
  const t = useT()
  const models = useModelsUi((s) => s.models)
  const busy = useModelsUi((s) => s.busy)
  const [open, setOpen] = useState(() => localStorage.getItem('kadr.modelsOpen') !== '0')
  const [err, setErr] = useState('')
  if (!models.length && !busy) return null
  const toggle = () => setOpen((v) => { localStorage.setItem('kadr.modelsOpen', v ? '0' : '1'); return !v })
  const insert = (name: string) => {
    setErr('')
    insertModelFragment(name).catch((e) => setErr(String((e as Error)?.message ?? e)))
  }
  return (
    <>
      <div className="panel-head texts-head" role="button" aria-expanded={open} onClick={toggle} title={open ? t('textsCollapse') : t('textsExpand')}>
        <span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          {t('models3d')} ({models.length}){busy > 0 && <> <Spinner size={10} /></>}
        </span>
      </div>
      {open && (
        <div className="bin-grid">
          {models.map((m) => (
            <div key={m.name} className="bin-item model" data-model={m.name}
                 title={`${m.source}\n${m.parts.length} ${t('modelParts')} · ${m.trianglesOut} ${t('modelTris')}\n${importLine(m)}`}
                 onDoubleClick={() => insert(m.name)}>
              <img src={window.kadr.fileUrl(`${m.dir}/${m.thumb}`)} alt="" crossOrigin="anonymous" />
              <button className="tr-badge" data-act="model-insert" title={t('modelInsert')} aria-label={t('modelInsert')}
                      onClick={(e) => { e.stopPropagation(); insert(m.name) }}>
                <Icon name="play" size={13} />
              </button>
              <div className="bin-name">{m.name} · {m.sizeMm.map((x) => Math.round(x)).join('×')} {t('mm')}</div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="tr-error"><Icon name="alert" size={15} /><span>{err}</span></div>}
    </>
  )
}
