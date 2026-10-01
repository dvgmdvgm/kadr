import { useEffect } from 'react'
import { MediaBin } from './MediaBin'
import { MarkersList } from './MarkersList'
import { AnimEditor } from './AnimEditor'
import { TrackMotionEditor } from './TrackMotionEditor'
import { TranscriptPanel } from './TranscriptPanel'
import { useSideTab } from '@/engine/transcript'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import { Icon } from './icons'

export function SidePanel({ width }: { width: number }) {
  const t = useT()
  const animClipId = useEditor((s) => s.animClipId)
  const motionTrackId = useEditor((s) => s.motionTrackId)
  const tab = useSideTab((s) => s.tab)
  const setTab = (tab: ReturnType<typeof useSideTab.getState>['tab']) => useSideTab.setState({ tab })

  // opening an editor switches to its tab; closing falls back to media
  // (the markers and transcript tabs stay where they are when nothing opened)
  useEffect(() => {
    useSideTab.setState((cur) => ({ tab: animClipId ? 'anim' : motionTrackId ? 'motion' : cur.tab === 'markers' || cur.tab === 'transcript' ? cur.tab : 'media' }))
  }, [animClipId, motionTrackId])

  return (
    <div className="side-panel" style={{ width }}>
      <div className="side-tabs">
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
          {t('media')}
        </button>
        <button className={tab === 'markers' ? 'active' : ''} data-act="tab-markers" onClick={() => setTab('markers')}>
          {t('markersTab')}
        </button>
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
          {t('txTab')}
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
      ) : tab === 'markers' ? (
        <MarkersList />
      ) : tab === 'transcript' ? (
        <TranscriptPanel />
      ) : (
        <MediaBin />
      )}
    </div>
  )
}
