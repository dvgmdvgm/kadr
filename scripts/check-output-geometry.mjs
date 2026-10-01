// Output geometry of the export (G4): the frame scaled into a size that is
// not the project's — fit (bars), fill (crop) or stretch — and a frame rate
// that is not the project's. Pure maths plus real ffmpeg runs of the args.
//
// The bug this guards: a non-matching output size could only letterbox, so a
// 16:9 project exported vertically came out with black bars; and a changed fps
// must keep the duration (frames × 1/fps), not the frame count.
// Cost: bars or distortion in vertical exports, a clip that plays too fast/slow.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-output-geometry.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const load = async (f) => import('data:text/javascript;base64,' + Buffer.from(
  transformSync(readFileSync(join(root, 'shared', f), 'utf8'), { loader: 'ts', format: 'esm', platform: 'node' }).code
).toString('base64'))
const { rawEncodeArgs, outputRect, exportFrameCount } = await load('rawEncode.ts')
const { withOutput } = await load('exportPresets.ts')
const FFMPEG = process.env.KADR_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.KADR_FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m, e) => 'ffprobe' + (e ?? ''))

// ---- pure: the rectangle the project frame lands in -----------------------
const fill = outputRect('fill', 1920, 1080, 1080, 1920)
check('fill covers the whole output (no bars)',
  fill.dx <= 0 && fill.dy <= 0 && fill.dx + fill.dw >= 1080 && fill.dy + fill.dh >= 1920, JSON.stringify(fill))
check('fill keeps the source aspect', Math.abs(fill.dw / fill.dh - 1920 / 1080) < 0.002, `${fill.dw}×${fill.dh}`)
check('fill is centred', Math.abs(fill.dx + fill.dw / 2 - 540) <= 0.5 && Math.abs(fill.dy + fill.dh / 2 - 960) <= 0.5)
const fit = outputRect('fit', 1920, 1080, 1080, 1920)
check('fit letterboxes, centred', fit.dx === 0 && fit.dw === 1080 && fit.dh === 608 && fit.dy === 656, JSON.stringify(fit))
check('stretch fills the output exactly',
  JSON.stringify(outputRect('stretch', 1920, 1080, 1080, 1920)) === JSON.stringify({ dx: 0, dy: 0, dw: 1080, dh: 1920 }))

// ---- pure: the dialog's own values over a preset --------------------------
const yt = { id: 'yt1080', name: 'YT', container: 'mp4', codec: 'avc', ffmpegVideo: 'copy', width: 1920, height: 1080,
  fps: 'project', videoBitrate: 10_000_000, audioCodec: 'aac', audioBitrate: '192k' }
const none = withOutput(yt, { width: 0, height: 0, fps: 0, bitrate: 0, fit: 'fit' })
check('zero overrides keep the preset', none.width === 1920 && none.height === 1080 && none.fps === 'project' &&
  none.videoBitrate === 10_000_000)
const own = withOutput(yt, { width: 1081, height: 1920, fps: 25, bitrate: 6.5, fit: 'fill' })
check('overrides replace size, fps and bitrate; sizes even for yuv420p',
  own.width === 1082 && own.height === 1920 && own.fps === 25 && own.videoBitrate === 6_500_000 && own.fit === 'fill',
  JSON.stringify(own))

// ---- pure: a changed fps keeps the duration ---------------------------------
check('a changed fps keeps the duration',
  exportFrameCount(5, 60) === 300 && exportFrameCount(5, 30) === 150 && exportFrameCount(5, 23.976) === 120,
  `${exportFrameCount(5, 60)} / ${exportFrameCount(5, 30)} / ${exportFrameCount(5, 23.976)}`)

// ---- ffmpeg: what the args really produce ---------------------------------
const dir = mkdtempSync(join(tmpdir(), 'kadr-geom-'))
// a 16:9 frame, left half red, right half blue (bottom-up like readPixels — symmetric anyway)
function frame(w, h) {
  const b = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    b[i] = x < w / 2 ? 220 : 20; b[i + 1] = 20; b[i + 2] = x < w / 2 ? 20 : 220; b[i + 3] = 255
  }
  return b
}
function encode(opts, frames) {
  const out = join(dir, `${opts.fit ?? 'fit'}-${opts.fps}.mp4`)
  const one = frame(opts.width, opts.height)
  const r = spawnSync(FFMPEG, rawEncodeArgs({ codec: 'libx264', bitrate: 4e6, rateControl: 'crf', crf: 12, ...opts, out }),
    { input: Buffer.concat(Array(frames).fill(one)), maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return out
}
// the first frame's RGB, decoded at the output size
function rgb(file, w, h) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 30 })
  return (x, y) => { const i = (y * w + x) * 3; return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]] }
}
const isBlack = ([r, g, b]) => r + g + b < 60
const probe = (file, entries) => spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', entries, '-of', 'default=nw=1:nk=1', file]).stdout.toString().trim().split(/\r?\n/)
try {
  const w = 480, h = 270, ow = 270, oh = 480
  const filled = encode({ width: w, height: h, outWidth: ow, outHeight: oh, fps: 30, fit: 'fill' }, 2)
  check('ffmpeg fill: output is exactly the asked size', probe(filled, 'stream=width,height').join('×') === `${ow}×${oh}`)
  const px = rgb(filled, ow, oh)
  const corners = [px(1, 1), px(ow - 2, 1), px(1, oh - 2), px(ow - 2, oh - 2), px(ow >> 1, 1), px(ow >> 1, oh - 2)]
  check('ffmpeg fill: no black bars at any edge', corners.every((c) => !isBlack(c)), JSON.stringify(corners))
  // centred crop: the red/blue seam of the source sits in the middle of the output
  const row = oh >> 1
  let seam = -1
  for (let x = 1; x < ow; x++) if (px(x - 1, row)[0] > 120 && px(x, row)[0] <= 120) { seam = x; break }
  check('ffmpeg fill: the crop is centred', Math.abs(seam - ow / 2) <= 2, `seam at ${seam} of ${ow}`)

  const fitted = encode({ width: w, height: h, outWidth: ow, outHeight: oh, fps: 30, fit: 'fit' }, 2)
  const fx = rgb(fitted, ow, oh)
  check('ffmpeg fit still letterboxes (top is black, middle is not)', isBlack(fx(ow >> 1, 2)) && !isBlack(fx(4, oh >> 1)))

  const stretched = encode({ width: w, height: h, outWidth: ow, outHeight: oh, fps: 30, fit: 'stretch' }, 2)
  const sx = rgb(stretched, ow, oh)
  check('ffmpeg stretch: no bars, seam in the middle', !isBlack(sx(ow >> 1, 1)) && !isBlack(sx(ow >> 1, oh - 2)) &&
    sx(ow / 2 - 4, row)[0] > 120 && sx(ow / 2 + 4, row)[2] > 120)

  // 5 s at 30 fps from a project that would have run at 60: the duration holds
  const n = exportFrameCount(5, 30)
  const at30 = encode({ width: 64, height: 36, fps: 30 }, n)
  const [rate, frames] = probe(at30, 'stream=r_frame_rate,nb_read_frames')
  const dur = Number(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', at30])
    .stdout.toString())
  check('ffmpeg 30 fps: 150 frames, 5.0 s', rate === '30/1' && frames === '150' && Math.abs(dur - 5) < 0.02,
    `${rate} ${frames} ${dur}`)
} catch (e) {
  check('ffmpeg runs', false, String(e).slice(0, 300))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
