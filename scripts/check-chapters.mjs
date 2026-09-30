// The export's extras (G7): an SRT/VTT sidecar from a transcript, an embedded
// mov_text track, chapters from markers written through an ffmetadata input, a
// YouTube chapter list, and the title. Pure maths plus a real ExportMuxer run.
//
// The bug this guards: a range export starts at the range, so every subtitle
// and chapter time has to move by the range start and be cut to its length —
// a sidecar still in project time plays offset from the speech.
// Cost: subtitles offset from speech, chapters pointing at the wrong place.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-chapters.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
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
const X = await bundle('shared/exportExtras.ts')
const { ExportMuxer, FFMPEG } = await bundle('electron/ffmpeg.ts')
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m, e) => 'ffprobe' + (e ?? ''))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- pure: cues into the range --------------------------------------------
const cues = [
  { start: 0.5, end: 1.5, text: 'before' },
  { start: 4, end: 6, text: 'across the start' },
  { start: 7, end: 8, text: 'inside' },
  { start: 9, end: 11, text: 'across the end' },
  { start: 12, end: 13, text: 'after' }
]
const inR = X.cuesInRange(cues, 5, 10)
check('chapters and SRT cues are shifted into the export range and clipped to it (cues)',
  same(inR, [{ start: 0, end: 1, text: 'across the start' }, { start: 2, end: 3, text: 'inside' },
    { start: 4, end: 5, text: 'across the end' }]), JSON.stringify(inR))
check('a whole-project span leaves the cues alone', same(X.cuesInRange(cues, 0, 20), cues))
check('a cue touching the range edge only is dropped', X.cuesInRange([{ start: 3, end: 5, text: 'x' }], 5, 10).length === 0)

// ---- pure: chapters into the range ----------------------------------------
const marks = [{ time: 0, title: 'Intro' }, { time: 3, title: 'A' }, { time: 7, title: 'B' }, { time: 20, title: 'C' }]
const ch = X.chaptersInRange(marks, 5, 15, 'Начало')
check('chapters and SRT cues are shifted into the export range and clipped to it (chapters)',
  same(ch, [{ start: 0, end: 2, title: 'A' }, { start: 2, end: 10, title: 'B' }]), JSON.stringify(ch))
check('no marker before the range: the first chapter is the lead title at 0',
  same(X.chaptersInRange([{ time: 8, title: 'B' }], 5, 15, 'Начало'),
    [{ start: 0, end: 3, title: 'Начало' }, { start: 3, end: 10, title: 'B' }]))
check('a marker exactly at the range start opens it, no duplicate',
  same(X.chaptersInRange([{ time: 5, title: 'A' }, { time: 9, title: 'B' }], 5, 15, 'x'),
    [{ start: 0, end: 4, title: 'A' }, { start: 4, end: 10, title: 'B' }]))
check('no markers: no chapters', X.chaptersInRange([], 0, 10, 'x').length === 0)
check('unsorted markers are sorted',
  same(X.chaptersInRange([{ time: 6, title: 'b' }, { time: 2, title: 'a' }], 0, 10, 'x').map((c) => c.title), ['x', 'a', 'b']))

// ---- pure: which markers, and their titles --------------------------------
const pm = [
  { id: '1', time: 4, label: '1' }, { id: '2', time: 1, label: '' },
  { id: '3', time: 2, label: '', kind: 'beat' }, { id: '4', time: 3, label: '', kind: 'section', section: 'chorus' }
]
check('«markers» takes the user\'s own, sorted, an empty label numbered',
  same(X.chapterMarks(pm, 'markers'), [{ time: 1, title: '1' }, { time: 4, title: '1' }]), JSON.stringify(X.chapterMarks(pm, 'markers')))
check('«sections» takes the song parts', same(X.chapterMarks(pm, 'sections'), [{ time: 3, title: 'chorus' }]))

// ---- pure: text formats ---------------------------------------------------
check('SRT', X.cuesToSrt(inR.slice(0, 1)) === '1\n00:00:00,000 --> 00:00:01,000\nacross the start\n')
check('VTT', X.cuesToVtt(inR.slice(0, 1)) === 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nacross the start\n')
const meta = X.ffmetadata({ title: 'A=b;c', chapters: [{ start: 0, end: 2.5, title: 'x#y' }] })
check('ffmetadata: ms timebase, escaped =;#', meta ===
  ';FFMETADATA1\ntitle=A\\=b\\;c\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2500\ntitle=x\\#y\n', JSON.stringify(meta))
const yt = [{ start: 0, end: 62, title: 'Intro' }, { start: 62, end: 3723, title: 'Main' }, { start: 3723, end: 3730, title: 'End' }]
check('YouTube list: m:ss, h:mm:ss past an hour', X.youtubeChapters(yt) === '00:00 Intro\n01:02 Main\n1:02:03 End',
  JSON.stringify(X.youtubeChapters(yt)))
check('YouTube: a chapter under 10 s is reported', same(X.youtubeProblems(yt), ['short']))
check('YouTube: fewer than 3 chapters is reported', same(X.youtubeProblems(yt.slice(0, 2)), ['count']))
check('YouTube: a good list has no problems',
  X.youtubeProblems([{ start: 0, end: 10, title: 'a' }, { start: 10, end: 20, title: 'b' }, { start: 20, end: 30, title: 'c' }]).length === 0)

// ---- ffmpeg: the muxer writes them ----------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'kadr-chap-'))
try {
  const video = join(dir, 'v.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
  const tone = join(dir, 't.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-ac', '2', tone])
  const seg = { path: tone, inPoint: 0, duration: 10, start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 }
  const preset = { id: 'yt', name: 'yt', container: 'mp4', codec: 'avc', ffmpegVideo: 'copy', width: 160, height: 90,
    fps: 10, videoBitrate: 1e6, audioCodec: 'aac', audioBitrate: '128k' }
  const extras = { title: 'Мой ролик', chapters: ch, cues: inR, sidecar: 'srt', embedSubs: true }
  const out = join(dir, 'out.mp4')
  await new ExportMuxer().run({ projectName: 'p', preset, outputPath: out, width: 160, height: 90, fps: 10, duration: 10,
    audioSegments: [seg], extras }, video, () => {})
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_chapters', '-show_streams', '-show_format',
    '-of', 'json', out], { encoding: 'utf8' }))
  const chs = probe.chapters.map((c) => [+(+c.start_time).toFixed(3), +(+c.end_time).toFixed(3), c.tags?.title])
  check('the mp4 has the chapters (ffprobe -show_chapters)', same(chs, [[0, 2, 'A'], [2, 10, 'B']]), JSON.stringify(chs))
  check('the title is in the metadata', probe.format.tags?.title === 'Мой ролик', probe.format.tags?.title)
  const sub = probe.streams.find((s) => s.codec_type === 'subtitle')
  check('the subtitles are embedded as mov_text', sub?.codec_name === 'mov_text', sub?.codec_name)
  check('video and audio still there', probe.streams.some((s) => s.codec_type === 'video') &&
    probe.streams.some((s) => s.codec_type === 'audio'))
  const side = join(dir, 'out.srt')
  check('name.srt is written next to the video, in range time', existsSync(side) &&
    readFileSync(side, 'utf8') === X.cuesToSrt(inR))
  // the embedded track plays at the same times
  const embedded = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-map', '0:s', '-f', 'srt', '-'], { encoding: 'utf8' })
  check('the embedded track has the range-time cues', embedded.includes('00:00:02,000 --> 00:00:03,000') &&
    embedded.includes('inside'), JSON.stringify(embedded.slice(0, 120)))

  // a plain export: nothing extra appears
  const plain = join(dir, 'plain.mp4')
  await new ExportMuxer().run({ projectName: 'p', preset, outputPath: plain, width: 160, height: 90, fps: 10, duration: 10,
    audioSegments: [seg] }, video, () => {})
  const pp = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_chapters', '-show_streams', '-of', 'json', plain], { encoding: 'utf8' }))
  check('without extras: no chapters, no subtitle stream, no sidecar', pp.chapters.length === 0 &&
    !pp.streams.some((s) => s.codec_type === 'subtitle') && !existsSync(join(dir, 'plain.srt')))

  // audio-only MP3 carries chapters (ID3 CHAP) and a VTT sidecar
  const mp3 = join(dir, 'a.mp3')
  await new ExportMuxer().run({ projectName: 'p', outputPath: mp3, width: 0, height: 0, fps: 0, duration: 10,
    preset: { ...preset, container: 'mp3', ffmpegVideo: '', audioCodec: 'libmp3lame', audioBitrate: '128k', audioOnly: true },
    audioSegments: [seg], extras: { title: 'T', chapters: ch, cues: inR, sidecar: 'vtt' } }, '', () => {})
  const ap = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', mp3], { encoding: 'utf8' }))
  check('mp3 carries the chapters and the title', ap.chapters.length === 2 && ap.format.tags?.title === 'T',
    `${ap.chapters.length} / ${ap.format.tags?.title}`)
  check('name.vtt next to the mp3', readFileSync(join(dir, 'a.vtt'), 'utf8') === X.cuesToVtt(inR))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
