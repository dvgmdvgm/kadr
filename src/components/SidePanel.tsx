import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MediaBin } from './MediaBin'
import { AnimEditor } from './AnimEditor'
import { TrackMotionEditor } from './TrackMotionEditor'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import { Icon } from './icons'
import { ScopesPanel, ScopesTab } from './ScopesPanel'
import { scopesPopout } from '@/engine/popout'

type Tab = 'media' | 'anim' | 'motion' | 'scopes'

export function SidePanel({ width }: { width: number }) {
  const t = useT()
  const animClipId = useEditor((s) => s.animClipId)
  const motionTrackId = useEditor((s) => s.motionTrackId)
  const [tab, setTab] = useState<Tab>('media')

  // opening an editor switches to its tab; closing falls back to media
  useEffect(() => {
    setTab(animClipId ? 'anim' : motionTrackId ? 'motion' : 'media')
  }, [animClipId, motionTrackId])
  // J8: the scopes live in one host the tab or their own window holds (popout.ts);
  // brought back from the window, they come back to their tab
  const scopesWin = scopesPopout.use((s) => s.win)
  const wasWin = useRef(scopesWin)
  useEffect(() => {
    if (wasWin.current && !scopesWin) setTab('scopes')
    wasWin.current = scopesWin
  }, [scopesWin])

  return (
    <div className="side-panel" style={{ width }}>
      <div className="side-tabs">
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
          {t('media')}
        </button>
        <button className={tab === 'scopes' ? 'active' : ''} onClick={() => setTab('scopes')} data-act="tab-scopes">
          {t('scTab')}
        </button>
        {animClipId && (
          <button className={tab === 'anim' ? 'active' : ''} onClick={() => setTab('anim')}>
            {t('animTab')}
            <span
              className="tab-close"
              role="button"
              title={t('close')}
              aria-label={t('close')}
              onClick={(e) => {
                e.stopPropagation()
                useEditor.getState().setAnimClip(null)
              }}
            >
              <Icon name="close" size={12} />
            </span>
          </button>
        )}
        {motionTrackId && (
          <button className={tab === 'motion' ? 'active' : ''} onClick={() => setTab('motion')}>
            {t('motionTab')}
            <span
              className="tab-close"
              role="button"
              title={t('close')}
              aria-label={t('close')}
              onClick={(e) => {
                e.stopPropagation()
                useEditor.getState().setMotionTrack(null)
              }}
            >
              <Icon name="close" size={12} />
            </span>
          </button>
        )}
      </div>
      {tab === 'anim' && animClipId ? (
        <AnimEditor width={width} />
      ) : tab === 'motion' && motionTrackId ? (
        <TrackMotionEditor width={width} />
      ) : tab === 'scopes' ? (
        <ScopesTab />
      ) : (
        <MediaBin />
      )}
      {(tab === 'scopes' || scopesWin) && createPortal(<ScopesPanel inWindow={!!scopesWin} />, scopesPopout.host)}
    </div>
  )
}
