// J10: the same frame of an ffmpeg-made intermediate decodes to the same
// pixels on every request — the exporter's fast decode (src/engine/demux.ts)
// feeds the decoder every sample ONCE, in decode order, however the file's
// bytes and the decoder's config check interleave.
//
// The bug it pins (found by H8, measured by J10): two exports of one project
// differed now and then on a few frames of a reversed render and of a frame-run
// intermediate. `init()` demuxes the head while `isConfigSupported` is pending,
// then `jump(0)` seeks mp4box back to sample 0 and re-pumps the file. When the
// head pump had already appended the whole (small) file, mp4box re-extracted
// the samples it still held right at the seek AND again from the re-pump: the
// decoder got I0…P20 and then I0 again before B18 B17 B19. The IDR flushed P20
// out ahead of its B-frames, so frames 17–19 were exported as frame 20 — only
// in runs where the config check was slow enough. Whether it happened was a
// race; what happened when it did was not.
//
// Runs the REAL Mp4FrameSource under node: mp4box as shipped, the file served
// through a fake fetch in chunks, and a fake H.264 decoder that reorders like
// the real one (an IDR bumps every held frame; B-frames wait for their P).
// Needs ffmpeg, no app.  Run: node scripts/check-decode-determinism.mjs
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { build } from 'esbuild'
import { createFile } from 'mp4box'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'kadr-decode-det-'))
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// ── the environment Mp4FrameSource expects ──
let serve = { chunk: 1 << 20, gate: () => Promise.resolve() }
const tick = () => new Promise((r) => setImmediate(r))
globalThis.window = { kadr: { fileUrl: (p) => p } }
globalThis.fetch = async (url, opts = {}) => {
  const bytes = readFileSync(url)
  const m = /bytes=(\d+)-/.exec(opts.headers?.Range ?? '')
  const start = m ? Number(m[1]) : 0
  const body = bytes.subarray(start)
  let at = 0
  const stream = new ReadableStream({
    async pull(ctl) {
      await tick()
      if (opts.signal?.aborted) { ctl.close(); return }
      if (at >= body.length) { ctl.close(); return }
      ctl.enqueue(new Uint8Array(body.subarray(at, at + serve.chunk)))
      at += serve.chunk
    }
  })
  const headers = new Headers({ 'content-length': String(body.length) })
  if (m) headers.set('content-range', `bytes ${start}-${bytes.length - 1}/${bytes.length}`)
  return new Response(stream, { status: m ? 206 : 200, headers })
}
globalThis.EncodedVideoChunk = class { constructor(i) { Object.assign(this, i); this.byteLength = i.data.byteLength } }
let fed = []
globalThis.VideoDecoder = class {
  static async isConfigSupported() { await serve.gate(); return { supported: true } }
  constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.held = [] }
  configure() { this.state = 'configured'; this.needKey = true; fed.push('new') }
  emit(n) {
    this.held.sort((a, b) => a - b)
    for (const ts of this.held.splice(0, n)) {
      const out = this.output
      queueMicrotask(() => this.state !== 'closed' && out({ timestamp: ts, duration: 33333, close() {}, colorSpace: null, format: null }))
    }
  }
  decode(c) {
    if (this.state !== 'configured') throw new Error('decode on a ' + this.state + ' decoder')
    // as Chromium does: the first chunk after configure() must be a key frame
    if (this.needKey && c.type !== 'key') throw new Error('DataError: A key frame is required after configure()')
    this.needKey = false
    fed.push(c.timestamp)
    if (c.type === 'key') this.emit(this.held.length) // an IDR bumps the whole DPB
    this.held.push(c.timestamp)
    if (this.held.length > 3) this.emit(1)
  }
  flush() { this.emit(this.held.length); return new Promise((r) => setTimeout(r, 0)) }
  close() { this.state = 'closed' }
}

// ── the module under test, bundled as the renderer would ──
const out = join(dir, 'demux.mjs')
await build({
  entryPoints: [join(root, 'src/engine/demux.ts')], bundle: true, format: 'esm', platform: 'neutral',
  alias: { '@shared': join(root, 'shared') }, outfile: out, logLevel: 'error', mainFields: ['module', 'main']
})
const { Mp4FrameSource } = await import(pathToFileURL(out).href)

// ── media: B-frames (x264 default), like every intermediate the app makes ──
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
const files = {
  'frame run (crf 14, fast, faststart)': ['-preset', 'fast', '-crf', '14', '-movflags', '+faststart'],
  'reversed render (crf 17, fast, faststart)': ['-preset', 'fast', '-crf', '17', '-movflags', '+faststart'],
  'plain x264, moov at the end': [],
  // J13: short GOPs over 90 frames — mp4box holds a part-filled batch (it
  // hands out 30 at a time) when the pump is mid-file, and after jump(0) that
  // batch came out AHEAD of the key frame the jump asked for: from a delta
  // (g 12: sample 30 is one) the decoder threw «a key frame is required»; from
  // a key (g 10) frames 0–29 were silently skipped and exported as frame 30
  'short GOPs (g 12, 90 frames, faststart)': ['-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-movflags', '+faststart', '-frames:v', '90'],
  'short GOPs (g 10, 90 frames, faststart)': ['-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-movflags', '+faststart', '-frames:v', '90']
}
const media = {}
for (const [name, x264] of Object.entries(files)) {
  const p = join(dir, Object.keys(media).length + '.mp4')
  const frames = x264.includes('-frames:v') ? [] : ['-frames:v', '30']
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=320x180:r=30', ...frames, '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', p])
  // the file's own decode order, read with mp4box directly
  const f = createFile()
  let order = []
  f.onReady = (info) => { f.setExtractionOptions(info.videoTracks[0].id, null, { nbSamples: 1000 }); f.start() }
  f.onSamples = (_i, _u, ss) => { order.push(...ss.map((s) => ({ cts: s.cts, scale: s.timescale }))) }
  const b = readFileSync(p); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); ab.fileStart = 0
  f.appendBuffer(ab); f.flush()
  media[name] = { path: p, order, size: b.length }
}

// ── every interleaving: the config check answers before, during and after the pump ──
for (const [name, m] of Object.entries(media)) {
  const bad = []
  const unopened = []
  let bframes = false
  for (const chunk of [512, 4096, 1 << 20]) {
    for (const delay of [0, 1, 3, 10, 40, 200]) {
      serve = { chunk, gate: async () => { for (let i = 0; i < delay; i++) await tick() } }
      fed = []
      const src = await Mp4FrameSource.open({ path: m.path, kind: 'video', name, id: 'x', duration: 1 })
      if (!src) { unopened.push(`chunk ${chunk} delay ${delay}`); continue }
      const got = []
      let threw = null
      for (let k = 0; k < m.order.length && !threw; k++) {
        try { got.push(Math.round((await src.frameAt((k + 0.5) / 30)).timestamp * 30 / 1e6)) } catch (e) { threw = `chunk ${chunk} delay ${delay}: frame ${k}: ${e.message}` }
      }
      src.close()
      if (threw) { unopened.push(threw); continue }
      const ts = fed.filter((x) => x !== 'new')
      const want = m.order.map((s) => Math.round(((s.cts - m.order[0].cts) * 1e6) / s.scale))
      bframes ||= want.some((x, i) => i && x < want[i - 1])
      const wrong = got.map((g, k) => g === k ? '' : `${k}→${g}`).filter(Boolean)
      if (wrong.length) bad.push(`chunk ${chunk} delay ${delay}: frames ${wrong.join(' ')}`)
      else if (ts.length !== want.length || ts.some((x, i) => x - want[i] > 1 || want[i] - x > 1)) {
        bad.push(`chunk ${chunk} delay ${delay}: the decoder was fed ${ts.length} samples for ${want.length}`)
      }
    }
  }
  check(`${name}: the stream has B-frames (decode order ≠ presentation order)`, bframes)
  check(`${name}: a jump whose held samples start on a delta still feeds a key frame first (opens and decodes in all 18 interleavings)`, unopened.length === 0, unopened.slice(0, 4).join('; '))
  check(`${name}: every sample fed once in decode order and frame k at every k, 18 interleavings`, bad.length === 0, bad.slice(0, 4).join('; '))
}

// ── J13's own risk: a jump to the last sample or past the track's end. mp4box
// leaves nextSample alone when the seek time is beyond the track, so an intake
// that waits for "the sought sample" could wait forever — or, as measured,
// throw «no frames» and send the clip to element seeks. The seek is clamped to
// the last sample, so the tail frame holds, as it does without a jump.
{
  const m = media['short GOPs (g 12, 90 frames, faststart)']
  const dur = m.order.length / 30
  const hung = []
  for (const at of [dur - 1 / 60, dur, dur + 0.5, dur + 5]) {
    for (const chunk of [512, 1 << 20]) {
      for (const delay of [0, 40]) {
        serve = { chunk, gate: async () => { for (let i = 0; i < delay; i++) await tick() } }
        const src = await Mp4FrameSource.open({ path: m.path, kind: 'video', name: 'end', id: 'x', duration: dur })
        if (!src) { hung.push(`t ${at} chunk ${chunk} delay ${delay}: did not open`); continue }
        const r = await Promise.race([
          src.frameAt(at).then((f) => (f ? Math.round(f.timestamp * 30 / 1e6) : 'null'), (e) => 'threw: ' + e.message),
          new Promise((res) => setTimeout(() => res('HUNG'), 5000))
        ])
        src.close()
        if (r !== m.order.length - 1) hung.push(`t ${at.toFixed(3)} chunk ${chunk} delay ${delay}: ${r}`)
      }
    }
  }
  check('a jump to the last sample or past the track end gives the last frame on the fast path — no hang (5 s timeout), no throw', hung.length === 0, hung.slice(0, 4).join('; '))
}

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
