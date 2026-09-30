// Node-side check of shared/rawEncode.ts — hardware encoders (G5). No app.
//
// The bug this guards: the raw path only knew libx264 and libvpx, so an RTX
// card sat idle while x264 ran at ~50 fps. Detection parses
// `ffmpeg -hide_banner -encoders` and then trusts only a one-frame test
// encode (an encoder listed without a driver fails at encode time). Cost of a
// regression: an export that fails on a machine without the driver, or a
// hardware job whose args silently fall back to another rate control.
// With ffmpeg in PATH (or KADR_FFMPEG) the listing and the probe run for real.
// Run: node scripts/check-encoders.mjs
import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const src = readFileSync(join(root, 'shared', 'rawEncode.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { rawEncodeArgs, parseEncoders, probeEncodeArgs, rawCodec, HW_ENCODERS } = m

// a real listing (gyan.dev essentials 2025-01-08), trimmed
const LISTING = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_mf              H264 via MediaFoundation (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 A....D aac                  AAC (Advanced Audio Coding)
`
const listed = parseEncoders(LISTING)
check('the listing yields the hardware encoders, in table order',
  JSON.stringify(listed) === JSON.stringify(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'h264_amf']), listed.join(' '))
check('software, MediaFoundation and VAAPI encoders are not offered',
  !listed.some((n) => /libx264|_mf|_vaapi|aac/.test(n)))
check('an empty or foreign text yields nothing', parseEncoders('').length === 0 && parseEncoders('garbage\nV nope').length === 0)

const base = { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, out: 'o.mp4' }
const enc = (a) => a.slice(a.indexOf('-c:v'), a.indexOf('-color_primaries')).join(' ')
const TABLE = [
  ['libx264', 'abr', '-c:v libx264 -preset faster -b:v 10000000 -maxrate 16000000 -bufsize 30000000 -pix_fmt yuv420p'],
  ['libx264', 'crf', '-c:v libx264 -preset faster -crf 20 -pix_fmt yuv420p'],
  ['h264_nvenc', 'abr', '-c:v h264_nvenc -preset p5 -tune hq -rc vbr -b:v 10000000 -maxrate 16000000 -bufsize 30000000 -profile:v high -pix_fmt yuv420p'],
  ['h264_nvenc', 'crf', '-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 20 -b:v 0 -profile:v high -pix_fmt yuv420p'],
  ['hevc_nvenc', 'crf', '-c:v hevc_nvenc -preset p5 -tune hq -rc vbr -cq 20 -b:v 0 -pix_fmt yuv420p'],
  ['h264_qsv', 'abr', '-c:v h264_qsv -preset medium -b:v 10000000 -maxrate 16000000 -bufsize 30000000 -profile:v high -pix_fmt nv12'],
  ['h264_qsv', 'crf', '-c:v h264_qsv -preset medium -global_quality 20 -profile:v high -pix_fmt nv12'],
  ['h264_amf', 'abr', '-c:v h264_amf -quality quality -rc vbr_peak -b:v 10000000 -maxrate 16000000 -bufsize 30000000 -profile:v high -pix_fmt yuv420p'],
  ['h264_amf', 'crf', '-c:v h264_amf -quality quality -rc cqp -qp_i 20 -qp_p 20 -profile:v high -pix_fmt yuv420p']
]
for (const [codec, rc, want] of TABLE) {
  const got = enc(rawEncodeArgs({ ...base, codec, rateControl: rc, crf: 20 }))
  check(`${codec} ${rc} args match the table`, got === want, got)
}
check('every hardware encoder builds args with its own -c:v',
  HW_ENCODERS.every((n) => rawEncodeArgs({ ...base, codec: n }).includes(n)))

// which encoder the raw path runs for a preset
const h264 = { ffmpegVideo: 'copy' }
check('an H.264 preset with no choice runs libx264', rawCodec(h264) === 'libx264')
check('an H.264 preset on nvenc runs h264_nvenc', rawCodec({ ...h264, videoEncoder: 'nvenc' }) === 'h264_nvenc')
check('x264 chosen explicitly runs libx264', rawCodec({ ...h264, videoEncoder: 'x264' }) === 'libx264')
check('a VP9 preset keeps its own codec whatever the choice',
  rawCodec({ ffmpegVideo: 'libvpx-vp9', videoEncoder: 'nvenc' }) === 'libvpx-vp9')

// the real ffmpeg, when there is one
const ff = process.env.KADR_FFMPEG || 'ffmpeg'
const real = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
if (real.status !== 0) {
  console.log(`SKIP  real ffmpeg (${ff} not runnable)`)
} else {
  const names = parseEncoders(real.stdout)
  check('the real listing parses', Array.isArray(names), names.join(' ') || '(no hardware encoders listed)')
  // a bogus encoder name must FAIL the probe — exit code is what detection trusts
  const bogus = spawnSync(ff, probeEncodeArgs('h264_nosuch'), { encoding: 'utf8' })
  check('the probe of a missing encoder fails', bogus.status !== 0)
  for (const n of names) {
    const r = spawnSync(ff, probeEncodeArgs(n), { encoding: 'utf8', timeout: 15000 })
    console.log(`INFO  probe ${n}: ${r.status === 0 ? 'works' : 'listed, does not open'}`)
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
