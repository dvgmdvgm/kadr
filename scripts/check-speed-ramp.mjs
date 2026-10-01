// L3: a clip's speed can ramp (`Clip.speedRamp`, an Anim of speeds over clip
// time). The source runs at the INTEGRAL of the speed, and every consumer —
// preview and export frames (clipSourceTime), frame blending, the audio
// chunks, markers, trims, splits, speed changes — must agree on it. The cost
// of a consumer that does not: preview and export pick different frames in a
// ramp, or the sound drifts off the picture.
// Run: node scripts/check-speed-ramp.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error',
    mainFields: ['module', 'main'],
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const { useEditor, newProject } = await load(`export { useEditor, newProject } from './src/state/store'`)
const { clipSourceTime, waveColumns } = await load(`export { clipSourceTime, waveColumns } from './src/engine/timelineMath'`)
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
const { sourceFrameRate } = await load(`export { sourceFrameRate } from './src/engine/player'`)
const { clipMarkerTime } = await load(`export { clipMarkerTime } from './shared/markers'`)
const { srcToProject, projectToSrc } = await load(`export { srcToProject, projectToSrc } from './src/engine/voiceDefects'`)
let R = {}
try { R = await load(`export * from './shared/speedRamp'`) } catch { /* red: no module yet */ }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < tol
const s = () => useEditor.getState()
const clipOf = (id) => s().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const kf = (time, value, easing = 'linear') => ({ time, value, easing })
const ramp = (...k) => ({ value: k[0].value, keyframes: k })
const asset = { id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080, fps: 30 }

check('shared/speedRamp exports sourceOffset, relAtOffset, speedAt, rampAnim, rampMean',
  ['sourceOffset', 'relAtOffset', 'speedAt', 'rampAnim', 'rampMean'].every((k) => typeof R[k] === 'function'))
check('the store has setSpeedRamp', typeof s().setSpeedRamp === 'function')

if (fails === 0) {
  const { sourceOffset, relAtOffset, speedAt, rampAnim, rampMean } = R
  // ---- the integral itself, against closed forms
  const lin = { speed: 1, speedRamp: ramp(kf(0, 1), kf(2, 4)) }          // ∫0^2 1+1.5t = 5
  const sq = { speed: 1, speedRamp: ramp(kf(0, 1, 'easeIn'), kf(2, 4)) }  // ∫0^2 1+3(t/2)² = 4
  const pk = { speed: 1, speedRamp: ramp(kf(0, 1, 'easeInOut'), kf(2, 4, 'easeInOut'), kf(4, 1)) } // 2·(2·2.5) = 10
  check('a linear 1→4 ramp over 2 s covers 5 s of source', near(sourceOffset(lin, 2), 5, 1e-9), String(sourceOffset(lin, 2)))
  check('an ease-in 1→4 ramp over 2 s covers 4 s', near(sourceOffset(sq, 2), 4, 1e-9), String(sourceOffset(sq, 2)))
  check('a 1→4→1 ease-in-out ramp over 4 s covers 10 s', near(sourceOffset(pk, 4), 10, 1e-9), String(sourceOffset(pk, 4)))
  check('past the last key the speed holds', near(sourceOffset(lin, 3), 9, 1e-9) && near(sourceOffset(lin, -1), -1, 1e-9))
  check('a hold key integrates as a step', near(sourceOffset({ speed: 1, speedRamp: ramp(kf(0, 2, 'hold'), kf(1, 8)) }, 1), 2, 1e-6))
  let inv = 0
  for (const r of [0, 0.3, 1, 1.7, 2, 2.5, 3.9]) inv = Math.max(inv, Math.abs(relAtOffset(pk, sourceOffset(pk, r)) - r))
  check('relAtOffset inverts sourceOffset', inv < 1e-9, String(inv))
  check('speedAt reads the curve', near(speedAt(lin, 1), 2.5) && near(speedAt({ speed: 3 }, 1), 3))
  check('without a ramp it is rel × speed to the bit', sourceOffset({ speed: 1.7 }, 0.3) === 0.3 * 1.7)

  // ---- every consumer agrees: source time is the integral of the ramp
  const clip = { id: 'c', kind: 'media', assetId: 'a1', start: 5, duration: 4, inPoint: 2, speed: 1, speedRamp: pk.speedRamp,
    gain: { value: 1 }, muted: false, transform: {}, effects: [] }
  let worst = 0
  for (let r = 0; r <= 4; r += 0.05) worst = Math.max(worst, Math.abs(clipSourceTime(clip, asset, r) - (2 + sourceOffset(pk, r))))
  check('source time is the integral of the ramp in every consumer: clipSourceTime (preview, export, frame signature, demux)', worst < 1e-9, String(worst))
  check('…frame blending reads the instantaneous speed', near(sourceFrameRate(clip, asset, 30, 2), 4) && near(sourceFrameRate(clip, asset, 30, 0), 1))
  check('…a clip marker lands where the integral reaches its source second',
    near(clipMarkerTime(clip, 2 + 5), 5 + 2, 1e-6) && near(srcToProject(clip, 12), 9, 1e-6) && near(projectToSrc(clip, 7), 7, 1e-9),
    `${clipMarkerTime(clip, 7)} ${srcToProject(clip, 12)} ${projectToSrc(clip, 7)}`)

  const p = newProject()
  p.fps = 30
  p.assets = [asset]
  p.tracks = [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [clip] }]
  const segs = collectRangeAudio(p, 0, 20)
  const contiguous = segs.every((g, i) => i === 0 || near(g.start, segs[i - 1].start + segs[i - 1].duration / segs[i - 1].speed, 1e-9))
  const onCurve = segs.every((g) => near(g.inPoint, 2 + sourceOffset(pk, g.start - 5), 1e-9))
  const total = segs.reduce((a, g) => a + g.duration, 0)
  const longest = Math.max(...segs.map((g) => g.duration / g.speed))
  check('…the export audio follows the ramp in chunks that sit on the curve', segs.length > 10 && contiguous && onCurve && near(total, 10, 1e-6) && longest <= 0.1 + 1e-9,
    `${segs.length} segments, ${total} s of source, longest ${longest}`)
  // the sound is in sync within one frame: inside a chunk the source position
  // runs linearly while the picture follows the curve
  let drift = 0
  for (const g of segs) {
    const dur = g.duration / g.speed
    for (let k = 1; k < 8; k++) {
      const tl = g.start + (dur * k) / 8
      drift = Math.max(drift, Math.abs((g.inPoint + (tl - g.start) * g.speed) - clipSourceTime(clip, asset, tl - 5)) / speedAt(clip, tl - 5))
    }
  }
  check('…and stays within one frame of the picture', drift < 1 / 30, `${(drift * 1000).toFixed(2)} ms`)

  const flat = { ...clip, speedRamp: undefined, speed: 2 }
  p.tracks[0].clips = [flat]
  const fs = collectRangeAudio(p, 0, 20)
  check('a clip without a ramp still exports as one segment', fs.length === 1 && fs[0].speed === 2 && fs[0].duration === 8)

  const wf = { rate: 100, max: Uint8Array.from({ length: 6000 }, (_, i) => i % 256), rms: new Uint8Array(6000), norm: 1, windows: new Map() }
  const cols = waveColumns(wf, { cw: 40, vis0: 0, dpr: 1, zoom: 10, speed: 1, inPoint: 2, span: 58, src: (t) => sourceOffset(pk, t) })
  const x = 25 // clip-local 2.5 s → source 2 + ∫0^2.5
  check('…the timeline waveform reads the ramped source', cols.peak[x] >= Math.floor((2 + sourceOffset(pk, 2.5)) * 100) % 256, String(cols.peak[x]))

  // ---- the store: presets, duration = integral, edits keep the curve
  const fresh = () => {
    const q = newProject()
    q.fps = 30
    q.assets = [asset]
    q.tracks = [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1,
      clips: [{ ...clip, speedRamp: undefined, start: 0, duration: 6, inPoint: 2 }, { ...clip, id: 'n', speedRamp: undefined, start: 6, duration: 2, inPoint: 20 }] }]
    s().setProject(q)
  }
  fresh()
  const depth = s().past.length
  s().setSpeedRamp(['c'], 'peak')
  let c = clipOf('c')
  const want = 6 / rampMean('peak', 1)
  check('a preset ramps the clip and its duration equals the integral (one frame)', !!c.speedRamp?.keyframes?.length &&
    Math.abs(c.duration - want) <= 1 / 30 + 1e-9 && near(sourceOffset(c, c.duration), 6, 4 / 30), `${c.duration} vs ${want}, covers ${sourceOffset(c, c.duration)}`)
  check('the ramp is the preset 1→4→1', JSON.stringify(c.speedRamp.keyframes.map((k) => k.value)) === '[1,4,1]' && near(c.speedRamp.keyframes[2].time, c.duration))
  check('like the speed dial, a clip outside the group stays put', clipOf('n').start === 6)
  check('one undo step', s().past.length === depth + 1)
  const before = (r) => clipSourceTime(clipOf('c'), asset, r)
  const ref = [0.3, 1, 1.4, 2].map(before)
  s().pushHistory('hSplit')
  s().splitAt(1)
  const [L, Rt] = s().project.tracks[0].clips.filter((k) => k.inPoint < 20).sort((a, b) => a.start - b.start)
  const after = [0.3, 1, 1.4, 2].map((r) => (r < 1 ? clipSourceTime(L, asset, r) : clipSourceTime(Rt, asset, r - 1)))
  check('a split keeps every source second where it was', after.every((v, i) => near(v, ref[i], 1e-6)), JSON.stringify(after.map((v, i) => v - ref[i])))
  s().undo()
  c = clipOf('c')
  check('undo brings the ramped clip back whole', !!c.speedRamp && s().project.tracks[0].clips.length === 2)
  const mid = clipSourceTime(c, asset, 1.5)
  s().pushHistory('hTrim')
  s().trimClip('c', 'in', 0.5)
  c = clipOf('c')
  check('a trim-in keeps the content where it was', near(clipSourceTime(c, asset, 1.5 - c.start), mid, 1e-6), String(clipSourceTime(c, asset, 1.5 - c.start) - mid))
  s().undo()
  c = clipOf('c')
  const span = sourceOffset(c, c.duration)
  const d0 = c.duration
  s().setClipSpeed('c', 2, d0 / 2)
  c = clipOf('c')
  check('a speed change scales the ramp: same source span, same curve', near(sourceOffset(c, c.duration), span, 2 / 30) &&
    JSON.stringify(c.speedRamp.keyframes.map((k) => k.value)) === '[2,8,2]', `${sourceOffset(c, c.duration)} vs ${span}`)
  s().setSpeedRamp(['c'], null)
  c = clipOf('c')
  check('taking the ramp off plays the same span at the base speed', !c.speedRamp && near(c.duration, 3, 1 / 30 + 1e-9), String(c.duration))
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
