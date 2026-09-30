// Node-side check that every edit the store makes lands on a frame boundary
// (card E1): split, trim, move, insert, paste, setClipStarts, speed and
// duration changes, range edges, marker add and move — at 24, 25, 29.97, 30
// and 60 fps. 29.97 is the NTSC rational 30000/1001, so its frames sit at
// k·1001/30000, not at k/29.97.
//
// Cost of getting it wrong: a cut between two frames — the preview shows one
// frame there and the export (which rounds per frame) another.
// Also: loading a project never requantises it (no silent edits).
// The store is bundled with esbuild the same way check-project-settings-undo
// does it. Run: node scripts/check-frame-quant.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  entryPoints: [join(root, 'src', 'state', 'store.ts')],
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const { useEditor, newProject } = await import(
  'data:text/javascript;base64,' + Buffer.from(out).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const rate = (fps) => (Number.isInteger(fps) ? fps : 30000 / 1001)
const onFrame = (t, fps) => Math.abs(t * rate(fps) - Math.round(t * rate(fps))) < 1e-6
const clipOf = (id) => s().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const allClips = () => s().project.tracks.flatMap((t) => t.clips)

const ASSET = { id: 'a1', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 20.3337, hasAudio: false, width: 1920, height: 1080 }
const mk = (id, start, duration, extra = {}) =>
  ({ id, kind: 'media', assetId: 'a1', start, duration, inPoint: 0, label: id, speed: 1, ...extra })

// the fixture's own edges sit on frames of the rate under test (1 s is not a
// frame at 29.97), so only what an edit wrote can fail the check
const F = (t, fps) => Math.round(t * rate(fps)) / rate(fps)
function fresh(fps, clips = [mk('c1', F(1, fps), F(4, fps)), mk('c2', F(6, fps), F(3, fps))]) {
  const p = newProject()
  p.fps = fps
  p.assets = [{ ...ASSET }]
  const v = p.tracks.find((t) => t.kind === 'video')
  v.clips = clips.map((c) => ({ ...c }))
  s().setProject(p)
  s().select([])
  s().setRange(null)
  return v.id
}

/** every clip edge and marker in the project, as [label, time] */
function times() {
  const out = []
  for (const c of allClips()) out.push([`${c.id}.start`, c.start], [`${c.id}.end`, c.start + c.duration])
  for (const m of s().project.markers ?? []) out.push([`marker ${m.label}`, m.time])
  const r = s().range
  if (r) out.push(['range.start', r.start], ['range.end', r.end])
  return out
}

// ---- every edit action, every rate --------------------------------------------
const bad = []
for (const fps of [24, 25, 29.97, 30, 60]) {
  const note = (action) => {
    for (const [what, t] of times()) if (!onFrame(t, fps)) bad.push(`${fps} fps ${action}: ${what} = ${t}`)
  }
  let vid = fresh(fps)
  s().setPlayhead(2.2345); s().splitAtPlayhead(); note('split')

  vid = fresh(fps)
  s().trimClip('c1', 'in', 1.4321); note('trim in')
  s().trimClip('c1', 'out', 4.1177); note('trim out')
  vid = fresh(fps, [mk('c1', F(2, fps), F(3, fps), { inPoint: 0.5111 })])
  s().trimClip('c1', 'in', 0); note('trim in past the source start')
  check(`${fps} fps: a trim in never reveals media before the source start`, clipOf('c1').inPoint >= 0,
    `inPoint ${clipOf('c1').inPoint}`)

  vid = fresh(fps)
  s().moveClip('c2', vid, 7.3217); note('moveClip')
  s().setClipStarts([{ id: 'c1', start: 0.5111 }, { id: 'c2', start: 9.0071 }]); note('setClipStarts')

  vid = fresh(fps, [])
  s().insertClipsFromAssets(['a1', 'a1'], vid, 1.7777); note('insert assets')
  s().insertTextClip(0.3333); note('insert text')

  vid = fresh(fps)
  s().select(['c1']); s().copySelection(); s().setPlayhead(11.1111); s().pasteAtPlayhead(); note('paste')

  vid = fresh(fps)
  s().setClipSpeeds([{ id: 'c1', speed: 1.37, duration: 4 / 1.37 }]); note('setClipSpeeds')
  check(`${fps} fps: speed is kept exactly (the end is quantised, not the speed)`, clipOf('c1').speed === 1.37)
  s().setClipSpeeds([{ id: 'c2', speed: 0.73, duration: 3 / 0.73, start: 9 - 3 / 0.73 }]); note('setClipSpeeds with start')
  s().setClipDuration('c1', 2.2222); note('setClipDuration')

  vid = fresh(fps)
  s().setRange({ start: 1.5555, end: 7.1234 }); note('setRange')
  s().copyRange(); s().deleteRange(); note('deleteRange')

  vid = fresh(fps)
  const m = s().addMarker(3.3333); note('addMarker')
  s().moveMarker(m, 5.4321); note('moveMarker')
}
check('every edit action returns frame-aligned times at 24, 25, 29.97, 30 and 60 fps',
  bad.length === 0, bad.slice(0, 6).join('; ') + (bad.length > 6 ? ` … (${bad.length})` : ''))

// the card's own numbers
fresh(30); s().setPlayhead(1.2345); s().splitAtPlayhead()
check('at 30 fps a split at 1.2345 s cuts at 37/30', Math.abs(clipOf('c1').start + clipOf('c1').duration - 37 / 30) < 1e-9,
  `cut at ${clipOf('c1').start + clipOf('c1').duration}`)
fresh(29.97); s().setPlayhead(2.2345); s().splitAtPlayhead()
{
  const cut = clipOf('c1').start + clipOf('c1').duration
  const k = Math.round(cut * 30000 / 1001)
  check('at 29.97 the cut is at k·1001/30000', Math.abs(cut - k * 1001 / 30000) < 1e-9, `cut ${cut}, k ${k}`)
}

// ---- no silent edits on load -----------------------------------------------
fresh(30, [mk('c1', 1.2345, 2.1111), mk('c2', 5.0001, 1.3333)])
const before = JSON.stringify(allClips().map((c) => [c.start, c.duration, c.inPoint]))
check('loading does not move existing clips', before === JSON.stringify([[1.2345, 2.1111, 0], [5.0001, 1.3333, 0]]), before)
s().addMarker(1)
check('an unrelated edit does not requantise old clips either',
  JSON.stringify(allClips().map((c) => [c.start, c.duration, c.inPoint])) === before)

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
