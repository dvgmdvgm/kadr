// Node-side check of card F1: the preview gizmo's box is the compositor's own
// geometry. The gizmo builds its box from the clip (`clipGeom` → `layerQuad`)
// without a decoder; drawFrame builds the layer from the decoded frame or the
// element. Both must land on the same four corners, for footage decoded at a
// proxy's size, stills, any rotation, a 3D tilt and whole-track motion.
// Every row runs under contain, cover and stretch (card F4; stretch flipped too).
//
// Cost of getting it wrong: handles that do not sit on the picture.
// Run: node scripts/check-gizmo-box.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export { drawFrame, clipGeom } from './src/engine/player'
      export { layerQuad } from './src/gl/compositor'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
globalThis.window = globalThis.window ?? {}
globalThis.HTMLVideoElement = globalThis.HTMLVideoElement ?? class {}
const mem = new Map()
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { drawFrame, clipGeom, layerQuad } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}

const video = { id: 'v', kind: 'video', name: 'v', path: '/v.mp4', duration: 10, width: 1920, height: 1080 }
const still = { id: 'i', kind: 'image', name: 'i', path: '/i.png', duration: 5, width: 480, height: 640 }
const A = (value) => ({ value })
const mk = (id, assetId, tr = {}) => ({
  id, kind: 'media', assetId, start: 0, duration: 5, inPoint: 0, speed: 1, label: id,
  gain: A(1), muted: false, effects: [],
  transform: { x: A(0), y: A(0), scale: A(1), rotation: A(0), opacity: A(1), ...tr }
})

/** the corners drawFrame hands the compositor for the clip, via a stub */
function drawnCorners(project, clipId, frameSize) {
  const layers = []
  const comp = {
    setSize() {}, begin() {}, beginOverlay() {}, endOverlay() {}, drawEdgeEffect() {}, drawTransition() {},
    drawLayer: (l) => layers.push(l),
    drawLayerFx: (ls) => layers.push(...ls)
  }
  const asset = project.assets.find((a) => a.id === project.tracks[0].clips[0].assetId)
  const frames = new Map()
  if (asset.kind === 'video') frames.set(clipId, { displayWidth: frameSize[0], displayHeight: frameSize[1] })
  const pool = { get: () => ({ complete: true, naturalWidth: frameSize[0], naturalHeight: frameSize[1] }) }
  drawFrame(comp, project, 1, pool, frames)
  const l = layers.find((x) => x.cacheKey === clipId)
  return l && layerQuad(l, project.width, project.height)
}
const same = (a, b) => a && b && a.every((p, i) => Math.abs(p.sx - b[i].sx) < 1e-6 && Math.abs(p.sy - b[i].sy) < 1e-6)
const round = (q) => q?.map((p) => [+p.sx.toFixed(2), +p.sy.toFixed(2)])

// ---- the formula itself, on cases whose answer is known by hand -------------
{
  const q = layerQuad({ srcWidth: 1920, srcHeight: 1080, x: 100, y: -50, scale: 0.5, rotation: 0 }, 1280, 720)
  // contain: 1920×1080 → 1280×720, ×0.5 → 640×360 about (740, 310)
  check('contain, no rotation: the box is the fitted size about the offset centre',
    same(q, [{ sx: 420, sy: 130 }, { sx: 420, sy: 490 }, { sx: 1060, sy: 130 }, { sx: 1060, sy: 490 }]), round(q))
  const r = layerQuad({ srcWidth: 480, srcHeight: 640, x: 0, y: 0, scale: 1, rotation: 90 }, 1280, 720)
  // 480×640 contained in 720 high → 540×720, turned 90°: 720 wide, 540 high
  const xs = r.map((p) => p.sx), ys = r.map((p) => p.sy)
  check('a quarter turn swaps the box\'s width and height',
    Math.abs(Math.max(...xs) - Math.min(...xs) - 720) < 1e-6 && Math.abs(Math.max(...ys) - Math.min(...ys) - 540) < 1e-6, round(r))
}

// ---- the gizmo's box equals what drawFrame draws -----------------------------
const motion = { x: A(80), y: A(-40), scale: A(0.8), rotation: A(12), rotX: A(0), rotY: A(0), z: A(0) }
const cases = [
  ['footage decoded at a proxy\'s size', video, [960, 540], {}, null],
  ['footage, moved, scaled and rotated 33°', video, [960, 540], { x: A(210), y: A(-75), scale: A(0.6), rotation: A(33) }, null],
  ['footage turned −120° with keyframed position', video, [1920, 1080],
    { x: { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: 300, easing: 'linear' }] }, rotation: A(-120) }, null],
  ['a portrait still', still, [480, 640], { scale: A(1.3), rotation: A(-7) }, null],
  ['a still tilted in 3D', still, [480, 640], { rotX: A(25), rotY: A(-35), z: A(-120) }, null],
  ['footage under whole-track motion', video, [960, 540], { x: A(50), rotation: A(20) }, motion]
]
for (const [W, H] of [[1280, 720], [1080, 1920]]) {
  for (const [name, asset, frameSize, tr, trackMotion] of cases) for (const fit of ['contain', 'cover', 'stretch']) {
    const clip = { ...mk('c', asset.id, tr), fit, ...(fit === 'stretch' ? { flipX: true, flipY: true } : {}) }
    const track = { id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [clip], ...(trackMotion ? { motion: trackMotion } : {}) }
    const project = { width: W, height: H, fps: 30, background: '#000000', assets: [video, still], tracks: [track], markers: [] }
    const drawn = drawnCorners(project, 'c', frameSize)
    const g = clipGeom(project, track, clip, 1)
    const box = g && layerQuad(g, W, H)
    check(`the gizmo box equals the drawn layer bounds for contain, cover and stretch at any rotation: ${name} (${W}×${H}, ${fit}${clip.flipX ? ', flipped' : ''})`,
      same(box, drawn), { box: round(box), drawn: round(drawn) })
  }
}

// ---- what gets no box ----------------------------------------------------------
{
  const project = { width: 1280, height: 720, assets: [{ id: 'a', kind: 'audio', width: 0, height: 0 }], tracks: [] }
  const tr = { id: 'A1', kind: 'audio', clips: [] }
  check('an audio clip or a missing asset has no box',
    clipGeom(project, tr, mk('x', 'a'), 1) === null && clipGeom(project, tr, mk('y', 'gone'), 1) === null)
  const frag = { ...mk('f', undefined), kind: 'remotion', fragmentMeta: { width: 1080, height: 1080 } }
  const fg = clipGeom(project, { id: 'V1', kind: 'video', clips: [frag] }, frag, 1)
  check('a fragment\'s box is its composition size', fg?.srcWidth === 1080 && fg?.srcHeight === 1080, fg)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
