// Node-side check of card F5: the preview's quality (full / ½ / ¼) scales the
// canvas BACKING STORE only. Geometry stays in project pixels, the export's
// compositor stays at project size, and a snapshot (shot mode) draws at full
// size. Also the dropped-frame meter behind the preview's readout.
//
// Cost of getting it wrong: an export at half resolution; a snapshot that
// hands the embedded Claude a half-size frame.
// Run: node scripts/check-preview-scale.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export { Compositor } from './src/gl/compositor'
      export { drawFrame, Player, previewPrefs, previewPoolStats, FrameMeter, PREVIEW_SCALE } from './src/engine/player'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
globalThis.window = globalThis.window ?? {}
globalThis.HTMLVideoElement = globalThis.HTMLVideoElement ?? class {}
const mem = new Map()
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { Compositor, drawFrame, Player, previewPrefs, previewPoolStats, FrameMeter, PREVIEW_SCALE } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}

/** a canvas whose WebGL2 context records the calls that fix the pixel size */
function fakeCanvas() {
  const log = { viewport: [], readPixels: [], vertices: [], tex: [] }
  const any = () => ({})
  const gl = new Proxy({}, {
    get: (_, k) => {
      if (k === 'viewport') return (x, y, w, h) => log.viewport.push([w, h])
      if (k === 'readPixels') return (x, y, w, h) => log.readPixels.push([w, h])
      if (k === 'bufferSubData') return (_t, _o, data) => log.vertices.push(Array.from(data))
      if (k === 'texImage2D') return (...a) => { if (a.length === 9) log.tex.push([a[3], a[4]]) }
      if (k === 'isContextLost') return () => false
      return any
    }
  })
  const canvas = {
    width: 300, height: 150, log,
    getContext: () => gl,
    addEventListener() {}, removeEventListener() {},
    ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, closed: false } }
  }
  return canvas
}

const A = (value) => ({ value })
const video = { id: 'v', kind: 'video', name: 'v', path: '/v.mp4', duration: 10, width: 1280, height: 720 }
const clip = {
  id: 'c', kind: 'media', assetId: 'v', start: 0, duration: 5, inPoint: 0, speed: 1, gain: A(1), muted: false, effects: [],
  transform: { x: A(200), y: A(-100), scale: A(0.5), rotation: A(30), opacity: A(1) }
}
const project = {
  width: 1920, height: 1080, fps: 30, background: '#000000', assets: [video], markers: [],
  tracks: [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [clip] }]
}
/** the decoded frame drawFrame would get from the export's fast path */
const frames = () => new Map([['c', { displayWidth: 1280, displayHeight: 720 }]])
const pool = { get: () => null }

// ---- the export never sees the preview's quality ---------------------------
{
  const name = 'a reduced preview never changes the export\'s composition size'
  const pc = fakeCanvas()
  const preview = new Compositor(pc)
  preview.scale = 0.5
  drawFrame(preview, project, 1, pool, frames())
  check(`${name}: ½ preview backing store is half the project`, pc.width === 960 && pc.height === 540, [pc.width, pc.height])
  check(`${name}: ½ preview viewport is the backing store`, JSON.stringify(pc.log.viewport.at(-1)) === '[960,540]', pc.log.viewport)
  check(`${name}: ½ preview keeps its geometry in project pixels`, preview.width === 1920 && preview.height === 1080, [preview.width, preview.height])

  // the exporter builds a fresh compositor on its own canvas (exporter.ts)
  const ec = fakeCanvas()
  const exp = new Compositor(ec)
  exp.setSize(1920, 1080)
  drawFrame(exp, project, 1, pool, frames())
  const buf = new Uint8Array(4)
  exp.readPixels(buf)
  check(`${name}: the export's compositor is project-sized`, ec.width === 1920 && ec.height === 1080, [ec.width, ec.height])
  check(`${name}: the export reads project-sized frames`, JSON.stringify(ec.log.readPixels.at(-1)) === '[1920,1080]', ec.log.readPixels)
  check(`${name}: the layer lands on the same place in both (NDC vertices equal)`,
    pc.log.vertices.length > 0 && JSON.stringify(pc.log.vertices) === JSON.stringify(ec.log.vertices),
    { preview: pc.log.vertices[0], export: ec.log.vertices[0] })

  const qc = fakeCanvas()
  const quarter = new Compositor(qc)
  quarter.scale = 0.25
  drawFrame(quarter, project, 1, pool, frames())
  check(`${name}: ¼ is a quarter per side`, qc.width === 480 && qc.height === 270, [qc.width, qc.height])
  check('the quality names map to scales', PREVIEW_SCALE.full === 1 && PREVIEW_SCALE.half === 0.5 && PREVIEW_SCALE.quarter === 0.25, PREVIEW_SCALE)

  // an odd project at ¼ never collapses below a pixel
  const oc = fakeCanvas()
  const odd = new Compositor(oc)
  odd.scale = 0.25
  drawFrame(odd, { ...project, width: 3, height: 5 }, 1, pool, frames())
  check('a tiny project still gets at least one pixel per side', oc.width >= 1 && oc.height >= 1, [oc.width, oc.height])
}

// ---- the Player: quality from previewPrefs, full size in shot mode --------
{
  const name = 'a snapshot renders at full size whatever the preview quality'
  const c = fakeCanvas()
  const player = new Player({
    getState: () => ({ project: { ...project, tracks: [] }, playhead: 1, playing: false, playRate: 1, loop: false, range: null, playEnd: null }),
    setPlayhead() {}, setPlaying() {}, setLoading() {}, setGpuLost() {}, duration: () => 5
  })
  player.attach(c)
  previewPrefs.scale = 0.5
  player.drawNow()
  check(`${name}: the preview follows previewPrefs.scale`, c.width === 960, c.width)
  player.setSourceQuality(true)
  player.drawNow()
  check(`${name}: shot mode draws the project size`, c.width === 1920 && c.height === 1080, [c.width, c.height])
  player.setSourceQuality(false)
  player.drawNow()
  check(`${name}: back to ½ after the shot`, c.width === 960, c.width)
  previewPrefs.scale = 1
  player.drawNow()
  check(`${name}: full quality is the project size`, c.width === 1920, c.width)
  player.detach()
}

// ---- the dropped-frame meter ------------------------------------------------
{
  const name = 'the readout counts frames whose moment passed without a draw'
  const m = new FrameMeter()
  // a 60 fps timeline on a 60 Hz display with ±3 ms jitter: nothing dropped
  let ts = 1000
  for (let i = 0; i < 120; i++) { m.draw(ts + (i % 2 ? 3 : -3), 60); ts += 1000 / 60 }
  check(`${name}: jitter below half a frame drops nothing`, m.dropped === 0, m.dropped)
  check(`${name}: fps over the last second`, Math.abs(m.fps - 60) <= 1, m.fps)
  // a 50 ms stall at 60 fps = 3 slots, two of them never drawn
  ts += 1000 / 60 * 2
  m.draw(ts, 60)
  check(`${name}: a 3-frame stall drops two`, m.dropped === 2, m.dropped)
  // a 24 fps timeline on 60 Hz: several draws per frame, nothing dropped
  const m2 = new FrameMeter()
  for (let i = 0; i < 60; i++) m2.draw(2000 + i * 1000 / 60, 24)
  check(`${name}: 24 fps on a 60 Hz display drops nothing`, m2.dropped === 0, m2.dropped)
  // a fresh playback starts from zero
  m.start()
  check(`${name}: a new playback resets the count`, m.dropped === 0 && m.fps === 0, [m.dropped, m.fps])
  const s = previewPoolStats()
  check('previewPoolStats carries fps and dropped', typeof s.fps === 'number' && typeof s.dropped === 'number', s)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
