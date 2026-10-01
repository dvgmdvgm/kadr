// Render-done chime: a short, gentle two-note signal when an export
// finishes, loud enough to hear from across the room. WebAudio only — no
// asset files; Electron's autoplay policy allows it without a gesture.
import { setting } from '@/state/store'

export function playDoneChime() {
  // «Общие» → the signal on/off and its volume (% of the peak below)
  if (setting('general.chime') !== true) return
  const vol = setting<number>('general.chimeVolume') / 100
  try {
    // K6: the chime follows the preview's output device (Настройки → Воспроизведение, the master strip)
    const sinkId = String(setting('playback.audioOutput') ?? '')
    let ctx: AudioContext
    try { ctx = new AudioContext(sinkId ? ({ sinkId } as AudioContextOptions) : undefined) } catch { ctx = new AudioContext() } // the device is gone
    const t0 = ctx.currentTime + 0.02
    const note = (freq: number, at: number, dur: number, peak: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(peak, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + dur + 0.05)
    }
    note(660, t0, 0.45, 0.22 * vol)
    note(880, t0 + 0.18, 0.7, 0.22 * vol)
    setTimeout(() => void ctx.close(), 1600)
    ;(window as unknown as { __kadrChimeAt?: number }).__kadrChimeAt = Date.now()
  } catch { /* audio device busy/absent — silence is fine */ }
}

/** Chime once per finished export — UI dialog and MCP exports alike. */
export function wireExportChime() {
  window.kadr.onExportProgress((p) => {
    if (p.phase === 'done') playDoneChime()
  })
}
