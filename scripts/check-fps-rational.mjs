// Node-side check of shared/projectFormat.ts — the project's resolution and
// frame-rate presets (card H2) — against a real encode. Needs ffmpeg/ffprobe.
//
// Cost when wrong: drift over long timelines. A 29.97 project stored as the
// decimal 29.97 is encoded at 2997/100, not 30000/1001 — the file's frames and
// the timeline's frames part by one frame every ~9 hours; stored as a rounded
// number anywhere else, much sooner.
// Run: node scripts/check-fps-rational.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const load = async (...p) => {
  try {
    const js = transformSync(readFileSync(join(root, ...p), 'utf8'), { loader: 'ts', format: 'esm', platform: 'node' }).code
    return await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  } catch (err) {
    check(`${p.join('/')} loads`, false, String(err).split('\n')[0])
    return {}
  }
}
const { FPS_PRESETS, RESOLUTION_PRESETS, exactFps, fpsLabel } = await load('shared', 'projectFormat.ts')
const { rawEncodeArgs, exportFrameCount } = await load('shared', 'rawEncode.ts')
const { toFrame, formatTime } = await load('src', 'engine', 'timelineMath.ts')

const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

run('presets', () => {
  check('frame-rate presets are the eight exact rationals',
    JSON.stringify(FPS_PRESETS) === JSON.stringify([[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]]),
    JSON.stringify(FPS_PRESETS))
  check('resolution presets: 1080p, 4K, 1080×1920, 1080×1350',
    JSON.stringify(RESOLUTION_PRESETS) === JSON.stringify([[1920, 1080], [3840, 2160], [1080, 1920], [1080, 1350]]))
  check('labels read 23,976 · 29,97 · 59,94 · 25 (dot, the caller localises)',
    [[24000, 1001], [30000, 1001], [60000, 1001], [25, 1]].map(([n, d]) => fpsLabel(n / d)).join(' ') === '23.976 29.97 59.94 25',
    [[24000, 1001], [30000, 1001], [60000, 1001], [25, 1]].map(([n, d]) => fpsLabel(n / d)).join(' '))
  check('exactFps: D\'s decimal settings become the rationals (a new project)',
    exactFps(29.97) === 30000 / 1001 && exactFps(23.976) === 24000 / 1001 && exactFps(59.94) === 60000 / 1001)
  check('exactFps leaves integer and exact rates alone',
    exactFps(25) === 25 && exactFps(30000 / 1001) === 30000 / 1001 && exactFps(12.5) === 12.5)
})

const ff = (bin, args, input) => spawnSync(bin, args, { input, maxBuffer: 1 << 28 })
if (ff('ffmpeg', ['-version']).status !== 0) {
  check('ffmpeg in PATH', false, 'the export half needs ffmpeg/ffprobe')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-fps-'))
  try {
    for (const [num, den] of [[30000, 1001], [24000, 1001]]) {
      const fps = num / den
      const W = 32, H = 18, secs = 10
      const frames = exportFrameCount(secs, fps)
      const out = join(dir, `r${num}.mp4`)
      const enc = ff('ffmpeg', rawEncodeArgs({ width: W, height: H, fps, codec: 'libx264', bitrate: 1e6, out }),
        Buffer.alloc(W * H * 4 * frames, 128))
      if (enc.status !== 0) { check(`${num}/${den} encodes`, false, String(enc.stderr)); continue }
      const probe = JSON.parse(String(ff('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate,nb_read_frames:frame=pts_time', '-of', 'json', out]).stdout))
      const st = probe.streams[0]
      check(`${fpsLabel(fps)}: ffprobe reads ${num}/${den}`, st.r_frame_rate === `${num}/${den}`, st.r_frame_rate)
      check(`${fpsLabel(fps)}: ${secs} s = ${frames} frames in the file and on the timeline`,
        Number(st.nb_read_frames) === frames && frames === Math.round(secs * num / den), `${st.nb_read_frames} vs ${frames}`)
      const pts = probe.frames.map((f) => Number(f.pts_time))
      const t0 = pts[0]
      // the file's frame k sits where the timeline's frame k sits (toFrame = E1's quantiser)
      const worst = Math.max(...pts.map((p, k) => Math.abs((p - t0) - toFrame(k * den / num, fps))))
      check(`${fpsLabel(fps)}: every frame's time = the timeline's frame step ${den}/${num} s`, worst < 1e-4, `worst ${worst.toExponential(2)} s`)
      const tcs = pts.map((p, k) => formatTime(k * den / num, fps))
      check(`${fpsLabel(fps)}: one timecode per frame, none skipped or repeated`,
        new Set(tcs).size === frames && tcs[frames - 1] === formatTime(toFrame((frames - 1) / fps, fps), fps), tcs[frames - 1])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
