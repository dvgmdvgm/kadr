import { useEffect, useState } from 'react'
import { CtxMenu } from './CtxMenu'
import { Icon } from './icons'
import { useT } from '../i18n'
import { forgetProject, recentProjects, useRecent } from '@/engine/storage'
import { appCommands } from '@/engine/actions'
import { baseOf, dirOf } from '@shared/paths'
import type { Recent } from '@shared/recent'

/**
 * The recent-projects rows (card H1): name, folder and date, newest first; a
 * file that is gone is greyed and offers «Убрать». Picking one goes through
 * the guarded openProjectAt (`appCommands.openRecent`). Shown in «Открыть»'s dropdown
 * and in the empty bin (the empty-project start state).
 */
export function RecentList({ onPick }: { onPick?(): void }) {
  const t = useT()
  const list = useRecent((s) => s.list)
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => { if (!list) void recentProjects() }, [list])
  useEffect(() => {
    if (!list?.length) return
    let live = true
    void window.kadr.statMany(list.map((r) => r.path)).then((sizes) => {
      if (live) setMissing(new Set(list.filter((_, i) => sizes[i] === null).map((r) => r.path)))
    }, () => {})
    return () => { live = false }
  }, [list])
  if (!list?.length) return <div className="recent-none">{t('recentNone')}</div>
  return (
    <>
      {list.map((r: Recent) => {
        const gone = missing.has(r.path)
        return (
          <div key={r.path} className={`recent-row${gone ? ' missing' : ''}`}>
            <button
              data-act="recent-open"
              disabled={gone}
              title={gone ? `${t('recentMissing')}: ${r.path}` : r.path}
              onClick={() => { onPick?.(); appCommands.openRecent(r.path) }}
            >
              <span className="recent-name">{baseOf(r.path).replace(/\.kadr$/i, '')}</span>
              <span className="recent-meta">
                {gone ? t('recentMissing') : dirOf(r.path)} · {r.at ? new Date(r.at).toLocaleString() : ''}
              </span>
            </button>
            {gone && (
              <button className="danger" data-act="recent-forget" onClick={() => void forgetProject(r.path)}>
                {t('recentForget')}
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

/** the ▾ half of the «Открыть» split button */
export function RecentMenuButton() {
  const t = useT()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!at) return
    const off = () => setAt(null)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') off() }
    // capture: the preview and the timeline stop pointerdown, and a click there must still close it
    const down = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('.recent-menu, [data-act="open-recent"]')) off()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', esc)
    }
  }, [at])
  return (
    <>
      <button
        className="split-more"
        data-act="open-recent"
        title={t('recentTitle')}
        aria-label={t('recentTitle')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (at) return setAt(null)
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <Icon name="chevronDown" size={13} />
      </button>
      {at && (
        <CtxMenu x={at.x} y={at.y} className="recent-menu">
          <div className="ctx-title">{t('recentTitle')}</div>
          <RecentList onPick={() => setAt(null)} />
        </CtxMenu>
      )}
    </>
  )
}
