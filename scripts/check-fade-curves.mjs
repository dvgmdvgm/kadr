// K2: fade curves. One table (shared/fadeCurves.ts) drives the preview's gain
// and names afade's curve in the export, so each curve is run through ffmpeg
// and compared with the table; then the point of it all — an equal-power
// crossfade of two uncorrelated noise clips holds its loudness through the
// overlap, in the preview's gain maths and in an exported mixdown, where a
// linear one dips ~3 dB. A clip with no stored curve stays linear (old
// projects must not change sound); a new clip carries the default curve.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-fade-curves.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { fadeGain, FADE_CURVES } = await load(`export { fadeGain, FADE_CURVES } from './shared/fadeCurves'`)
const { fadeFactor, overlapFades } = await load(`export { fadeFactor, overlapFades } from './src/engine/player'`)
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
const { newClipDefaults } = await load(`export { newClipDefaults } from './src/state/store'`)
const { mixdownWav, FFMPEG } = await load(`export { mixdownWav, FFMPEG } from './electron/ffmpeg'`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9))
const pcmOf = (file) => {
  const buf = readFileSync(file)
  const at = buf.indexOf('data') + 8
  return new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
}
const rms = (pcm, a, b) => {
  let s = 0, n = 0
  for (let i = Math.round(a * 48000) * 2; i < Math.round(b * 48000) * 2 && i < pcm.length; i++, n++) s += (pcm[i] / 32768) ** 2
  return Math.sqrt(s / Math.max(1, n))
}

// ---- new clips carry the default curve; a clip without one is linear
{
  const d = newClipDefaults()
  check('a new clip carries the equal-power curve by default', d.fadeInCurve === 'qsin' && d.fadeOutCurve === 'qsin', JSON.stringify([d.fadeInCurve, d.fadeOutCurve]))
  const old = { id: 'o', start: 0, duration: 4, fadeIn: 2, fadeOut: 0 }
  check('a clip with no stored curve fades linearly (old projects sound the same)',
    Math.abs(fadeFactor(old, 0.5, overlapFades({ clips: [old] }, old)) - 0.25) < 1e-12)
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-fadecurves-'))
try {
  // ---- each curve matches ffmpeg afade's curve within 0.1 dB
  const dc = join(dir, 'dc.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.5|0.5:d=3:s=48000', '-c:a', 'pcm_f32le', dc])
  const FADE = 2
  for (const curve of FADE_CURVES) {
    for (const side of ['in', 'out']) {
      const out = join(dir, `${curve}-${side}.wav`)
      const seg = { path: dc, inPoint: 0, duration: FADE, start: 0, gain: 1, speed: 1, fadeIn: side === 'in' ? FADE : 0, fadeOut: side === 'out' ? FADE : 0,
        ...(side === 'in' ? { fadeInCurve: curve } : { fadeOutCurve: curve }) }
      await mixdownWav([seg], FADE, out)
      const pcm = pcmOf(out)
      let worst = 0, where = 0
      for (let k = 1; k < 200; k++) {
        const x = k / 200 // fraction of the fade elapsed
        const i = Math.round(x * FADE * 48000)
        const want = 0.5 * fadeGain(curve, side === 'in' ? x : 1 - x)
        const got = Math.abs(pcm[i * 2] / 32768)
        // in dB where the level is resolvable in 16 bits (≥ −30 dB), absolutely below
        const err = want >= 0.5 * 0.0316 ? Math.abs(db(got) - db(want)) : Math.abs(got - want) <= 1e-3 ? 0 : 99
        if (err > worst) { worst = err; where = x }
      }
      check(`each curve matches ffmpeg afade's curve within 0.1 dB — ${curve} fade-${side}`, worst <= 0.1, `worst ${worst.toFixed(3)} dB at ${(where * 100).toFixed(1)} %`)
    }
  }

  // ---- an equal-power crossfade of two noise clips holds RMS through the overlap
  const na = join(dir, 'a.wav'), nb = join(dir, 'b.wav')
  for (const [f, seed] of [[na, 3], [nb, 11]]) {
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=6:c=white:a=0.2:seed=${seed}`, '-ac', '2', '-ar', '48000', f])
  }
  const assets = [{ id: 'A', kind: 'audio', path: na, duration: 6, hasAudio: true }, { id: 'B', kind: 'audio', path: nb, duration: 6, hasAudio: true }]
  // A 0…4 s, B 2…6 s: a 2 s overlap, crossfaded automatically
  const project = (extra) => {
    const a = { id: 'a', kind: 'media', assetId: 'A', start: 0, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, ...extra }
    const b = { id: 'b', kind: 'media', assetId: 'B', start: 2, duration: 4, inPoint: 0, speed: 1, gain: { value: 1 }, ...extra }
    return { assets, tracks: [{ id: 't', kind: 'audio', gain: 1, clips: [a, b] }] }
  }
  const curves = { fadeInCurve: newClipDefaults().fadeInCurve, fadeOutCurve: newClipDefaults().fadeOutCurve }
  // the preview: both elements' gains, summed as power (uncorrelated sources)
  const previewDip = (p) => {
    const [tr] = p.tracks, [a, b] = tr.clips
    let worst = 0
    for (let t = 2; t <= 4; t += 0.01) {
      const ga = fadeFactor(a, t - a.start, overlapFades(tr, a)), gb = fadeFactor(b, t - b.start, overlapFades(tr, b))
      worst = Math.max(worst, Math.abs(10 * Math.log10(ga * ga + gb * gb)))
    }
    return worst
  }
  const pEq = previewDip(project(curves)), pLin = previewDip(project({}))
  check('an equal-power crossfade holds RMS within 0.5 dB through the overlap — preview', pEq <= 0.5, `worst ${pEq.toFixed(3)} dB (linear: ${pLin.toFixed(2)} dB)`)
  // the export
  const exportDip = async (p, name) => {
    const out = join(dir, name)
    await mixdownWav(collectRangeAudio(p, 0, 6), 6, out)
    const pcm = pcmOf(out)
    const ref = db(rms(pcm, 0.5, 1.5))
    let worst = 0
    for (let t = 2; t < 4; t += 0.05) worst = Math.max(worst, Math.abs(db(rms(pcm, t, t + 0.05)) - ref))
    return worst
  }
  const eEq = await exportDip(project(curves), 'xeq.wav'), eLin = await exportDip(project({}), 'xlin.wav')
  check('an equal-power crossfade holds RMS within 0.5 dB through the overlap — export', eEq <= 0.5, `worst ${eEq.toFixed(2)} dB`)
  check('…where a linear one dips about 3 dB (the cost this card removes)', eLin >= 2.5, `worst ${eLin.toFixed(2)} dB`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
