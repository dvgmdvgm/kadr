import { useEffect, useRef, useState } from 'react'
import { Player, previewPrefs, previewPoolStats, PREVIEW_SCALE, type PreviewQuality } from '@/engine/player'
import { registerPreviewCanvas } from '@/engine/snapshot'
import { usePopout } from '@/engine/popout'
import { useT } from '@/i18n'
import { useEditor, useSettings, projectDuration } from '@/state/store'
import { flattenProject } from '@/engine/nesting'
import { AudioMeter } from './AudioMeter'
import { FragmentOverlays } from './FragmentOverlays'
import { ClipGizmo } from './ClipGizmo'
import { OnionSkin } from './OnionSkin'

export function Preview() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<Player | null>(null)
  const popped = usePopout((s) => s.win)
  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const transparent = useEditor((s) => s.project.background === 'transparent')
  const loading = useEditor((s) => s.previewLoading)
  const gpuLost = useEditor((s) => s.previewGpuLost)
  const quality = useSettings((s) => s.effective('playback.previewQuality').value) as PreviewQuality
  const safe = useSettings((s) => s.effective('playback.safeGuides').value) === true
  const thirds = useSettings((s) => s.effective('playback.thirds').value) === true
  const stats = useSettings((s) => s.effective('playback.frameStats').value) === true
  // the player reads the scale on its next tick and redraws (a scale change is dirty)
  useEffect(() => { previewPrefs.scale = PREVIEW_SCALE[quality] ?? 1 }, [quality])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new Player({
      getState: () => {
        const s = useEditor.getState()
        return { project: flattenProject(s.project), playhead: s.playhead, playing: s.playing, playRate: s.playRate, loop: s.loop, range: s.range, playEnd: s.playEnd }
      },
      setPlayhead: (t) => useEditor.getState().setPlayhead(t),
      setPlaying: (p) => useEditor.getState().setPlaying(p),
      setLoading: (l) => useEditor.getState().setPreviewLoading(l),
      setGpuLost: (lost) => useEditor.getState().setPreviewGpuLost(lost),
      duration: () => projectDuration(useEditor.getState().project)
    })
    player.attach(canvas)
    playerRef.current = player
    registerPreviewCanvas(canvas, player)
    return () => {
      registerPreviewCanvas(null, null)
      playerRef.current = null
      player.detach()
    }
  }, [])

  // detaching the preview moves this canvas into another window; the clock
  // has to be re-scheduled there at once instead of waiting for the old
  // window's next (possibly throttled) frame
  useEffect(() => {
    playerRef.current?.kick()
  }, [popped])

  return (
    <div className="preview">
      {/* the canvas's backing store is the compositor's (quality × project size);
          its box on screen comes from the project size alone, so every overlay
          that follows the canvas rect sits the same at any quality */}
      <div className="preview-canvas-wrap"
           style={{ '--pw': `${width}px`, '--ph': `${height}px`, '--ar': width / height } as React.CSSProperties}>
        <canvas ref={canvasRef} className={transparent ? 'preview-gl checker' : 'preview-gl'} />
        {(safe || thirds || stats) && (
          <div className="preview-frame-box">
            {thirds && <div className="pg-thirds" data-act="guide-thirds" />}
            {safe && <div className="pg-safe pg-action" data-act="guide-action" />}
            {safe && <div className="pg-safe pg-title" data-act="guide-title" />}
            {stats && <FrameStats canvas={canvasRef} />}
          </div>
        )}
        <FragmentOverlays canvas={canvasRef} />
        <OnionSkin canvas={canvasRef} />
        <ClipGizmo canvas={canvasRef} />
        {loading && !gpuLost && (
          <div className="preview-loading">
            <div className="spinner" />
          </div>
        )}
        {gpuLost && <div className="preview-gpu-lost">{t('gpuLost')}</div>}
      </div>
      <AudioMeter />
    </div>
  )
}

/** fps and dropped frames while playing (previewPoolStats), refreshed 4× a second */
function FrameStats({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const t = useT()
  const playing = useEditor((s) => s.playing)
  const popped = usePopout((s) => s.win)
  const [st, setSt] = useState(() => previewPoolStats())
  useEffect(() => {
    // the timer of the window the preview is in (it may be popped out)
    const view = canvas.current?.ownerDocument.defaultView ?? window
    const id = view.setInterval(() => setSt(previewPoolStats()), 250)
    return () => view.clearInterval(id)
  }, [canvas, popped])
  return (
    <div className="pg-stats" data-act="frame-stats" aria-live="off">
      {playing && st.fps > 0 ? st.fps.toFixed(1) : '—'} fps · {st.dropped} {t('pvDropped')}
    </div>
  )
}
