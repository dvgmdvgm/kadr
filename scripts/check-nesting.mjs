// L6: a project holds several timelines (`project.timelines`, the active one's
// tracks are `project.tracks`), and a clip of kind 'timeline' plays another
// timeline inside this one. The preview, the export frames and every audio
// mixdown see a compound clip through ONE expansion (src/engine/nesting.ts):
// its contents, cut to the clip's window, at its place in the stack. The cost
// of getting it wrong: a nested edit that exports differently from the same
// clips laid out flat, a timeline that contains itself (a hang), or an old
// project that loses clips on load.
// Run: node scripts/check-nesting.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error',
    mainFields: ['module', 'main'],
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const { useEditor, newProject, sanitizeProject, projectDuration } =
  await load(`export { useEditor, newProject, sanitizeProject, projectDuration } from './src/state/store'`)
const { videoLayersAt, clipPlacement, fadeFactor, overlapFades, clipSourceTime } = await load(`export * from './src/engine/player'`)
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
let N = {}
try { N = await load(`export * from './src/engine/nesting'; export * from './shared/timelines'`) } catch { /* red: no module yet */ }

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const A = (id, kind = 'video') => ({ id, kind, name: id, path: `/x/${id}.mp4`, duration: 30, hasAudio: true, width: 1920, height: 1080, fps: 30 })
const clip = (id, assetId, start, duration, inPoint, extra = {}) => ({
  id, kind: 'media', assetId, start, duration, inPoint, speed: 1, gain: { value: 1 }, muted: false,
  transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } },
  effects: [], ...extra
})
const track = (id, kind, clips) => ({ id, kind, name: id, muted: false, locked: false, gain: 1, clips })

check('src/engine/nesting exports flattenProject; shared/timelines exports allTracks, timelineTracks, nestsInto',
  ['flattenProject', 'allTracks', 'timelineTracks', 'nestsInto'].every((k) => typeof N[k] === 'function'))
check('the store has nestClips, addTimeline, setActiveTimeline, insertTimelineClip, removeTimeline',
  ['nestClips', 'addTimeline', 'setActiveTimeline', 'insertTimelineClip', 'removeTimeline'].every((k) => typeof s()[k] === 'function'))

/** what drawFrame draws, per layer, without a GPU: the source, its frame, where and how opaque */
const frame = (p, t) => videoLayersAt(p, t).map(({ clip: c, track: tr, asset }) => JSON.stringify({
  a: c.assetId, src: +clipSourceTime(c, asset, t - c.start).toFixed(9), at: clipPlacement(c, tr, t),
  op: tr.gain, fade: +fadeFactor(c, t - c.start, overlapFades(tr, c)).toFixed(9), fx: c.effects, blend: c.blend ?? null
})).join('\n')
const mix = (p) => JSON.stringify(collectRangeAudio(p, 0, 12).sort((x, y) => x.start - y.start || x.path.localeCompare(y.path)))

if (fails === 0) {
  const { flattenProject, allTracks, nestsInto } = N
  // ---- a flat edit: two stacked picture clips (one keyed, one fading) and a sound under them
  const flat = () => {
    const p = newProject()
    p.fps = 30
    p.assets = [A('a'), A('b'), A('m', 'audio')]
    p.tracks = [
      // an untouched title above and a background below: the nest must land between them
      track('V3', 'video', [clip('t1', 'a', 0, 8, 0, { transform: { x: { value: 300 }, y: { value: 0 }, scale: { value: 0.3 }, rotation: { value: 0 }, opacity: { value: 1 } } })]),
      track('V2', 'video', [clip('b1', 'b', 3, 3, 4, { fadeIn: 0.5, transform: {
        x: { value: 0, keyframes: [{ time: 0, value: -200, easing: 'linear' }, { time: 3, value: 200, easing: 'linear' }] },
        y: { value: 40 }, scale: { value: 0.5 }, rotation: { value: 10 }, opacity: { value: 0.8 } } })]),
      track('V1', 'video', [clip('a1', 'a', 1, 4, 2, { speed: 1.5 }), clip('a2', 'a', 5, 2, 10)]),
      track('V0', 'video', [clip('bg', 'b', 0, 8, 20)]),
      track('A1', 'audio', [clip('m1', 'm', 0.5, 6, 1, { gain: { value: 0.7 }, fadeOut: 1 })])
    ]
    return p
  }
  const ref = flat()
  const bare = { ...flat(), tracks: flat().tracks.filter((t) => t.id !== 'V3' && t.id !== 'V0') }
  s().setProject(flat())
  const depth = s().past.length
  const cid = s().nestClips(['b1', 'a1', 'a2', 'm1'])
  const nested = s().project
  const host = nested.tracks.flatMap((t) => t.clips)
  const comp = host.filter((c) => c.kind === 'timeline')
check('«make compound» leaves one clip of kind timeline over the selection', host.length === 3 && comp.length === 1 &&
    comp[0].id === cid && comp[0].start === 0.5 && comp[0].duration === 6.5, JSON.stringify(host.map((c) => [c.kind, c.start, c.duration])))
  check('…as one undo step, and the contents moved into a timeline of their own', s().past.length === depth + 1 &&
    (nested.timelines ?? []).length === 2 && allTracks(nested).flatMap((t) => t.clips).filter((c) => c.kind === 'media').length === 6)

  let worst = null
  for (let t = 0; t < 8; t += 1 / 30) {
    if (frame(flattenProject(nested), t) !== frame(ref, t)) { worst ??= t }
  }
  check('a compound clip renders identically to its contents', worst === null,
    worst === null ? '240 frames' : `t=${worst}\n${frame(flattenProject(nested), worst)}\n vs\n${frame(ref, worst)}`)
  check('…and its sound mixes to the same segments', mix(nested) === mix(ref), `${mix(nested).slice(0, 300)}\n vs\n${mix(ref).slice(0, 300)}`)
  check('a flat project expands to itself (the same object)', flattenProject(ref) === ref)
  check('the expansion is cached per project object', flattenProject(nested) === flattenProject(nested))

  // the compound's window cuts its contents: trim 1 s off the head
  const cut = structuredClone(nested)
  const cc = cut.tracks.flatMap((t) => t.clips).find((c) => c.id === cid)
  cc.start += 1; cc.inPoint += 1; cc.duration -= 1
  const early = videoLayersAt(flattenProject(cut), 1.2).length
  check('a trimmed compound shows only its window', early === 2 && frame(flattenProject(cut), 4) === frame(ref, 4), String(early))
  // the compound's own gain and mute reach its contents
  const loud = structuredClone(nested)
  loud.tracks.flatMap((t) => t.clips).find((c) => c.id === cid).gain = { value: 0.5 }
  const g = collectRangeAudio(flattenProject(loud), 0, 12).find((x) => x.path === '/x/m.mp4')
  check('the compound\'s gain scales its sound', g && Math.abs(g.gain - 0.35) < 1e-9, String(g?.gain))
  const mute = structuredClone(nested)
  mute.tracks.flatMap((t) => t.clips).find((c) => c.id === cid).muted = true
  check('a muted compound is silent and still drawn', collectRangeAudio(mute, 0, 12).every((x) => x.start === 0) && videoLayersAt(flattenProject(mute), 4).length === 4)
  // J6: the colour section, kadr_grade and the palette's colour actions take only a clip whose picture is drawn as it
  const { isVisualClip } = await load(`export { isVisualClip } from './src/engine/colourUi'`)
  check('a compound clip is not a colour target (its picture is graded inside it)',
    !isVisualClip(nested, comp[0]) && isVisualClip(ref, ref.tracks[1].clips[0]))
  // K6's Inspector offers a compound clip a pan row: it moves the contents as the same pan on each would
  const panned = structuredClone(nested)
  panned.tracks.flatMap((t) => t.clips).find((c) => c.id === cid).pan = { value: 0.4 }
  const refPan = flat()
  for (const c of refPan.tracks.flatMap((t) => t.clips)) if (['b1', 'a1', 'a2', 'm1'].includes(c.id)) c.pan = { value: 0.4 }
  check('the compound\'s pan pans its sound', mix(panned) === mix(refPan), `${mix(panned).slice(0, 300)}\n vs\n${mix(refPan).slice(0, 300)}`)
  // K9: a compound of sound on an audio track with effects is heard through them, as its clips were
  const eq = [{ id: 'q', type: 'eq', enabled: true, params: { lowGain: 6 } }]
  const fxFlat = () => {
    const p = newProject()
    p.assets = [A('m', 'audio')]
    p.tracks = [track('V1', 'video', []), { ...track('A1', 'audio', [clip('m1', 'm', 0.5, 6, 1)]), audioFx: eq }]
    return p
  }
  s().setProject(fxFlat())
  const fxRef = s().project
  s().nestClips(['m1'])
  const busOf = (p) => collectRangeAudio(p, 0, 12).map((x) => JSON.stringify(x.bus?.fx ?? null))
  check('a compound on a track with effects is heard through them', busOf(s().project).join() === busOf(fxRef).join(),
    `${busOf(s().project)} vs ${busOf(fxRef)}`)
  s().setProject(nested)

  // ---- a second timeline, edited and exported on its own
  const sub = comp[0].timelineId
  const mainId = nested.activeTimeline
  s().setActiveTimeline(sub)
  const inside = s().project
  check('opening the compound shows its timeline', inside.activeTimeline === sub &&
    inside.tracks.flatMap((t) => t.clips).map((c) => c.id).sort().join() === 'a1,a2,b1,m1' && projectDuration(inside) === 6.5)
  check('…and frames there are the nested ones, time-shifted', frame(inside, 4 - 0.5) === frame(bare, 4))
  s().pushHistory('hMove')
  s().updateClip('a2', { inPoint: 12 })
  s().setActiveTimeline(mainId)
  const back = s().project
  check('switching back keeps both timelines, each with its own clips', back.activeTimeline === mainId &&
    back.tracks.flatMap((t) => t.clips).length === 3 && N.timelineTracks(back, sub).flatMap((t) => t.clips).length === 4)
  const a2 = videoLayersAt(flattenProject(back), 6).find((l) => l.clip.assetId === 'a')
  check('an edit inside the nest shows in the host', a2 && Math.abs(clipSourceTime(a2.clip, a2.asset, 6 - a2.clip.start) - 13) < 1e-9)
  const t2 = s().addTimeline()
  check('a new timeline is empty and becomes the open one', s().project.activeTimeline === t2 && s().project.tracks.every((t) => !t.clips.length) &&
    (s().project.timelines ?? []).length === 3)
  s().insertClipFromAsset('a', null, 0)

  // ---- cycles are refused
  s().setActiveTimeline(sub)
  const before = JSON.stringify(s().project)
  check('cycles are refused: a timeline into itself', s().insertTimelineClip(sub, null, 0) === null && JSON.stringify(s().project) === before)
  check('…and into a timeline it is nested in', nestsInto(s().project, sub, mainId) &&
    s().insertTimelineClip(mainId, null, 0) === null && JSON.stringify(s().project) === before)
  check('…while an unrelated one goes in', !nestsInto(s().project, sub, t2) && typeof s().insertTimelineClip(t2, null, 7) === 'string')
  const loop = structuredClone(s().project)
  loop.tracks[0].clips.push({ ...clip('evil', undefined, 0, 2, 0), kind: 'timeline', timelineId: sub, assetId: undefined })
  let threw = null
  let layers = -1
  try { layers = videoLayersAt(flattenProject(loop), 1).length } catch (e) { threw = e }
  check('…and a hand-written cycle draws nothing instead of hanging', threw === null && layers >= 0, String(threw ?? layers))
  check('a timeline used by a compound clip cannot be deleted', s().removeTimeline(sub) === false && s().removeTimeline(t2) === false)
const t3 = s().addTimeline()
check('…an unused one can', s().removeTimeline(t3) === true && !s().project.timelines.some((t) => t.id === t3) && s().project.activeTimeline !== t3)

  // ---- the migration keeps every clip
  const old = flat()
  delete old.timelines; delete old.activeTimeline
  const ids = (p) => allTracks(p).flatMap((t) => t.clips.map((c) => c.id)).sort().join()
  const healed = sanitizeProject(structuredClone(old))
  check('the migration keeps every clip: an old project loads unchanged', ids(healed) === ids(old) &&
    JSON.stringify(healed.tracks.map((t) => t.clips.map((c) => [c.id, c.start, c.duration, c.inPoint]))) ===
    JSON.stringify(old.tracks.map((t) => t.clips.map((c) => [c.id, c.start, c.duration, c.inPoint]))) &&
    (healed.timelines === undefined || healed.timelines.length === 1))
  const many = structuredClone(back)
  many.timelines.push({ id: 7, name: 'junk' }, { id: sub, name: 'dup', tracks: [] })
  const kept = sanitizeProject(structuredClone(many))
  check('…a saved project with several timelines keeps every clip in each', ids(kept) === ids(back) &&
    kept.timelines.length === 2 && kept.timelines.every((t) => typeof t.id === 'string'), `${ids(kept)} vs ${ids(back)}`)
  const lost = structuredClone(back)
  lost.timelines = lost.timelines.filter((t) => t.id !== sub)
  const kl = sanitizeProject(lost)
  check('…a compound whose timeline is gone stays (draws nothing)', kl.tracks.flatMap((t) => t.clips).some((c) => c.kind === 'timeline') &&
    videoLayersAt(flattenProject(kl), 3).length === 2)

  // ---- project-wide edits reach every timeline
  s().setProject(structuredClone(back))
  s().removeAssets(['b'])
  check('removing a source removes its clips in every timeline', !allTracks(s().project).some((t) => t.clips.some((c) => c.assetId === 'b')))
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
