// Node-side check of shared/rawEncode.ts — the x264 rate control. No app.
//
// The bug this guards: every export was forced to ABR (G3). A CRF job that
// still carries -b:v is capped by it, and an ABR job whose args drift changes
// the bytes of every built-in preset. Cost: a silently wrong quality.
// Run: node scripts/check-rate-control.mjs
import { readFileSync } from 'fs'
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
const { rawEncodeArgs } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

const base = { width: 1920, height: 1080, fps: 30, codec: 'libx264', bitrate: 10_000_000, out: 'o.mp4' }
const after = (a, flag) => a[a.indexOf(flag) + 1]
const x264 = (a) => a.slice(a.indexOf('-c:v'), a.indexOf('-pix_fmt', a.indexOf('-c:v'))).join(' ')

// the exact ABR args of every export before G3 — built-in presets stay byte-for-byte
const abrExact = '-c:v libx264 -preset faster -b:v 10000000 -maxrate 16000000 -bufsize 30000000'
check('abr (no rate control given) is the exact old args', x264(rawEncodeArgs(base)) === abrExact, x264(rawEncodeArgs(base)))
check('abr given explicitly is the exact old args',
  x264(rawEncodeArgs({ ...base, rateControl: 'abr', crf: 23 })) === abrExact)

const crf = rawEncodeArgs({ ...base, rateControl: 'crf', crf: 18 })
check('crf emits -crf 18', after(crf, '-crf') === '18', x264(crf))
check('crf emits no -b:v / -maxrate / -bufsize',
  !crf.includes('-b:v') && !crf.includes('-maxrate') && !crf.includes('-bufsize'))
check('crf without a value defaults to 18', after(rawEncodeArgs({ ...base, rateControl: 'crf' }), '-crf') === '18')
check('crf is clamped to x264\'s 0–51', after(rawEncodeArgs({ ...base, rateControl: 'crf', crf: 90 }), '-crf') === '51')

check('x264 preset choice reaches -preset',
  after(rawEncodeArgs({ ...base, rateControl: 'crf', x264Preset: 'slow' }), '-preset') === 'slow')
check('an unknown x264 preset falls back to faster',
  after(rawEncodeArgs({ ...base, x264Preset: 'bogus; rm' }), '-preset') === 'faster')

// VP9 (G6): constant quality on libvpx's own 0–63 scale needs -b:v 0; ABR stays as it was
const vp9 = rawEncodeArgs({ ...base, codec: 'libvpx-vp9', rateControl: 'crf', crf: 40 })
check('vp9 in the quality mode is -crf N -b:v 0', after(vp9, '-crf') === '40' && after(vp9, '-b:v') === '0', x264(vp9))
check('vp9 ABR keeps its plain -b:v',
  after(rawEncodeArgs({ ...base, codec: 'libvpx-vp9' }), '-b:v') === '10000000')

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
