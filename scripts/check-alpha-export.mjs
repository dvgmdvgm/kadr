// Node-side check of the alpha export (G6): shared/rawEncode.ts builds the
// raw encode, electron/ffmpeg.ts ExportMuxer copies it into the final file.
//
// The bug this guards: the raw path was `rgba → yuv420p` whatever the codec,
// so a title over a transparent background came out on black — the black box
// an overlay user then has to key out. The compositor's framebuffer is
// PREMULTIPLIED (SRC_ALPHA/ONE_MINUS_SRC_ALPHA over a (0,0,0,0) clear), so the
// frames here are premultiplied too: an encoder fed them as straight alpha
// darkens every semi-transparent edge (the dark fringe). Cost of a regression:
// black boxes in overlays, or grey halos around every antialiased letter.
// Needs ffmpeg + ffprobe (PATH or KADR_FFMPEG / KADR_FFPROBE).
// Run: node scripts/check-alpha-export.mjs
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { spawnSync, execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = (entry) => import('data:text/javascript;base64,' + Buffer.from(buildSync({
  entryPoints: [join(root, ...entry)], bundle: true, platform: 'node', format: 'esm', write: false,
  alias: { '@shared': join(root, 'shared') }
}).outputFiles[0].text).toString('base64'))
const { rawEncodeArgs, withCodec, pickEncoder, seqPattern, videoCodecOf } = await load(['shared', 'rawEncode.ts'])
const { ExportMuxer, configureFfmpeg } = await load(['electron', 'ffmpeg.ts'])

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// ---- pure: which encoder, which pixel format --------------------------------
const yt = { id: 'yt1080', name: 'Y', container: 'mp4', codec: 'avc', ffmpegVideo: 'copy', width: 1920, height: 1080,
  fps: 'project', videoBitrate: 10_000_000, audioCodec: 'aac', audioBitrate: '192k' }
const base = { width: 320, height: 180, fps: 25, bitrate: 10_000_000, out: 'o' }
// the last one: `-pix_fmt rgba` of the raw input comes first
const at = (a, k) => a[a.lastIndexOf(k) + 1]
check('ProRes 4444 with alpha encodes yuva444p10le, profile 4',
  (() => { const a = rawEncodeArgs({ ...base, codec: 'prores_ks', videoCodec: 'prores4444', alpha: true })
    return at(a, '-pix_fmt') === 'yuva444p10le' && at(a, '-profile:v') === '4' })())
check('ProRes 422 HQ encodes yuv422p10le, profile 3',
  (() => { const a = rawEncodeArgs({ ...base, codec: 'prores_ks', videoCodec: 'prores422' })
    return at(a, '-pix_fmt') === 'yuv422p10le' && at(a, '-profile:v') === '3' })())
check('VP9 with alpha encodes yuva420p', at(rawEncodeArgs({ ...base, codec: 'libvpx-vp9', alpha: true }), '-pix_fmt') === 'yuva420p')
check('VP9 without alpha keeps yuv420p (the WebM preset\'s bytes)', at(rawEncodeArgs({ ...base, codec: 'libvpx-vp9' }), '-pix_fmt') === 'yuv420p')
check('alpha unpremultiplies before the encoder, opaque does not',
  at(rawEncodeArgs({ ...base, codec: 'png', alpha: true }), '-vf').includes('unpremultiply') &&
  !at(rawEncodeArgs({ ...base, codec: 'libx264' }), '-vf').includes('unpremultiply'))
check('the H.264 args are untouched by G6',
  rawEncodeArgs({ ...base, codec: 'libx264' }).join(' ') ===
  '-y -v error -f rawvideo -pix_fmt rgba -s 320x180 -r 25 -i pipe:0 -vf vflip,scale=out_color_matrix=bt709:out_range=tv ' +
  '-c:v libx264 -preset faster -b:v 10000000 -maxrate 16000000 -bufsize 30000000 -pix_fmt yuv420p ' +
  '-color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart o')
check('VP9 and AV1 quality clamp to 0–63, H.264 to 0–51',
  at(rawEncodeArgs({ ...base, codec: 'libvpx-vp9', rateControl: 'crf', crf: 60 }), '-crf') === '60' &&
  at(rawEncodeArgs({ ...base, codec: 'libaom-av1', rateControl: 'crf', crf: 60 }), '-crf') === '60' &&
  at(rawEncodeArgs({ ...base, codec: 'libx264', rateControl: 'crf', crf: 60 }), '-crf') === '51')
check('withCodec lays the codec, container and audio over a preset',
  (() => { const p = withCodec(yt, 'prores4444')
    return p.container === 'mov' && p.audioCodec === 'pcm_s16le' && videoCodecOf(p) === 'prores4444' && p.width === 1920 })())
check('an H.264 preset stays H.264 without a codec choice', withCodec(yt, '') === yt && videoCodecOf(yt) === 'h264' &&
  videoCodecOf({ ...yt, ffmpegVideo: 'libvpx-vp9' }) === 'vp9')
check('HEVC on the CPU needs libx265; without it a GPU encoder takes over',
  pickEncoder('hevc', 'x264', ['libx265']) === 'libx265' && pickEncoder('hevc', 'x264', ['hevc_nvenc']) === 'hevc_nvenc' &&
  pickEncoder('hevc', 'x264', []) === null)
check('AV1 prefers SVT-AV1, then libaom; the chosen GPU family first',
  pickEncoder('av1', 'x264', ['libaom-av1', 'libsvtav1']) === 'libsvtav1' &&
  pickEncoder('av1', 'x264', ['libaom-av1']) === 'libaom-av1' &&
  pickEncoder('av1', 'nvenc', ['libaom-av1', 'av1_nvenc']) === 'av1_nvenc' &&
  pickEncoder('av1', 'qsv', ['libaom-av1', 'av1_nvenc']) === 'libaom-av1')
check('ProRes, PNG and VP9 always have their built-in encoder',
  pickEncoder('prores4444', 'nvenc', []) === 'prores_ks' && pickEncoder('png', 'x264', []) === 'png' &&
  pickEncoder('vp9', 'nvenc', []) === 'libvpx-vp9' && pickEncoder('h264', 'nvenc', []) === 'libx264')
check('a PNG sequence is numbered beside the chosen name', seqPattern('D:/x/clip.png') === 'D:/x/clip_%06d.png')

// ---- real: a premultiplied title over transparency, encoded and read back ----
const ff = process.env.KADR_FFMPEG || 'ffmpeg'
const fp = process.env.KADR_FFPROBE || 'ffprobe'
if (spawnSync(ff, ['-version']).status !== 0) {
  console.log(`SKIP  real encodes (${ff} not runnable)`)
} else {
  configureFfmpeg({ ffmpeg: ff, ffprobe: fp, tmp: tmpdir() })
  const W = 320, H = 180
  // bottom-up premultiplied RGBA, as readPixels hands it over: a white «text»
  // block with a 4 px half-transparent rim, nothing anywhere else
  const frame = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inner = x >= 110 && x < 210 && y >= 70 && y < 110
    const rim = !inner && x >= 106 && x < 214 && y >= 66 && y < 114
    const a = inner ? 255 : rim ? 128 : 0
    frame.fill(a, (y * W + x) * 4, (y * W + x) * 4 + 4) // white premultiplied = (a, a, a, a)
  }
  const dir = mkdtempSync(join(tmpdir(), 'kadr-alpha-'))
  const encode = (o) => spawnSync(ff, rawEncodeArgs({ ...base, ...o }), { input: Buffer.concat([frame, frame, frame]) })
  // decoded straight RGBA, top-down; libvpx-vp9 is the decoder that reads the alpha side data
  const decode = (file, vp9) => execFileSync(ff, ['-v', 'error', ...(vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 })
  const px = (buf, x, y) => [...buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]
  const probe = (file) => JSON.parse(execFileSync(fp, ['-v', 'error', '-show_streams', '-of', 'json', file]).toString()).streams[0]
  const judge = (label, file, vp9) => {
    const d = decode(file, vp9)
    // the frame was bottom-up; the rim at bottom-up y=66 is top-down y=113
    const out = px(d, 5, 5), mid = px(d, 160, 90), rim = px(d, 108, 90)
    check(`${label}: alpha 0 outside the text`, out[3] === 0, out.join(','))
    check(`${label}: opaque white inside`, mid[3] >= 250 && mid[0] >= 245, mid.join(','))
    // straight alpha after unpremultiply: the rim is WHITE at half alpha, not grey
    check(`${label}: the half-transparent rim is white, no dark fringe`,
      Math.abs(rim[3] - 128) <= 6 && Math.min(rim[0], rim[1], rim[2]) >= 235, rim.join(','))
  }
  const mux = async (temp, out, preset) => {
    await new ExportMuxer().run({ projectName: 'a', preset: { ...preset, ffmpegVideo: 'copy' }, outputPath: out,
      width: W, height: H, fps: 25, duration: 3 / 25, audioSegments: [] }, temp, () => {})
  }
  try {
    const pr = join(dir, 'raw.mov')
    const r1 = encode({ codec: 'prores_ks', videoCodec: 'prores4444', alpha: true, out: pr })
    check('ProRes 4444 encodes', r1.status === 0, r1.stderr?.toString().slice(0, 300))
    const prOut = join(dir, 'final.mov')
    await mux(pr, prOut, withCodec(yt, 'prores4444'))
    const s1 = probe(prOut)
    // the decoder reports the 10-bit encode as yuva444p12le
    check('a transparent background survives into ProRes 4444: probes with alpha',
      s1.codec_name === 'prores' && /^yuva444/.test(s1.pix_fmt), `${s1.codec_name} ${s1.pix_fmt}`)
    judge('ProRes 4444', prOut, false)

    const vp = join(dir, 'raw.webm')
    const r2 = encode({ codec: 'libvpx-vp9', alpha: true, out: vp })
    check('VP9 alpha encodes', r2.status === 0, r2.stderr?.toString().slice(0, 300))
    const vpOut = join(dir, 'final.webm')
    await mux(vp, vpOut, withCodec(yt, 'vp9'))
    const s2 = probe(vpOut)
    check('a transparent background survives into VP9 alpha: the WebM keeps alpha_mode',
      s2.codec_name === 'vp9' && (s2.tags?.alpha_mode ?? s2.tags?.ALPHA_MODE) === '1', `${s2.codec_name} ${JSON.stringify(s2.tags)}`)
    judge('VP9 alpha', vpOut, true)

    const seq = seqPattern(join(dir, 'seq.png'))
    const r3 = encode({ codec: 'png', alpha: true, out: seq })
    const first = join(dir, 'seq_000001.png')
    check('a PNG sequence writes numbered RGBA frames', r3.status === 0 && existsSync(first) &&
      existsSync(join(dir, 'seq_000003.png')) && probe(first).pix_fmt === 'rgba', r3.stderr?.toString().slice(0, 300))
    if (existsSync(first)) judge('PNG', first, false)

    for (const [codec, enc] of [['hevc', 'libx265'], ['av1', 'libaom-av1']]) {
      if (!spawnSync(ff, ['-hide_banner', '-encoders']).stdout.toString().includes(enc)) {
        console.log(`SKIP  ${codec}: ${enc} not in this build`)
        continue
      }
      const f = join(dir, `${codec}.mp4`)
      const r = encode({ codec: enc, videoCodec: codec, rateControl: 'crf', crf: 30, out: f })
      const s = r.status === 0 ? probe(f) : {}
      check(`${codec} probes correctly (${enc})`, s.codec_name === codec && s.pix_fmt === 'yuv420p' && s.width === W,
        r.status === 0 ? `${s.codec_name} ${s.pix_fmt}` : r.stderr.toString().slice(0, 300))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
