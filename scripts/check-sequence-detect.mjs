// Node-side check of folder import and image sequences (card H6):
// shared/sequences.ts finds numbered frame runs, electron/mediaScan.ts walks
// dropped folders in main, electron/ffmpeg.ts makeSequence turns a run into
// one clip at a chosen fps.
//
// Cost when wrong: a hundred stills on the timeline instead of one clip — or
// the opposite, unrelated files glued into a clip that jumps between them.
// Needs ffmpeg (PATH or KADR_FFMPEG) for the last part.
// Run: node scripts/check-sequence-detect.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join, sep } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const load = async (entry) => {
  const js = buildSync({
    entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@shared': join(root, 'shared') }, logLevel: 'silent'
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
let seq = {}, scan = {}, ff = {}
try { seq = await load('shared/sequences.ts') } catch (err) { check('shared/sequences.ts loads', false, String(err).split('\n')[0]) }
try { scan = await load('electron/mediaScan.ts') } catch (err) { check('electron/mediaScan.ts loads', false, String(err).split('\n')[0]) }
try { ff = await load('electron/ffmpeg.ts') } catch (err) { check('electron/ffmpeg.ts loads', false, String(err).split('\n')[0]) }
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }
const pad = (n, w) => String(n).padStart(w, '0')

// ── the card's test ─────────────────────────────────────────────────────────
run('runs are detected by contiguous numbering and a common stem; stray files are not merged', () => {
  const d = '/m/'
  const frames = Array.from({ length: 240 }, (_, i) => `${d}name_${pad(i + 1, 4)}.png`)
  const stray = [
    `${d}name_final.png`,        // no number
    `${d}name_0500.png`,         // same stem, far from the run
    `${d}other_0001.png`, `${d}other_0002.png`, // a run too short to be one
    `${d}name_0001.jpg`,         // same stem and number, other extension
    `${d}clip1.mp4`, `${d}clip2.mp4`, `${d}clip3.mp4` // numbered videos are never frames
  ]
  const input = [...stray.slice(0, 3), ...frames.slice().reverse(), ...stray.slice(3)]
  const r = seq.detectSequences(input)
  check('one run found', r.sequences.length === 1, JSON.stringify(r.sequences.map((s) => s.name)))
  const s = r.sequences[0]
  check('the run is 1…240 of name_####.png', s && s.first === 1 && s.count === 240 && s.width === 4 &&
    s.pattern === `${d}name_%04d.png` && s.name === 'name_0001-0240.png', JSON.stringify(s && { ...s, files: s.files.length }))
  check('its frames are in numeric order', s && s.files.every((f, i) => f === frames[i]))
  check('every stray file stays on its own, in input order', JSON.stringify(r.rest) === JSON.stringify(stray), JSON.stringify(r.rest))
})

run('a gap splits a run; unpadded numbers use %d; a % in the stem is escaped', () => {
  const a = [...Array.from({ length: 10 }, (_, i) => `C:\\r\\a_${i + 1}.png`), ...Array.from({ length: 9 }, (_, i) => `C:\\r\\a_${i + 12}.png`)]
  const r = seq.detectSequences(a)
  check('two runs 1–10 and 12–20', r.sequences.length === 2 && r.sequences[0].first === 1 && r.sequences[0].count === 10 &&
    r.sequences[1].first === 12 && r.sequences[1].count === 9, JSON.stringify(r.sequences.map((s) => [s.first, s.count])))
  check('unpadded → %d, Windows separators kept', r.sequences[0]?.pattern === 'C:\\r\\a_%d.png' && r.sequences[0]?.width === 0,
    r.sequences[0]?.pattern)
  const p = seq.detectSequences(['/x/50%_001.exr', '/x/50%_002.exr', '/x/50%_003.exr'])
  check('50%_%03d.exr → 50%%_%03d.exr', p.sequences[0]?.pattern === '/x/50%%_%03d.exr', p.sequences[0]?.pattern)
  check('frameOf reads a pattern back', seq.frameOf('/x/50%%_%03d.exr', 7) === '/x/50%_007.exr' &&
    seq.frameOf('C:\\r\\a_%d.png', 12) === 'C:\\r\\a_12.png', seq.frameOf('/x/50%%_%03d.exr', 7))
  const w = seq.detectSequences(['/y/f_1.png', '/y/f_2.png', '/y/f_03.png'])
  check('mixed padding is not merged into one run', w.sequences.length === 0 && w.rest.length === 3, JSON.stringify(w))
  const two = seq.detectSequences(['/z/s_1.png', '/z/s_2.png'])
  check(`fewer than SEQ_MIN (${seq.SEQ_MIN}) frames stay stills`, two.sequences.length === 0)
  const dirs = seq.detectSequences(['/a/f_1.png', '/a/f_2.png', '/b/f_3.png', '/b/f_4.png', '/a/f_3.png'])
  check('a run never spans two folders', dirs.sequences.length === 1 && dirs.sequences[0].pattern === '/a/f_%d.png', JSON.stringify(dirs.sequences.map((s) => s.pattern)))
})

run('kinds by extension', () => {
  const k = (p) => seq.mediaKindOfPath(p)
  check('video/audio/image/frame/null', k('a.MP4') === 'video' && k('a.wav') === 'audio' && k('a.png') === 'image' &&
    k('a.exr') === 'frame' && k('a.txt') === null && k('noext') === null)
})

// ── the walk (main) ────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'kadr-h6-'))
try {
  if (scan.scanMedia) {
    const dir = join(tmp, 'shoot')
    mkdirSync(join(dir, 'render'), { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    for (const f of ['a.mp4', 'b.mov', 'render/c.mkv', 'x.wav', 'y.WAV', 'readme.txt', 'notes.doc', '.hidden/z.mp4', 'lone.exr'])
      writeFileSync(join(dir, f), '')
    for (let i = 1; i <= 240; i++) writeFileSync(join(dir, 'render', `name_${pad(i, 4)}.png`), '')
    const loose = join(tmp, 'loose.srt')
    writeFileSync(loose, '')
    const r = await scan.scanMedia([dir, loose])
    const names = r.files.map((f) => f.slice(tmp.length + 1).split(sep).join('/'))
    check('a folder expands recursively to known media; picked files pass as they are',
      JSON.stringify(names) === JSON.stringify(['shoot/a.mp4', 'shoot/b.mov', 'shoot/render/c.mkv', 'shoot/x.wav', 'shoot/y.WAV', 'loose.srt']),
      JSON.stringify(names))
    check('the 240 frames are one run', r.sequences.length === 1 && r.sequences[0].count === 240)
    check('non-media, hidden and a lone EXR are counted as skipped', r.skipped === 4 && r.folders === 1, JSON.stringify({ skipped: r.skipped, folders: r.folders }))
    const big = join(tmp, 'big')
    mkdirSync(big)
    for (let i = 0; i < 10000; i++) writeFileSync(join(big, `still_${i * 2}.jpg`), '')
    const t0 = performance.now()
    const b = await scan.scanMedia([big])
    const ms = performance.now() - t0
    check('10 000 files enumerate in main under 2 s', b.files.length === 10000 && ms < 2000, `${b.files.length} files, ${ms.toFixed(0)} ms`)
  }

  // ── the run becomes one clip ──────────────────────────────────────────────
  if (ff.makeSequence && ff.probeMedia) {
    const fr = join(tmp, 'frames')
    mkdirSync(fr)
    execFileSync(ff.FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=321x181:rate=24', '-frames:v', '240',
      '-start_number', '1', join(fr, 'name_%04d.png')])
    const out = join(tmp, 'run.mp4')
    await ff.makeSequence({ pattern: join(fr, 'name_%04d.png'), first: 1, count: 240 }, 24, out, { alpha: false })
    const { asset } = await ff.probeMedia(out)
    check('240 frames at 24 fps play as a 10 s video clip', asset.kind === 'video' && Math.abs(asset.duration - 10) < 0.05 &&
      Math.abs(asset.fps - 24) < 1e-6 && asset.codec === 'h264', JSON.stringify({ k: asset.kind, d: asset.duration, fps: asset.fps, c: asset.codec, w: asset.width, h: asset.height }))
    const n = execFileSync(ff.FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
      '-of', 'csv=p=0', out]).toString().trim()
    check('every frame is there, none doubled', n === '240', n)
    const fa = join(tmp, 'alpha')
    mkdirSync(fa)
    execFileSync(ff.FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25,format=rgba,colorchannelmixer=aa=0.5',
      '-frames:v', '12', '-start_number', '7', join(fa, 'a.%03d.png')])
    const outA = join(tmp, 'alpha.webm')
    check('a run with alpha is detected as such', (await ff.sequenceHasAlpha(join(fa, 'a.007.png'))) === true)
    await ff.makeSequence({ pattern: join(fa, 'a.%03d.png'), first: 7, count: 12 }, 25, outA, { alpha: true })
    const pa = (await ff.probeMedia(outA)).asset
    check('it keeps its alpha (VP9+alpha WebM), starting at frame 7', pa.hasAlpha === true && Math.abs(pa.duration - 12 / 25) < 0.05,
      JSON.stringify({ a: pa.hasAlpha, d: pa.duration }))
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (fails) { console.log(`\n${fails} FAIL`); process.exit(1) }
console.log('\nall passed')
