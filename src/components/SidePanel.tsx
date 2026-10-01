import { useEffect, useState } from 'react'
import { MediaBin } from './MediaBin'
import { MarkersList } from './MarkersList'
import { AnimEditor } from './AnimEditor'
import { TrackMotionEditor } from './TrackMotionEditor'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import { Icon } from './icons'

type Tab = 'media' | 'markers' | 'anim' | 'motion'

export function SidePanel({ width }: { width: number }) {
  const t = useT()
  const animClipId = useEditor((s) => s.animClipId)
  const motionTrackId = useEditor((s) => s.motionTrackId)
  const [tab, setTab] = useState<Tab>('media')

  // opening an editor switches to its tab; closing falls back to media
  // (the markers tab stays where it is when nothing opened)
  useEffect(() => {
    setTab((cur) => animClipId ? 'anim' : motionTrackId ? 'motion' : cur === 'markers' ? cur : 'media')
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
      ) : (
        <MediaBin />
      )}
    </div>
  )
}
