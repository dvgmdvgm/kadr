// The export's progress read-out (G8): frames per second and time left from a
// moving average of the progress events, and the size a bitrate promises.
//
// The bug this guards: a rate taken from the whole run so far never forgets a
// slow start (fragments opening, decoders warming up), and a rate taken from
// the last two events jumps with every hiccup — either way the «осталось» the
// user plans around is wrong.
// Cost: a misleading progress display.  Run: node scripts/check-eta.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const load = (entry) => import('data:text/javascript;base64,' + Buffer.from(buildSync({
  entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false,
  alias: { '@shared': join(root, 'shared') }
}).outputFiles[0].text).toString('base64'))
const { etaOf, fmtClock, estimateBytes } = await load('shared/exportEta.ts')
const { isSeqFrame } = await load('shared/rawEncode.ts')

// a steady 60 fps render of 3600 frames, events every 5 frames (as the exporter
// sends them), ±30 % jitter per frame, after a 3 s start where nothing moves
// (fragments and decoders opening) — the start must not poison the estimate
{
  const total = 3600, fps = 60
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const times = [3]
  for (let k = 1; k < total; k++) times.push(times[k - 1] + (1 / fps) * (0.7 + 0.6 * rnd()))
  const samples = [{ t: 0, p: 0 }]
  let worst = 0, worstFps = 0, at = null
  for (let k = 4; k < total; k += 5) {
    samples.push({ t: times[k], p: (k + 1) / total })
    if (k + 1 >= total * 0.1 && k < total - 1) {
      const e = etaOf(samples, total)
      const truth = times[total - 1] - times[k]
      worst = Math.max(worst, Math.abs(e.eta - truth) / truth)
      worstFps = Math.max(worstFps, Math.abs(e.fps - fps) / fps)
      at ??= e
    }
  }
  check('the ETA converges within 10 % after 10 % of frames on a steady render',
    worst < 0.1, `worst ${(worst * 100).toFixed(1)} % (at 10 %: eta ${at.eta.toFixed(1)} s)`)
  check('the fps read-out stays within 10 % of the real rate', worstFps < 0.1, `worst ${(worstFps * 100).toFixed(1)} %`)
  // the whole-run average this replaces is still off at 10 %: the stall is in it
  const k10 = total * 0.1 - 1
  const naive = (times[k10] / (k10 + 1)) * (total - k10 - 1)
  const truth10 = times[total - 1] - times[k10]
  check('(the whole-run average would be off by > 10 % there)', Math.abs(naive - truth10) / truth10 > 0.1,
    `${naive.toFixed(1)} s vs ${truth10.toFixed(1)} s`)
}

// nothing to say before the window has time in it, or while nothing moves
{
  check('one event gives no estimate', etaOf([{ t: 0, p: 0 }], 100) === null)
  check('a stall gives no estimate', etaOf([{ t: 0, p: 0.2 }, { t: 5, p: 0.2 }], 100) === null)
  const e = etaOf([{ t: 0, p: 0 }, { t: 2, p: 0.5 }], undefined)
  check('a phase without frames has an ETA and no fps', e && Math.abs(e.eta - 2) < 1e-9 && e.fps === null)
}

check('the clock reads m:ss, then h:mm:ss', fmtClock(5) === '0:05' && fmtClock(83.4) === '1:23' &&
  fmtClock(3725) === '1:02:05', [fmtClock(5), fmtClock(83.4), fmtClock(3725)].join(' '))

{
  const p = { videoBitrate: 10_000_000, audioBitrate: '192k', container: 'mp4' }
  const b = estimateBytes(p, 60)
  check('size = (video + audio bitrate) × duration', b === (10_000_000 + 192_000) * 60 / 8, String(b))
  check('audio only counts the audio', estimateBytes({ ...p, audioOnly: true, audioBitrate: '320k' }, 60) === 320_000 * 60 / 8)
  check('constant quality promises no size', estimateBytes({ ...p, rateControl: 'crf' }, 60) === null)
  check('ProRes / PNG promise no size', estimateBytes({ ...p, videoCodec: 'prores422' }, 60) === null &&
    estimateBytes({ ...p, container: 'png' }, 60) === null)
}

// a cancelled PNG export removes the frames it wrote — and only those
check('the sequence matcher takes the numbered frames and nothing else',
  isSeqFrame('D:/x/clip_%06d.png', 'clip_000001.png') && isSeqFrame('D:/x/clip_%06d.png', 'clip_123456.png') &&
  !isSeqFrame('D:/x/clip_%06d.png', 'clip.png') && !isSeqFrame('D:/x/clip_%06d.png', 'clip_0001.png') &&
  !isSeqFrame('D:/x/clip_%06d.png', 'other_000001.png') && !isSeqFrame('D:/x/a.b_%06d.png', 'aXb_000001.png') &&
  isSeqFrame('D:/x/a.b_%06d.png', 'a.b_000002.png'))

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1) }
console.log('\nall passed')
