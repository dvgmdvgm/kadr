// K8: where a microphone take lands (shared/recordPlace.ts). Capture starts
// before the pre-roll and keeps the whole file; the clip's inPoint skips to the
// sample that was spoken while the picture showed the record point. The cost
// this guards: a voice-over out of sync with the picture.
// Synthetic clocks: a capture worklet frame counter, a player clock read
// against the context's quantised currentTime, a click spoken at a known
// timeline moment and arriving late by the device's input latency.
// Run: node scripts/check-record-place.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  entryPoints: [join(root, 'shared/recordPlace.ts')], bundle: true, platform: 'node', format: 'esm',
  write: false, logLevel: 'error'
}).outputFiles[0].text
const { clockOffset, placeTake } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const sr = 48000
const at = 10          // the playhead when record was pressed
const preroll = 3
const latency = 0.045  // the input device's own delay
const startFrame = 4_800_000 + 1234           // the worklet's first captured sample
const playCtx = 100.05                        // the context time playback started at (timeline at − p)
const tlAt = (c) => at - preroll + (c - playCtx)
const ctxOf = (tl) => playCtx + (tl - (at - preroll))

// rAF readings of (playhead, ctx.currentTime) — currentTime advances in 10 ms
// device callbacks, so a reading is up to a callback behind; jitter on the rAF
const pairs = []
for (let i = 0; i < 400; i++) {
  const real = playCtx + i / 60 + (i % 7) * 0.0003
  const ctxRead = Math.floor(real / 0.01) * 0.01
  pairs.push([tlAt(real), ctxRead])
}
const offset = clockOffset(pairs)
// a reading is late by 0–10 ms, uniformly: the median sits half a callback off
check('the clock offset is the timeline minus the context time', Math.abs(offset - (at - preroll - playCtx)) < 0.0075,
  `got ${offset.toFixed(4)} want ${(at - preroll - playCtx).toFixed(4)}`)

// the take: a click spoken while the picture shows 10.5 s, captured `latency` later
const spokenAt = 10.5
const clickFrame = Math.round((ctxOf(spokenAt) + latency) * sr) - startFrame
const frames = clickFrame + 3 * sr
const stopAt = 13.2
const place = placeTake({ at, startFrame, sampleRate: sr, offset, latency, frames, end: stopAt })
check('the take lands at the playhead, not at the pre-roll', place && Math.abs(place.start - at) < 1e-9, JSON.stringify(place))
const heard = place && place.inPoint + (spokenAt - place.start)   // source second played at timeline 10.5
const errMs = place ? (heard * sr - clickFrame) / sr * 1000 : Infinity
check('the click plays where it was spoken, latency compensated (±10 ms)', Math.abs(errMs) <= 10, `${errMs.toFixed(2)} ms`)
const raw = placeTake({ at, startFrame, sampleRate: sr, offset, latency: 0, frames, end: stopAt })
const rawErr = raw ? ((raw.inPoint + spokenAt - raw.start) * sr - clickFrame) / sr * 1000 : 0
check('without compensation the same take is late by the latency', Math.abs(rawErr + latency * 1000) <= 10, `${rawErr.toFixed(2)} ms`)
check('the clip ends where recording stopped', place && Math.abs(place.start + place.duration - stopAt) < 1e-9)
check('the pre-roll stays in the file, before the inPoint', place && place.inPoint > preroll - 0.1)

const short = placeTake({ at, startFrame, sampleRate: sr, offset, latency, frames: 4 * sr, end: stopAt })
check('a take shorter than the run ends where the audio ends', short && Math.abs(short.inPoint + short.duration - 4) < 1e-9, JSON.stringify(short))
const none = placeTake({ at, startFrame, sampleRate: sr, offset, latency, frames, end: at - 1 })
check('stopped during the pre-roll: no clip', none === null)
check('no readings: no offset', Number.isNaN(clockOffset([])))

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
