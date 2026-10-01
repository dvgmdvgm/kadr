import { useEffect } from 'react'
import { MediaBin } from './MediaBin'
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
  useEffect(() => {
    useSideTab.setState({ tab: animClipId ? 'anim' : motionTrackId ? 'motion' : 'media' })
  }, [animClipId, motionTrackId])

  return (
    <div className="side-panel" style={{ width }}>
      <div className="side-tabs">
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
          {t('media')}
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
      ) : tab === 'transcript' ? (
        <TranscriptPanel />
      ) : (
        <MediaBin />
      )}
    </div>
  )
}
