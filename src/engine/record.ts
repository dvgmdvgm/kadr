// K8: voice-over from a microphone. A track is ARMED from its header or its
// mixer strip; an armed track opens its input (getUserMedia, per track — the
// strip meters it), and «Запись» (Shift+R, the transport's button) plays the
// timeline from `playback.recordPreroll` seconds before the playhead — or the
// range's start: punch-in — while a capture worklet records every armed input
// into a buffer of its own. Stopping playback (or reaching the range's end)
// ends the take: each becomes a 16-bit mono WAV (`media:save-recording`),
// probed into the bin and placed on its track, all of them ONE undo step. The
// file keeps the pre-roll; the clip's inPoint skips it, latency compensated
// (shared/recordPlace.ts). Undo removes the clips, never the files.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useEditor, setting } from '@/state/store'
import { ensureAudio, resumeAudio, workletReady, tap, peaks, type Tap } from './audio'
import { clockOffset, placeTake } from '@shared/recordPlace'
import { logWarn } from './log'
import { tr } from '@/i18n'

interface RecordUi {
  /** armed track → its input deviceId ('' = the system default) */
  armed: Record<string, string>
  phase: 'idle' | 'count' | 'rec'
  /** seconds left in the count-in */
  count: number
}
export const useRecord = create<RecordUi>(() => ({ armed: {}, phase: 'idle', count: 0 }))

interface Input { device: string; stream: MediaStream; src: MediaStreamAudioSourceNode; tap: Tap }
const inputs = new Map<string, Input>()
const opening = new Map<string, Promise<void>>()

function closeInput(trackId: string) {
  const i = inputs.get(trackId)
  if (!i) return
  inputs.delete(trackId)
  try { i.src.disconnect() } catch { /* already */ }
  i.stream.getTracks().forEach((t) => t.stop())
}

function openInput(trackId: string, device: string): Promise<void> {
  closeInput(trackId)
  const p = (async () => {
    const c = ensureAudio()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: device ? { exact: device } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      // disarmed or switched while the device opened: a newer call owns it
      if (useRecord.getState().armed[trackId] !== device || inputs.has(trackId)) { stream.getTracks().forEach((t) => t.stop()); return }
      const src = c.createMediaStreamSource(stream)
      inputs.set(trackId, { device, stream, src, tap: tap(c, src) })
    } catch (e) {
      logWarn(tr('lgSound'), tr('lmMicFail'), String(e))
      const { [trackId]: _, ...rest } = useRecord.getState().armed
      useRecord.setState({ armed: rest })
    }
  })()
  opening.set(trackId, p)
  return p
}

let pruning = false
/** a deleted track (or another project) takes its arm and its input with it */
function prune() {
  if (pruning) return
  pruning = true
  useEditor.subscribe((s, prev) => {
    if (s.project.tracks === prev.project.tracks) return
    const ids = new Set(s.project.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
    const armed = useRecord.getState().armed
    const gone = Object.keys(armed).filter((id) => !ids.has(id))
    if (!gone.length) return
    const rest = { ...armed }
    for (const id of gone) { delete rest[id]; closeInput(id) }
    useRecord.setState({ armed: rest })
  })
}

let lastDevice = ''
export function toggleArm(trackId: string): void {
  const armed = { ...useRecord.getState().armed }
  if (trackId in armed) {
    delete armed[trackId]
    useRecord.setState({ armed })
    closeInput(trackId)
    return
  }
  prune()
  armed[trackId] = lastDevice
  useRecord.setState({ armed })
  void openInput(trackId, lastDevice)
}

export function setInput(trackId: string, device: string): void {
  if (!(trackId in useRecord.getState().armed)) return
  lastDevice = device
  useRecord.setState((s) => ({ armed: { ...s.armed, [trackId]: device } }))
  void openInput(trackId, device)
}

/** the strip's meter while armed: the input before anything is recorded */
export const inputPeaks = (trackId: string): [number, number] => peaks(inputs.get(trackId)?.tap)
export const isArmed = (trackId: string): boolean => trackId in useRecord.getState().armed

/** the system's audio inputs (labels once the microphone has been allowed) */
export function useAudioInputs(): [string, string][] {
  const [list, setList] = useState<MediaDeviceInfo[]>([])
  const armedN = useRecord((s) => Object.keys(s.armed).length)
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md) return
    const read = () => md.enumerateDevices()
      .then((all) => setList(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')))
      .catch(() => setList([]))
    read()
    md.addEventListener('devicechange', read)
    return () => md.removeEventListener('devicechange', read)
  }, [armedN]) // labels appear after the first grant
  return list.map((d) => [d.deviceId, d.label || d.deviceId.slice(0, 8)])
}

// ---- the take
interface Take { trackId: string; node: AudioWorkletNode; src: MediaStreamAudioSourceNode; startFrame: number; chunks: Float32Array[]; latency: number; done: Promise<void> }
interface Run { at: number; end: number; takes: Take[]; pairs: Array<[number, number]>; last: number; loop: boolean; unsub: () => void }
let run: Run | null = null

/** Shift+R / the transport's button: start, or stop (a stop in the count-in keeps nothing) */
export async function toggleRecording(): Promise<void> {
  if (useRecord.getState().phase !== 'idle') { await finish(); return }
  if (run) return
  let ids = Object.keys(useRecord.getState().armed)
  if (!ids.length) {
    // nothing armed: the first unlocked audio track, or a new one
    const st = useEditor.getState()
    if (!st.project.tracks.some((t) => t.kind === 'audio' && !t.locked)) st.addTrack('audio')
    const t = useEditor.getState().project.tracks.find((x) => x.kind === 'audio' && !x.locked)
    if (!t) return
    toggleArm(t.id)
    ids = [t.id]
  }
  const c = ensureAudio()
  resumeAudio()
  await Promise.all(ids.map((id) => opening.get(id)))
  try { await workletReady() } catch (e) { logWarn(tr('lgSound'), tr('lmMicFail'), String(e)); return }
  const st = useEditor.getState()
  const range = st.range
  const at = range ? range.start : st.playhead
  const end = range ? range.end : Infinity
  const offsetMs = Number(setting('playback.recordOffsetMs') ?? 0)
  const takes: Take[] = []
  for (const id of ids) {
    const i = inputs.get(id)
    if (!i) continue
    const node = new AudioWorkletNode(c, 'kadr-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit'
    })
    const settings = i.stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number }
    let ended = () => {}
    const take: Take = {
      trackId: id, node, src: i.src, startFrame: NaN, chunks: [],
      latency: (Number(settings?.latency) || 0) + offsetMs / 1000,
      done: new Promise<void>((res) => { ended = res })
    }
    node.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) take.chunks.push(e.data)
      else if (e.data === 'done') ended()
      else if (typeof e.data?.frame === 'number') take.startFrame = e.data.frame
    }
    i.src.connect(node)
    node.connect(c.destination) // outputs silence; a worklet is pulled only while it reaches the destination
    takes.push(take)
  }
  if (!takes.length) return
  const preroll = Math.max(0, Number(setting('playback.recordPreroll') ?? 3))
  const from = Math.max(0, at - preroll)
  const r: Run = { at, end, takes, pairs: [], last: from, loop: st.loop, unsub: () => {} }
  run = r
  useRecord.setState({ phase: at > from ? 'count' : 'rec', count: Math.ceil(at - from) })
  st.setPlaying(false)
  st.setPlayhead(from)
  r.unsub = useEditor.subscribe((s, prev) => {
    if (run !== r) return
    if (!s.playing) { if (prev.playing) void finish(); return }
    if (s.playhead === prev.playhead) return
    if (s.playhead < r.last - 1e-6) { void finish(); return } // the playhead was sent back: the take ends where it was
    r.last = s.playhead
    r.pairs.push([s.playhead, c.currentTime])
    if (s.playhead >= r.end) { void finish(); return }
    const left = r.at - s.playhead
    const ui = useRecord.getState()
    if (left > 0) { if (ui.count !== Math.ceil(left)) useRecord.setState({ count: Math.ceil(left) }) }
    else if (ui.phase !== 'rec') useRecord.setState({ phase: 'rec', count: 0 })
  })
  // past the timeline's end too (a voice-over runs as long as it runs), and no loop
  // wraps the take: the loop comes back when it ends
  useEditor.setState({ playing: true, playRate: 1, playEnd: r.end, loop: false })
}

async function finish(): Promise<void> {
  const r = run
  if (!r) return
  run = null
  r.unsub()
  const stopAt = Math.min(r.end, r.last)
  if (useEditor.getState().playing) useEditor.getState().setPlaying(false)
  if (r.loop) useEditor.setState({ loop: true })
  useRecord.setState({ phase: 'idle', count: 0 })
  const c = ensureAudio()
  for (const t of r.takes) t.node.port.postMessage('stop')
  await Promise.all(r.takes.map((t) => Promise.race([t.done, new Promise((res) => setTimeout(res, 1000))])))
  for (const t of r.takes) {
    try { t.src.disconnect(t.node) } catch { /* already */ }
    t.node.disconnect()
  }
  const offset = clockOffset(r.pairs)
  if (Number.isNaN(offset)) return
  const st = useEditor.getState()
  const placed: Array<{ take: Take; path: string; asset: Awaited<ReturnType<typeof window.kadr.probeMedia>>['asset']; inPoint: number; duration: number }> = []
  for (const take of r.takes) {
    const frames = take.chunks.reduce((n, ch) => n + ch.length, 0)
    const p = placeTake({ at: r.at, startFrame: take.startFrame, sampleRate: c.sampleRate, offset, latency: take.latency, frames, end: stopAt })
    if (!p) continue
    try {
      const path = await window.kadr.saveRecording(wav(take.chunks, frames, c.sampleRate), st.projectPath)
      const { asset } = await window.kadr.probeMedia(path)
      placed.push({ take, path, asset, inPoint: p.inPoint, duration: p.duration })
    } catch (e) {
      logWarn(tr('lgSound'), tr('lmRecSave'), String(e))
    }
  }
  if (!placed.length) return
  const s = useEditor.getState()
  s.pushHistory('hRecord')
  for (const x of placed) {
    s.placeAudio(x.asset, r.at, { history: null, trackId: x.take.trackId, inPoint: x.inPoint, duration: x.duration })
  }
  s.setPlayhead(r.at)
}

/** 16-bit PCM mono WAV */
function wav(chunks: Float32Array[], frames: number, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + frames * 2))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); out.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true)
  str(36, 'data'); out.setUint32(40, frames * 2, true)
  let o = 44
  for (const ch of chunks) for (let i = 0; i < ch.length; i++, o += 2) out.setInt16(o, Math.round(Math.max(-1, Math.min(1, ch[i])) * 32767), true)
  return new Uint8Array(out.buffer)
}
