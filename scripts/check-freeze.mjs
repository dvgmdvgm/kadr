// Node-side check of card E10: freeze frame, duplicate / copy-drag, paste
// attributes.
//
// Cost of getting it wrong: a freeze that drifts in the export (the preview
// holds one frame, the export plays on or blends in the next one), a copy that
// stays linked to its original pair, attributes pasted in several undo steps.
// Run: node scripts/check-freeze.mjs
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
const {
  clipSourceTime, sourceFrameRate, elementRuns, audibleClipsAt, collectRangeAudio,
  useEditor, newProject, sanitizeProject
} = await load(`
  export { clipSourceTime, sourceFrameRate, elementRuns, audibleClipsAt } from './src/engine/player'
  export { collectRangeAudio } from './src/engine/subtitles'
  export { useEditor, newProject, sanitizeProject } from './src/state/store'
`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b) => Math.abs(a - b) < 1e-6

const asset = { id: 'a', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 10, fps: 25, hasAudio: true, width: 1920, height: 1080 }
const mk = (id, start, duration, extra = {}) => ({
  id, kind: 'media', assetId: 'a', start, duration, inPoint: 0, speed: 1, label: id,
  gain: { value: 1 }, muted: false, effects: [],
  transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } },
  ...extra
})
const tr = (id, kind, clips, extra = {}) => ({ id, kind, name: id, muted: false, locked: false, gain: 1, clips, ...extra })
const project = (tracks) => ({ ...newProject(), fps: 30, assets: [asset], tracks })
const st = () => useEditor.getState()
const all = () => st().project.tracks.flatMap((t) => t.clips)
const clip = (id) => all().find((c) => c.id === id)
const onFrame = (t) => near(t * 30, Math.round(t * 30))

// ---- the source time both paths sample ------------------------------------
{
  const fz = mk('f', 3, 20, { inPoint: 4, speed: 2.5, freezeAt: 6.2 })
  const times = Array.from({ length: 600 }, (_, i) => clipSourceTime(fz, asset, i / 30))
  check('a frozen clip samples one source time for its whole duration in both drawFrame paths',
    times.every((x) => x === 6.2) && sourceFrameRate(fz, asset, 30) === 1 && !elementRuns(fz, true, 1),
    `distinct ${new Set(times).size}, blend rate ${sourceFrameRate(fz, asset, 30)}, element runs ${elementRuns(fz, true, 1)}`)
  const slow = mk('s', 0, 4, { speed: 0.5 })
  check('an ordinary slow clip still blends and still plays',
    sourceFrameRate(slow, asset, 30) < 1 && elementRuns(slow, true, 1) && !elementRuns(slow, true, -1) &&
      clipSourceTime(slow, asset, 2) === 1)
  const p = project([tr('V1', 'video', [mk('v', 0, 2), fz]), tr('A1', 'audio', [])])
  check('a freeze is silent in the preview and the export',
    audibleClipsAt(p, 4).length === 0 && collectRangeAudio(p, 0, 30).length === 1)
}

// ---- Shift+F: a 2 s freeze at the playhead, after a split -------------------
{
  const opacity = { value: 1, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 6, value: 1, easing: 'linear' }] }
  const p = project([
    tr('V1', 'video', [mk('v', 0, 6, { inPoint: 1, linkId: 'L', transform: { ...mk('x', 0, 1).transform, opacity } })]),
    tr('A1', 'audio', [mk('a', 0, 6, { inPoint: 1, linkId: 'L' }), mk('a9', 8, 1)])
  ])
  useEditor.setState({ project: p, past: [], future: [], selection: [], playhead: 2.51 })
  st().freezeFrame()
  const v = st().project.tracks[0].clips.slice().sort((x, y) => x.start - y.start)
  const a = st().project.tracks[1].clips.slice().sort((x, y) => x.start - y.start)
  const [left, fz, right] = v
  const t = 75 / 30 // 2.51 s lands on frame 75
  check('Shift+F splits and inserts a 2 s freeze at the playhead',
    v.length === 3 && near(left.start + left.duration, t) && near(fz.start, t) && near(fz.duration, 2) &&
      near(right.start, t + 2) && near(right.inPoint, 1 + t) && onFrame(fz.start),
    JSON.stringify(v.map((c) => [c.start, c.duration, c.inPoint])))
  check('the freeze holds the source frame at the playhead, silent and unlinked',
    near(fz.freezeAt, 1 + t) && fz.linkId === undefined && !fz.transitionIn && !fz.fadeIn)
  check('the freeze keeps the look of that moment, not the animation',
    near(fz.transform.opacity.value, t / 6) && !fz.transform.opacity.keyframes?.length,
    JSON.stringify(fz.transform.opacity))
  check('the audio twin splits and its right half moves with the picture (the pair stays linked)',
    a.length === 3 && near(a[0].start + a[0].duration, t) && near(a[1].start, t + 2) &&
      a[1].linkId && a[1].linkId === right.linkId && near(a[2].start, 10))
  st().undo()
  check('Shift+F is one undo step',
    st().project.tracks[0].clips.length === 1 && st().project.tracks[1].clips.length === 2 && near(clip('a9').start, 8))
  st().redo()
  // a freeze is not bound by its source: its end can be pulled past the media's end
  const fid = st().project.tracks[0].clips.find((c) => c.freezeAt !== undefined).id
  st().trimClip(fid, 'out', clip(fid).start + 30)
  check('a freeze trims past the end of its source', near(clip(fid).duration, 30), String(clip(fid).duration))
  useEditor.setState({ playhead: 7.5, selection: [] })
  const n = all().length
  useEditor.setState({ project: project([tr('V1', 'video', []), tr('A1', 'audio', [mk('aa', 0, 9)])]), past: [] })
  st().freezeFrame()
  check('no picture under the playhead: nothing happens, no undo step', st().past.length === 0 && n > 0)
}

// ---- duplicate -------------------------------------------------------------
{
  const p = project([
    tr('V1', 'video', [mk('v', 1, 2, { linkId: 'L' }), mk('v2', 6, 1)]),
    tr('A1', 'audio', [mk('a', 1, 2, { linkId: 'L' })])
  ])
  useEditor.setState({ project: p, past: [], future: [], selection: ['v', 'a'] })
  st().duplicateSelection()
  const copies = all().filter((c) => !['v', 'v2', 'a'].includes(c.id))
  check('duplicate puts a copy of the selection right after it',
    copies.length === 2 && copies.every((c) => near(c.start, 3) && near(c.duration, 2)) &&
      st().selection.length === 2 && st().selection.every((id) => copies.some((c) => c.id === id)))
  check('the copies are a pair of their own',
    copies[0].linkId && copies[0].linkId === copies[1].linkId && copies[0].linkId !== 'L')
  st().undo()
  check('duplicate is one undo step', all().length === 3)

  useEditor.setState({ project: p, past: [], future: [], selection: ['v', 'a'] })
  const ids = st().duplicateInPlace(['v', 'a'])
  const twins = ids.map(clip)
  check('the copy-drag leaves a copy in place and pushes no undo step of its own',
    ids.length === 2 && twins.every((c) => c && near(c.start, 1)) && twins[0].linkId === twins[1].linkId &&
      twins[0].linkId !== 'L' && st().past.length === 0)
}

// ---- paste attributes ------------------------------------------------------
{
  const src = mk('src', 0, 4, {
    speed: 2, effects: [{ id: 'e', type: 'blur', params: { amount: 3 } }], gain: { value: 0.5 },
    maskShapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }],
    transform: { ...mk('x', 0, 1).transform, scale: { value: 1.5 } }
  })
  const p = project([tr('V1', 'video', [src, mk('t', 5, 4)]), tr('A1', 'audio', [])])
  useEditor.setState({ project: p, past: [], future: [], selection: ['src'] })
  st().copySelection()
  st().select(['t'])
  st().pasteAttributes(['transform', 'speed', 'masks'])
  const t = clip('t')
  check('paste attributes applies the chosen parts only',
    t.transform.scale.value === 1.5 && t.speed === 2 && near(t.duration, 2) && t.maskShapes?.length === 1 &&
      t.effects.length === 0 && t.gain.value === 1, JSON.stringify({ speed: t.speed, d: t.duration, fx: t.effects.length }))
  check('the pasted transform is a copy, not the source object',
    t.transform !== clip('src').transform)
  st().undo()
  check('paste attributes is one undo step', clip('t').speed === 1 && clip('t').transform.scale.value === 1)
  st().select(['t'])
  st().pasteAttributes(['effects', 'volume'])
  check('effects and volume come over too', clip('t').effects.length === 1 && clip('t').gain.value === 0.5)
}

// ---- the model -------------------------------------------------------------
{
  const s = sanitizeProject(JSON.parse(JSON.stringify(project([tr('V1', 'video', [
    mk('ok', 0, 1, { freezeAt: 2 }), mk('bad', 1, 1, { freezeAt: 'x' }), mk('neg', 2, 1, { freezeAt: -1 })
  ])]))))
  const [ok, bad, neg] = s.tracks[0].clips
  check('sanitize keeps a real freeze time and drops junk',
    ok.freezeAt === 2 && bad.freezeAt === undefined && neg.freezeAt === undefined)
}

if (fails) {
  console.log(`\n${fails} FAILED`)
  process.exit(1)
}
console.log('\nall passed')
