// J9: the stream's colour description is read from the SPS VUI and the colr
// box, and mapped to the matrix the preview uses (shared/streamColour.ts).
//
// The bug it pins: WebCodecs decodes every H.264 stream that is not FULLY
// described as BT.709, while <video> guesses by height (under 720 → BT.601).
// The exporter trusted the decoder's own colorSpace, so an untagged or
// matrix-only SD clip exported with saturated colours up to 41/255 off what
// the preview showed. Files are made by ffmpeg, read with mp4box — the same
// library the exporter's demuxer uses.
// Needs ffmpeg, no app.  Run: node scripts/check-stream-colour.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { transformSync } from 'esbuild'
import { createFile } from 'mp4box'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'streamColour.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { avcSpsColour, previewColour } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-streamcolour-'))
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
const tags = (p, t, m) => ['-vf', `setparams=range=tv:color_primaries=${p}:color_trc=${t}:colorspace=${m}`,
  '-color_primaries', p, '-color_trc', t, '-colorspace', m]
const make = (name, size, extra, x264 = []) => {
  const out = join(dir, name + '.mp4')
  ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=0.2`, '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', ...extra, '-movflags', '+faststart', out])
  return out
}
const remux = (name, from, extra) => {
  const out = join(dir, name + '.mp4')
  ff(['-i', from, '-c', 'copy', ...extra, out])
  return out
}
const entryOf = (file) => {
  const f = createFile()
  let info = null
  f.onReady = (i) => { info = i }
  const buf = readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  ab.fileStart = 0
  f.appendBuffer(ab)
  f.flush()
  const t = info.videoTracks[0]
  return { entry: f.getTrackById(t.id).mdia.minf.stbl.stsd.entries[0], height: t.video.height }
}
const BT601 = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }
const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = (v) => (v ? `${v.matrix}${v.fullRange ? ' full' : ''}` : 'the decoder\'s own')

try {
  const SD = '640x480', HD = '1280x720'
  const f = {
    sdNone: make('sd-none', SD, []),
    hdNone: make('hd-none', HD, []),
    sdM709: make('sd-m709', SD, ['-colorspace', 'bt709']),
    hdM601: make('hd-m601', HD, ['-colorspace', 'smpte170m']),
    sdF709: make('sd-f709', SD, tags('bt709', 'bt709', 'bt709')),
    hdF601: make('hd-f601', HD, tags('smpte170m', 'smpte170m', 'smpte170m')),
    // the SPS parser walks a High-profile SPS (every file above) and a baseline one alike
    sdBase: make('sd-base', SD, tags('smpte170m', 'smpte170m', 'smpte170m'), ['-profile:v', 'baseline'])
  }
  const colr = (p) => ['-color_primaries', p, '-color_trc', p, '-colorspace', p, '-color_range', 'tv', '-movflags', '+faststart']
  f.hdColr601 = remux('hd-colr601', f.hdNone, colr('smpte170m')) // colr box only, SPS untagged
  f.sdColr709 = remux('sd-colr709', f.sdNone, colr('bt709'))
  const hevc = (name, size, extra) => {
    const out = join(dir, name + '.mp4')
    ff(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=0.2`, '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...extra, '-movflags', '+faststart', out])
    return out
  }
  f.hevcSdNone = hevc('hevc-sd-none', SD, [])
  f.hevcHdF601 = hevc('hevc-hd-f601', HD, tags('smpte170m', 'smpte170m', 'smpte170m'))

  // 1 — what the SPS says
  const sps = (file) => avcSpsColour(entryOf(file).entry.avcC.SPS[0].data)
  check('untagged SPS has no colour description', sps(f.sdNone) === null, JSON.stringify(sps(f.sdNone)))
  const m = sps(f.sdM709)
  check('matrix-only SPS: matrix 1, primaries and transfer 2 (unspecified)', m && m.matrix === 1 && m.primaries === 2 && m.transfer === 2, JSON.stringify(m))
  const full = sps(f.hdF601)
  check('fully tagged BT.601 SPS: 6/6/6, limited range', full && full.primaries === 6 && full.transfer === 6 && full.matrix === 6 && !full.fullRange, JSON.stringify(full))
  for (const k of ['hdF601', 'sdBase']) {
    const d = sps(f[k])
    check(`${k}: the VUI is reached (6/6/6)`, d && d.primaries === 6 && d.transfer === 6 && d.matrix === 6, JSON.stringify(d))
  }
  const c = sps(f.hdColr601)
  check('remuxed with colr tags: the SPS stays untagged', c === null, JSON.stringify(c))

  // 2 — the space the preview shows it in (null = WebCodecs already decodes it so)
  const cases = [
    ['untagged SD → BT.601 (the height guess)', f.sdNone, BT601],
    ['untagged HD → BT.709', f.hdNone, BT709],
    ['matrix-only BT.709 SD → BT.601 — not «specified», so still guessed', f.sdM709, BT601],
    ['matrix-only BT.601 HD → BT.709', f.hdM601, BT709],
    ['fully tagged BT.709 SD → the decoder\'s own (both obey the SPS)', f.sdF709, null],
    ['fully tagged BT.601 HD → the decoder\'s own', f.hdF601, null],
    ['baseline profile, tagged → the decoder\'s own', f.sdBase, null],
    ['colr BT.601 only, HD → BT.601 (the element reads the box, WebCodecs does not)', f.hdColr601, BT601],
    ['colr BT.709 only, SD → BT.709', f.sdColr709, BT709],
    ['HEVC untagged SD → BT.601', f.hevcSdNone, BT601],
    ['HEVC fully tagged BT.601 HD (colr) → BT.601', f.hevcHdF601, BT601]
  ]
  for (const [name, file, want] of cases) {
    const { entry, height } = entryOf(file)
    const got = previewColour(entry, height)
    check(name, same(got, want), `got ${show(got)}, want ${show(want)}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
