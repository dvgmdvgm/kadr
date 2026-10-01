// K1: the clip's level line takes points. A click on the line becomes a key at
// the CLIP-LOCAL time under the pointer, carrying the level the line had there
// (nothing is heard to change until it is dragged); a drag moves a key between
// its neighbours, Shift keeps its level; right-click removes one, and removing
// the last leaves a flat level at its value. The cost of getting the time base
// wrong is a dip heard somewhere else, so a dip drawn this way on a clip that
// starts at 2 s and is trimmed by 1 s is mixed down and measured per window.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-gain-points.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const P = await load(`export { levelAt, addLevelPoint, moveLevelPoint, deleteLevelPoint, shiftLevel } from './src/components/animUtils'`)
const { evalAnim } = await load(`export { evalAnim } from './src/engine/anim'`)
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
const { mixdownWav, FFMPEG } = await load(`export { mixdownWav, FFMPEG } from './electron/ffmpeg'`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e

// the line as the timeline draws it: a clip 4 s long, 400 px wide at x = 1000,
// 60 px tall, the level band 7 px in from the top and bottom, 0…2 (audio)
const LINE = { left: 1000, top: 50, width: 400, duration: 4, pad: 7, usable: 46, max: 2 }
const yOf = (v) => LINE.top + LINE.pad + (1 - v / LINE.max) * LINE.usable

// ---- points added on the line become keys at clip-local times
{
  const at = P.levelAt(LINE, 1000 + 150, yOf(1))
  check('the pointer maps to clip-local time and level', near(at.t, 1.5) && near(at.v, 1), JSON.stringify(at))
  check('the time is clamped to the clip', P.levelAt(LINE, 900, yOf(1)).t === 0 && P.levelAt(LINE, 1500, yOf(1)).t === 4)
  check('the level is clamped to 0…max', P.levelAt(LINE, 1100, 0).v === 2 && P.levelAt(LINE, 1100, 999).v === 0)

  let g = { value: 0.8 }
  for (const x of [1100, 1300, 1150]) g = P.addLevelPoint(g, P.levelAt(LINE, x, yOf(0.2)).t)
  check('points added on the line become keys at clip-local times',
    JSON.stringify(g.keyframes.map((k) => k.time)) === '[1,1.5,3]', JSON.stringify(g.keyframes))
  check('a new point keeps the level the line had there (nothing changes until it is dragged)',
    g.keyframes.every((k) => near(k.value, 0.8)) && [0, 1.2, 2, 3.9].every((t) => near(evalAnim(g, t), 0.8)))
  const ramp = { value: 1, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 4, value: 1, easing: 'linear' }] }
  const onRamp = P.addLevelPoint(ramp, 1)
  check('a point added on a ramp sits on the ramp', near(onRamp.keyframes[1].value, 0.25) && near(evalAnim(onRamp, 3), 0.75))
  check('a second click on a point does not add another', P.addLevelPoint(g, 1.5).keyframes.length === 3)
}

// ---- drag, Shift, delete, the whole-line drag
{
  const g = { value: 1, keyframes: [{ time: 1, value: 1, easing: 'linear' }, { time: 2, value: 1, easing: 'linear' }, { time: 3, value: 1, easing: 'linear' }] }
  const m = P.moveLevelPoint(g, 1, 2.4, 0.25, { duration: 4, max: 2 })
  check('a drag moves the point in time and level', near(m.keyframes[1].time, 2.4) && near(m.keyframes[1].value, 0.25))
  const past = P.moveLevelPoint(g, 1, 3.7, 0.5, { duration: 4, max: 2 })
  check('a point never passes its neighbour', past.keyframes[1].time < 3 && past.keyframes.map((k) => k.time).join() === [1, past.keyframes[1].time, 3].join())
  const edge = P.moveLevelPoint(g, 0, -2, 9, { duration: 4, max: 2 })
  check('a point stays inside the clip and the level range', edge.keyframes[0].time === 0 && edge.keyframes[0].value === 2)
  const shift = P.moveLevelPoint(g, 1, 2.5, 0.1, { duration: 4, max: 2, keepLevel: true })
  check('Shift keeps the level: the point moves along the time axis only', near(shift.keyframes[1].time, 2.5) && shift.keyframes[1].value === 1)
  check('the untouched anim is not mutated', g.keyframes[1].time === 2 && g.keyframes[1].value === 1)

  const d = P.deleteLevelPoint(m, 1)
  check('right-click removes that point', d.keyframes.map((k) => k.time).join() === '1,3')
  const last = P.deleteLevelPoint({ value: 1, keyframes: [{ time: 2, value: 0.4, easing: 'linear' }] }, 0)
  check('removing the last point leaves a flat level at its value', !('keyframes' in last) && last.value === 0.4)

  const up = P.shiftLevel(m, 0.5, 2)
  check('dragging the line itself moves every point by the same level', up.keyframes.map((k) => k.value).join() === '1.5,0.75,1.5')
  check('…clamped to the range', P.shiftLevel(m, 5, 2).keyframes.every((k) => k.value === 2) && P.shiftLevel({ value: 1 }, -3, 2).value === 0)
}

// ---- a dip drawn with points lands where it was drawn, in the export
const pcmOf = (file) => {
  const buf = readFileSync(file)
  const at = buf.indexOf('data') + 8
  return new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
}
const rms = (pcm, a, b) => {
  let s = 0, n = 0
  for (let i = Math.round(a * 48000) * 2; i < Math.round(b * 48000) * 2 && i < pcm.length; i++, n++) s += (pcm[i] / 32768) ** 2
  return Math.sqrt(s / Math.max(1, n))
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9))
const dir = mkdtempSync(join(tmpdir(), 'kadr-gainpoints-'))
try {
  const src = join(dir, 'noise.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=10:c=white:a=0.25:seed=7', '-ac', '2', '-ar', '48000', src])
  const asset = { id: 'a', kind: 'audio', path: src, duration: 10, hasAudio: true }
  const START = 2, LEN = 7
  const clip = (gain) => ({ id: 'c', kind: 'media', assetId: 'a', start: START, duration: 4, inPoint: 1, speed: 1, gain })
  const proj = (gain) => ({ assets: [asset], tracks: [{ id: 't', kind: 'audio', gain: 1, clips: [clip(gain)] }] })
  // four clicks on a flat line at 100 %, then the middle two dragged to 25 % (−12 dB)
  let g = { value: 1 }
  for (const x of [1100, 1120, 1200, 1220]) g = P.addLevelPoint(g, P.levelAt(LINE, x, yOf(1)).t)
  for (const i of [1, 2]) g = P.moveLevelPoint(g, i, g.keyframes[i].time, 0.25, LINE)
  const flat = join(dir, 'flat.wav'), dip = join(dir, 'dip.wav')
  await mixdownWav(collectRangeAudio(proj({ value: 1 }), 0, LEN), LEN, flat)
  await mixdownWav(collectRangeAudio(proj(g), 0, LEN), LEN, dip)
  const a = pcmOf(flat), b = pcmOf(dip)
  const d = (t0, t1) => db(rms(b, t0, t1)) - db(rms(a, t0, t1))
  // clip-local 1.2…2.0 s is timeline 3.2…4.0 s
  const inDip = d(3.25, 3.95), before = d(2.2, 2.95), after = d(4.25, 5.9)
  check('the dip is heard where it was drawn: −12 dB at timeline 3.2–4.0 s (clip-local 1.2–2.0)', Math.abs(inDip + 12.04) <= 0.5, `${inDip.toFixed(2)} dB`)
  check('…and not before it or after it', Math.abs(before) <= 0.1 && Math.abs(after) <= 0.1, `${before.toFixed(2)} / ${after.toFixed(2)} dB`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
