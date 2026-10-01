// L1: the markers list — the user's timeline markers and every clip marker the
// timeline shows, in time order (shared/markers.ts). A click puts the playhead
// there, the name and the note are edited in place (one undo step each, on
// Enter or leaving the field), right-click opens the timeline's marker menu.
import { useMemo } from 'react'
import { useEditor, findClip } from '@/state/store'
import { useT } from '@/i18n'
import { formatTime } from '@/engine/timelineMath'
import { markerRows, type MarkerRow } from '@shared/markers'
import { openMarkerMenu } from './Timeline'

/** a field that commits once — Enter or blur — and goes back on Escape */
function Field({ value, onCommit, className, label, placeholder }: {
  value: string; onCommit: (v: string) => void; className?: string; label: string; placeholder?: string
}) {
  return (
    <input
      key={value} // a change from elsewhere (undo, the dialog) resets the draft
      className={className} defaultValue={value} aria-label={label} placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => { if (e.currentTarget.value !== value) onCommit(e.currentTarget.value) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { e.currentTarget.value = value; e.currentTarget.blur() }
      }}
    />
  )
}

export function MarkersList() {
  const t = useT()
  const project = useEditor((s) => s.project)
  const fps = project.fps
  const near = useEditor((s) => Math.round(s.playhead * s.project.fps))
  const rows = useMemo(() => markerRows(project), [project])
  const ref = (r: MarkerRow) => ({ id: r.id, clipId: r.clipId })
  const clipName = (id: string) => {
    const c = findClip(project, id)?.clip
    return c?.label ?? project.assets.find((a) => a.id === c?.assetId)?.name ?? ''
  }
  if (!rows.length) return <div className="markers-empty">{t('markersEmpty')}</div>
  return (
    <div className="markers-list" role="list">
      {rows.map((r) => (
        <div
          key={`${r.clipId ?? ''}:${r.id}`} role="listitem"
          className={`marker-row${Math.round(r.time * fps) === near ? ' here' : ''}`}
          data-marker-row={r.id} title={t('markersRowTip')}
          style={r.color ? ({ '--mk': `var(--label-${r.color})` } as React.CSSProperties) : undefined}
          onClick={() => useEditor.getState().setPlayhead(r.time)}
          onContextMenu={(e) => {
            e.preventDefault()
            openMarkerMenu(ref(r), e.clientX, e.clientY)
          }}
        >
          <span className="marker-row-sw" />
          <span className="marker-row-time">{formatTime(r.time, fps)}</span>
          <span className="marker-row-name">
            <Field value={r.label} label={t('markerName')}
              onCommit={(label) => useEditor.getState().updateMarker(ref(r), { label })} />
            {r.clipId && <span className="marker-row-clip">{clipName(r.clipId)}</span>}
          </span>
          <Field className="marker-row-note" value={r.note ?? ''} label={t('markerNote')} placeholder={t('markerNote')}
            onCommit={(note) => useEditor.getState().updateMarker(ref(r), { note })} />
        </div>
      ))}
    </div>
  )
}
