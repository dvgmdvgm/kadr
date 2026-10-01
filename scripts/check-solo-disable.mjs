// Node-side check of card E9: solo and clip disable reach the mix and the
// picture the same way in preview and export.
//
// Cost of getting it wrong: an export that includes what the user switched
// off — a disabled take still in the film, a muted-by-solo bed still in the mix.
// The collector the export (and every analysis mixdown) uses, the preview's
// audible/visible queries and the store are bundled with esbuild.
// Run: node scripts/check-solo-disable.mjs
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
  collectRangeAudio, audibleClipsAt, videoLayersAt, withoutDisabled, useEditor, newProject, sanitizeProject
} = await load(`
  export { collectRangeAudio } from './src/engine/subtitles'
  export { audibleClipsAt, videoLayersAt, withoutDisabled } from './src/engine/player'
  export { useEditor, newProject, sanitizeProject } from './src/state/store'
`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const asset = { id: 'a', kind: 'video', name: 'take', path: '/x/take.mp4', duration: 60, hasAudio: true, width: 1920, height: 1080 }
const mk = (id, start, duration, extra = {}) => ({
  id, kind: 'media', assetId: 'a', start, duration, inPoint: 0, speed: 1, label: id,
  gain: { value: 1 }, muted: false, effects: [],
  transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } },
  ...extra
})
const tr = (id, kind, clips, extra = {}) => ({ id, kind, name: id, muted: false, locked: false, gain: 1, clips, ...extra })
const project = (tracks) => ({ ...newProject(), fps: 30, assets: [asset], tracks })
const paths = (segs) => segs.map((s) => s.start).sort((a, b) => a - b)

// ---- solo ------------------------------------------------------------------
{
  const p = project([
    tr('V1', 'video', [mk('v', 0, 2)]),
    tr('A1', 'audio', [mk('dia', 0, 2)]),
    tr('A2', 'audio', [mk('mus', 1, 2)])
  ])
  check('without a solo every track reaches the mix', collectRangeAudio(p, 0, 4).length === 3)
  p.tracks[2].solo = true
  const segs = collectRangeAudio(p, 0, 4)
  check('with a solo track only soloed tracks reach the mix',
    segs.length === 1 && Math.abs(segs[0].start - 1) < 1e-9, `starts ${JSON.stringify(paths(segs))}`)
  const heard = audibleClipsAt(p, 1.5).map((l) => l.clip.id)
  check('the preview hears only the soloed track', heard.join() === 'mus', heard.join())
  check('solo does not hide the picture', videoLayersAt(p, 1).map((l) => l.clip.id).join() === 'v')
  p.tracks[1].solo = true
  check('two solos: both soloed tracks are heard', collectRangeAudio(p, 0, 4).length === 2)
  p.tracks[2].muted = true
  check('a soloed but muted track stays silent', collectRangeAudio(p, 0, 4).length === 1)
  p.tracks[1].solo = false; p.tracks[2].muted = false
  check('an analysis aimed at a track bypasses another track\'s solo',
    collectRangeAudio(p, 0, 4, { trackIds: ['A1'] }).length === 1)
}

// ---- disable ---------------------------------------------------------------
{
  const p = project([
    tr('V1', 'video', [mk('v1', 0, 2, { linkId: 'L' }), mk('v2', 2, 2, { disabled: true })]),
    tr('A1', 'audio', [mk('a1', 0, 2, { linkId: 'L', disabled: true }), mk('a2', 2, 2)])
  ])
  const segs = collectRangeAudio(p, 0, 4)
  check('a disabled clip contributes no segment and no layer',
    segs.length === 2 && paths(segs).join() === '0,2' &&
      videoLayersAt(p, 3).length === 0 && videoLayersAt(p, 1).length === 1,
    `segments at ${JSON.stringify(paths(segs))}, layers@3 ${videoLayersAt(p, 3).length}`)
  // v1 (enabled, its own audio) gives the 0 s segment; a1 is off; v2 is off, a2 on
  check('the disabled audio twin is silent in the preview',
    audibleClipsAt(p, 1).map((l) => l.clip.id).join() === 'v1')
  const ex = withoutDisabled(p)
  const ids = ex.tracks.flatMap((t) => t.clips.map((c) => c.id)).join()
  check('the export works on a project without the disabled clips', ids === 'v1,a2', ids)
  check('stripping never touches the live project', p.tracks[0].clips.length === 2)
  const clean = project([tr('V1', 'video', [mk('v1', 0, 2)])])
  check('a project with nothing disabled is passed through as is', withoutDisabled(clean) === clean)
}

// ---- model defaults --------------------------------------------------------
{
  const p = project([
    tr('V1', 'video', [mk('c1', 0, 2, { color: 12, disabled: 'yes' }), mk('c2', 2, 2, { color: 3 })], { color: 'red', solo: 1 }),
    tr('A1', 'audio', [], { color: 5, solo: true })
  ])
  const s = sanitizeProject(JSON.parse(JSON.stringify(p)))
  const [v, a] = s.tracks
  check('sanitize drops a colour outside the label set',
    v.color === undefined && v.clips[0].color === undefined && v.clips[1].color === 3 && a.color === 5)
  check('sanitize makes solo and disabled real booleans',
    v.solo === true && a.solo === true && v.clips[0].disabled === true && v.clips[1].disabled === undefined)
}

// ---- store: undoable and persistent ----------------------------------------
{
  const st = () => useEditor.getState()
  const p = project([tr('V1', 'video', [mk('c1', 0, 2), mk('c2', 2, 2)]), tr('A1', 'audio', [mk('c3', 0, 2)])])
  useEditor.setState({ project: p, past: [], future: [], selection: ['c1', 'c3'] })
  const clip = (id) => st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
  st().toggleDisabled()
  check('toggleDisabled switches the selection off', clip('c1').disabled === true && clip('c3').disabled === true && !clip('c2').disabled)
  st().undo()
  check('toggleDisabled is one undo step', !clip('c1').disabled && !clip('c3').disabled)
  st().redo()
  st().select(['c1', 'c3']) // undo/redo clear the selection
  st().toggleDisabled()
  check('toggleDisabled on an all-off selection switches it back on', !clip('c1').disabled && !clip('c3').disabled)
  st().pushHistory('hEdit')
  st().setClipProps(['c1', 'c2'], { color: 4 })
  st().pushHistory('hEdit')
  st().updateTrack('V1', { name: 'Картинка', color: 2, solo: true })
  const saved = JSON.parse(JSON.stringify(st().project))
  const back = sanitizeProject(saved)
  check('colour, name and solo survive a save and a load',
    back.tracks[0].name === 'Картинка' && back.tracks[0].color === 2 && back.tracks[0].solo === true &&
      back.tracks[0].clips.every((c) => c.color === 4))
  st().undo()
  check('a track edit is undoable', st().project.tracks[0].name === 'V1' && !st().project.tracks[0].solo)
  st().undo()
  check('a clip colour is undoable', clip('c1').color === undefined)
}

if (fails) {
  console.log(`\n${fails} FAILED`)
  process.exit(1)
}
console.log('\nall passed')
