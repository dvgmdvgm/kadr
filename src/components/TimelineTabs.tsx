// L6: the project's timelines as tabs over the tracks, styled like the side
// panel's. The strip shows once there is a second timeline — a project of one
// keeps its layout to the pixel. A click opens a timeline, a double click
// renames it, the right-click menu lays it into the open one or deletes it.
import { useEffect, useState } from 'react'
import type { Clip } from '@shared/types'
import { useEditor } from '@/state/store'
import { activeTimelineId, allTracks, isCompound, nestsInto, timelineTracks, timelinesOf } from '@shared/timelines'
import { useT, trf } from '@/i18n'
import { CtxMenu } from './CtxMenu'
import { Icon } from './icons'

/** Open a compound clip's timeline, the playhead on the moment that was under it. */
export function openCompound(clip: Clip) {
  const st = useEditor.getState()
  if (!clip.timelineId || !timelineTracks(st.project, clip.timelineId)) return
  const t = st.playhead
  const inside = t >= clip.start && t < clip.start + clip.duration
  st.setActiveTimeline(clip.timelineId)
  st.setPlayhead(inside ? clip.inPoint + (t - clip.start) : clip.inPoint)
}

/** why a timeline cannot be deleted, or null */
function keepReason(id: string): string | null {
  const p = useEditor.getState().project
  if (timelinesOf(p).length < 2) return 'tlLast'
  return allTracks(p).some((t) => t.clips.some((c) => isCompound(c) && c.timelineId === id)) ? 'tlUsed' : null
}

export function TimelineTabs() {
  const t = useT()
  const project = useEditor((s) => s.project)
  const [naming, setNaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const out = () => setMenu(null)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setMenu(null) } }
    window.addEventListener('pointerdown', out)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', key, true)
    }
  }, [menu])
  const list = timelinesOf(project)
  if (list.length < 2) return null
  const active = activeTimelineId(project)
  const close = () => setMenu(null)
  return (
    <div className="side-tabs tl-tabs" role="tablist" aria-label={t('tlTabs')}>
      {list.map((tl, i) => {
        const name = tl.name || trf('tlNth', { n: i + 1 })
        return naming === tl.id ? (
          <input key={tl.id} className="tl-tab-name" autoFocus defaultValue={name} aria-label={t('tlRename')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => { useEditor.getState().renameTimeline(tl.id, e.currentTarget.value); setNaming(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') { e.currentTarget.value = name; e.currentTarget.blur() }
              e.stopPropagation()
            }} />
        ) : (
          <button key={tl.id} role="tab" aria-selected={tl.id === active} data-timeline={tl.id}
            className={tl.id === active ? 'active' : ''}
            onClick={() => useEditor.getState().setActiveTimeline(tl.id)}
            onDoubleClick={() => setNaming(tl.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: tl.id, x: e.clientX, y: e.clientY }) }}>
            {name}
          </button>
        )
      })}
      <button className="tl-tab-add" data-act="timeline-add" title={t('tlNew')} aria-label={t('tlNew')}
        onClick={() => useEditor.getState().addTimeline()}>
        <Icon name="plus" size={13} />
      </button>
      {menu && (
        <CtxMenu x={menu.x} y={menu.y}>
          <button onClick={() => { setNaming(menu.id); close() }}>{t('tlRename')}</button>
          {(() => {
            const nests = nestsInto(project, active, menu.id)
            return (
              <button data-act="timeline-insert" disabled={nests} title={nests ? t('tlLoop') : undefined}
                onClick={() => {
                  const st = useEditor.getState()
                  st.insertTimelineClip(menu.id, null, st.playhead)
                  close()
                }}>
                {t('tlInsert')}
              </button>
            )
          })()}
          {(() => {
            const why = keepReason(menu.id)
            return (
              <button className="danger" data-act="timeline-delete" disabled={!!why} title={why ? t(why as 'tlLast') : undefined}
                onClick={() => { useEditor.getState().removeTimeline(menu.id); close() }}>
                {t('tlDelete')}
              </button>
            )
          })()}
          </CtxMenu>
      )}
    </div>
  )
}
