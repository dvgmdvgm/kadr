// Scene-cut markers (card I6). Needs ffmpeg (PATH or KADR_FFMPEG); no app, no tokens.
//  1. detectScenes (main's ffmpeg scdet) on a generated clip with 4 hard cuts
//     finds exactly those 4, within one frame — over the whole file and over a
//     -ss range.
//  2. findScenes on the project maps them through inPoint and speed to
//     project seconds, as markers of kind 'scene', ONE undo step; a new run
//     replaces the old ones; the user's markers are left alone.
//  3. they are snap targets (snapPoints / snapTo) and survive sanitizeProject.
//  4. kadr_scenes: invalid input never reaches the page; kadr_marker takes 'scene'.
// Cost of getting it wrong: markers off the cut.
// Run: node scripts/check-scenes.mjs
import { mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = buildSync({
  entryPoints: [join(root, 'electron', 'ffmpeg.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false,
  alias: { '@shared': join(root, 'shared') }
}).outputFiles[0].text
const F = await import('data:text/javascript;base64,' + Buffer.from(node).toString('base64'))
const page = buildSync({
  stdin: {
    contents: `export * from './src/engine/scenes'
      export * as agentEdit from './src/engine/agentEdits'
      export { useEditor, newProject, snapPoints, snapTo, sanitizeProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
globalThis.window = globalThis.window ?? {}
const M = await import('data:text/javascript;base64,' + Buffer.from(page).toString('base64'))
const { useEditor, newProject, agentEdit } = M

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const s = () => useEditor.getState()
const FPS = 30
const near = (a, b, tol = 1 / FPS + 1e-9) => Math.abs(a - b) <= tol
const sameCuts = (got, want) => got.length === want.length && got.every((t, i) => near(t, want[i]))

const dir = mkdtempSync(join(tmpdir(), 'kadr-scenes-'))
try {
  // five shots, four hard cuts: 1.3, 2.3, 3.2, 4.4 s
  const src = join(dir, 'cuts.mp4')
  const shots = ['color=c=red', 'testsrc2', 'color=c=blue', 'mandelbrot', 'color=c=white']
  const lens = [1.3, 1.0, 0.9, 1.2, 1.0]
  const CUTS = [1.3, 2.3, 3.2, 4.4]
  execFileSync(F.FFMPEG, ['-y', '-v', 'error',
    ...shots.flatMap((sh) => ['-f', 'lavfi', '-i', `${sh}${sh.includes('=') ? ':' : '='}s=320x180:r=${FPS}`]),
    '-filter_complex', shots.map((_, i) => `[${i}]trim=duration=${lens[i]},setpts=PTS-STARTPTS[v${i}]`).join(';') +
      ';' + shots.map((_, i) => `[v${i}]`).join('') + `concat=n=${shots.length}:v=1:a=0`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src])

  // ── 1. main's detector
  const all = await F.detectScenes(src, 0, 5.4, 10)
  check('scdet: the 4 generated cuts, each within one frame', sameCuts(all, CUTS), JSON.stringify(all))
  const part = await F.detectScenes(src, 2, 2, 10)
  check('scdet over a -ss range: source seconds, only the cuts inside', sameCuts(part, [2.3, 3.2]), JSON.stringify(part))
  const deaf = await F.detectScenes(src, 0, 5.4, 99)
  check('scdet: a threshold above every cut finds none', deaf.length === 0, JSON.stringify(deaf))

  // ── 2. findScenes on a project
  window.kadr = { detectScenes: F.detectScenes }
  const tf = { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 } }
  const mk = (id, start, duration, extra = {}) => ({
    id, kind: 'media', assetId: 'vv', start, duration, inPoint: 0, label: id, speed: 1, muted: false,
    gain: { value: 1 }, fadeIn: 0, fadeOut: 0, effects: [], transform: tf, ...extra
  })
  const fresh = () => {
    const p = newProject()
    p.fps = FPS
    p.assets = [{ id: 'vv', kind: 'video', name: 'cuts', path: src, duration: 5.4, hasAudio: false, width: 320, height: 180 }]
    p.tracks = [
      { id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [
        mk('a', 10, 4.4, { inPoint: 0.5 }), // source 0.5..4.9 → cuts at 10.8, 11.8, 12.7, 13.9
        mk('b', 20, 2.7, { speed: 2 }) // source 0..5.4 at 2× → 20.65, 21.15, 21.6, 22.2
      ] }
    ]
    p.markers = [{ id: 'mine', time: 11, label: '1' }]
    useEditor.setState({ project: p, past: [], future: [], selection: [], range: null })
  }
  const scenes = () => (s().project.markers ?? []).filter((m) => m.kind === 'scene').map((m) => m.time)
  const A = [10.8, 11.8, 12.7, 13.9]
  const B = [20.65, 21.15, 21.6, 22.2]
  const onFrame = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6

  fresh()
  const before = JSON.stringify(s().project)
  const r = await M.findScenes({ clipId: 'a' })
  check('findScenes(clip): 4 scene markers at the cuts through inPoint, within one frame', sameCuts(scenes(), A), JSON.stringify(scenes()))
  check('…returned the same times, every one on a frame', sameCuts(r, A) && scenes().every(onFrame), JSON.stringify(r))
  check('…as ONE undo step, the user\'s marker untouched', s().past.length === 1 && s().project.markers.some((m) => m.id === 'mine' && !m.kind))
  s().undo()
  check('…and one undo restores the project exactly', JSON.stringify(s().project) === before)

  fresh()
  await M.findScenes({})
  check('findScenes(whole timeline): both clips, speed 2× mapped', sameCuts(scenes(), [...A, ...B]), JSON.stringify(scenes()))
  await M.findScenes({})
  check('the same run again: no duplicates and no empty undo step', scenes().length === 8 && s().past.length === 1, `${scenes().length} / ${s().past.length}`)
  await M.findScenes({ start: 20, end: 30, threshold: 99 })
  check('a run over a range finding nothing clears only that range, one more step', sameCuts(scenes(), A) && s().past.length === 2, JSON.stringify(scenes()))

  // ── 3. snapping and loading
  fresh()
  await M.findScenes({ clipId: 'a' })
  const pts = M.snapPoints(s().project, [], 0)
  check('snapPoints include every scene marker', A.every((t) => pts.some((x) => near(x, t, 1e-9))))
  const snapped = M.snapTo(12.7 + 0.02, pts, 100)
  check('a clip edge dragged next to a scene cut snaps onto it', near(snapped, scenes()[2], 1e-9), `${snapped}`)
  const healed = M.sanitizeProject(JSON.parse(JSON.stringify(s().project)))
  check('sanitizeProject keeps scene markers (kind, empty label)',
    healed.markers.filter((m) => m.kind === 'scene' && m.label === '').length === 4)

  // ── 4. the MCP tools
  const { TOOLS, runTool } = createRequire(import.meta.url)(join(root, 'electron', 'mcp-edit-tools.cjs'))
  globalThis.window.kadrEditor = { agentEdit, useEditor }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  let pageCalls = 0
  const editorEval = async (code) => { pageCalls++; return new AsyncFunction(code)() }
  const tool = TOOLS.find((t) => t.name === 'kadr_scenes')
  check('kadr_scenes is in the tool table, page code in agentEdit', !!tool && typeof agentEdit[tool?.fn] === 'function')
  if (tool) {
    fresh()
    const out = await runTool(tool, { clipId: 'a' }, editorEval)
    check('kadr_scenes: the cuts in project seconds, one undo step', sameCuts(out.scenes ?? [], A) && s().past.length === 1, JSON.stringify(out))
    for (const args of [{ threshold: 0 }, { threshold: 101 }, { start: 5, end: 2 }, { start: 1 }, { clipId: 'a', start: 0, end: 1 }, { what: 1 }]) {
      pageCalls = 0
      let e2
      try { await runTool(tool, args, editorEval) } catch (e) { e2 = e }
      check(`kadr_scenes rejects ${JSON.stringify(args)} before the page`, !!e2 && pageCalls === 0, e2?.message)
    }
  }
  const marker = TOOLS.find((t) => t.name === 'kadr_marker')
  fresh()
  await runTool(marker, { t: 3, kind: 'scene' }, editorEval)
  check('kadr_marker takes kind "scene"', s().project.markers.some((m) => m.kind === 'scene' && m.time === 3))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
