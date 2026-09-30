// The export's loudness target (G9): off / −14 / −16 / −23 LUFS. The mix is
// measured, a linear gain moves it to the target, and the master limiter holds
// the true peak under −1 dBTP. The exported FILE is then metered here with an
// independent meter — ffmpeg's ebur128 filter, not the loudnorm pass the
// exporter measures with — for WAV (pcm_s24le), M4A (AAC) and MP3.
//
// The bug this guards: an upload the platform turns down (too quiet / too loud)
// or one that clips on the way through its transcoder.
// Cost: uploads that the platform turns down, or that clip.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-loudness-target.mjs
import { mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync, spawnSync } from 'child_process'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const bundle = (entry) => import('data:text/javascript;base64,' + Buffer.from(buildSync({
  entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false,
  alias: { '@shared': join(root, 'shared') }
}).outputFiles[0].text).toString('base64'))
const { ExportMuxer, FFMPEG } = await bundle('electron/ffmpeg.ts')

/** the independent meter: ebur128's summary (integrated LUFS, true peak dBTP) */
function ebur128(file) {
  const r = spawnSync(FFMPEG, ['-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 26 })
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'))
  const i = parseFloat(s.match(/I:\s*(-?[\d.]+|-inf)\s*LUFS/)?.[1])
  const tp = parseFloat(s.match(/True peak:\s*Peak:\s*(-?[\d.]+|-inf)/)?.[1])
  return { i, tp }
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-loud-'))
const ff = (...a) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...a])
try {
  // three kinds of mix: a quiet steady bed, a dense loud one (needs a cut), and
  // a sparse peaky one — clicks over a quiet bed, where a plain gain to −14
  // would put the clicks far over full scale and the limiter has to take them
  const quiet = join(dir, 'quiet.wav'), loud = join(dir, 'loud.wav'), clicks = join(dir, 'clicks.wav'), bed = join(dir, 'bed.wav')
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:r=48000:a=0.02', '-ac', '2', quiet)
  ff('-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*55*t)*(0.6+0.4*sin(2*PI*2*t))+0.3*sin(2*PI*440*t)':s=48000:d=20", '-ac', '2', loud)
  ff('-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.004),0.95*sin(2*PI*2000*t),0)':s=48000:d=20", '-ac', '2', clicks)
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:r=48000:a=0.01', '-ac', '2', bed)
  // a quiet, peaky music-like mix: decaying 60 Hz kicks twice a second over a
  // hat and a pad, peaks near full scale, ~−24 LUFS — −14 needs the limiter
  const kicks = join(dir, 'kicks.wav')
  ff('-f', 'lavfi', '-i',
    "aevalsrc='0.95*sin(2*PI*60*t)*exp(-mod(t,0.5)/0.07)+0.05*sin(2*PI*220*t)+0.04*(random(0)-0.5)*exp(-mod(t+0.25,0.5)/0.02)':s=48000:d=20",
    '-ac', '2', kicks)
  const seg = (path, start = 0, duration = 20) => ({ path, inPoint: 0, duration, start, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 })

  const AUDIO = {
    wav: { container: 'wav', audioCodec: 'pcm_s24le', audioBitrate: '2304k' },
    m4a: { container: 'm4a', audioCodec: 'aac', audioBitrate: '256k' },
    mp3: { container: 'mp3', audioCodec: 'libmp3lame', audioBitrate: '320k' }
  }
  const run = async (name, fmt, segs, loudness) => {
    const out = join(dir, `${name}.${AUDIO[fmt].container}`)
    const preset = {
      id: fmt, name: fmt, codec: '', ffmpegVideo: 'copy', width: 0, height: 0, fps: 0, videoBitrate: 0,
      audioOnly: true, ...AUDIO[fmt], ...(loudness !== undefined && { loudness })
    }
    const reported = await new ExportMuxer().run(
      { projectName: name, preset, outputPath: out, width: 0, height: 0, fps: 0, duration: 20, audioSegments: segs },
      '', () => {})
    return { out, reported, m: ebur128(out) }
  }

  const cases = [
    ['quiet', [seg(quiet)]],
    ['loud', [seg(loud)]],
    ['kicks', [seg(kicks)]],
    // sparse full-scale clicks over near-silence: no gain gets this to −14
    // without squashing it flat — the ceiling still holds, and the report says
    // how loud it came out instead of pretending
    ['clicks', [seg(clicks), seg(bed)], true]
  ]
  for (const [name, segs, unreachable] of cases) {
    for (const fmt of ['wav', 'm4a', 'mp3']) {
      for (const target of [-14, -16, -23]) {
        if (target !== -14 && fmt !== 'wav') continue
        const { reported, m } = await run(`${name}-${target}`, fmt, segs, target)
        const hit = Math.abs(m.i - target) <= 0.5
        check(`the exported mix hits the target within 0.5 LU and never exceeds the ceiling (${name}, ${fmt}, ${target} LUFS)`,
          (hit || (unreachable && target > -20 && m.i < target)) && m.tp <= -1,
          `ebur128 I ${m.i} LUFS, TP ${m.tp} dBTP${unreachable && !hit ? ' (unreachable: reported short)' : ''}`)
        check(`the done message reports what the file measures (${name}, ${fmt}, ${target})`,
          !!reported && Math.abs(reported.i - m.i) <= 0.3 && Math.abs(reported.tp - m.tp) <= 0.3,
          JSON.stringify(reported))
      }
    }
  }

  // off: no target, no report, and the plain master chain as before (quiet stays quiet)
  const off = await run('quiet-off', 'wav', [seg(quiet)])
  check('no target: nothing measured, the mix keeps its own loudness', off.reported == null && off.m.i < -30,
    `I ${off.m.i} LUFS, reported ${JSON.stringify(off.reported)}`)
  // a silent mix has no loudness to move: exported as is, not failed
  const silentWav = join(dir, 'silent.wav')
  ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '20', silentWav)
  let silent = null
  try { silent = await run('silent', 'wav', [seg(silentWav)], -14) } catch (e) { console.log(e) }
  check('a silent mix exports without an error and reports nothing', !!silent && silent.reported === null, JSON.stringify(silent?.reported))

  // the codec moves what the chain measured, and the muxer re-encodes to put it
  // back: single-sample impulses decode through AAC 128k over the ceiling
  // (−0.9 dBTP without the re-encode), and AAC 128k takes 1.6 LU out of white
  // noise by cutting the top octave (−15.6 LUFS without it)
  AUDIO.m4a128 = { container: 'm4a', audioCodec: 'aac', audioBitrate: '128k' }
  const imp = join(dir, 'imp.wav'), white = join(dir, 'white.wav')
  ff('-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t*48000,97),1),0.95,0)':s=48000:d=20", '-ac', '2', imp)
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=20:c=white:r=48000:a=0.9', '-ac', '2', white)
  const h = await run('imp', 'm4a128', [seg(imp)], -14)
  check('a lossy decode over the ceiling is re-encoded under it (impulses, AAC 128k)', h.m.tp <= -1,
    `ebur128 I ${h.m.i} LUFS, TP ${h.m.tp} dBTP`)
  const w = await run('white', 'm4a128', [seg(white)], -14)
  check('loudness the codec takes away is given back (white noise, AAC 128k)', Math.abs(w.m.i + 14) <= 0.5 && w.m.tp <= -1,
    `ebur128 I ${w.m.i} LUFS, TP ${w.m.tp} dBTP`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall green')
process.exit(fails ? 1 : 0)
