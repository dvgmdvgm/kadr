// Node-side check of card F4: a clip's fit mode (contain / cover / stretch)
// and flip, evaluated by the compositor's own geometry (`layerQuad`) — the
// one the preview and the export both draw with.
//
// Cost of getting it wrong: black bars in vertical exports; a flip that
// leaves a mask or crop behind on the unflipped side.
// Run: node scripts/check-fit.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  stdin: {
    contents: `export { layerQuad, fitSize } from './src/gl/compositor'
      export { drawFrame, clipGeom } from './src/engine/player'
      export { sanitizeProject } from './src/state/store'`,
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
globalThis.window = globalThis.window ?? {}
globalThis.HTMLVideoElement = globalThis.HTMLVideoElement ?? class {}
const mem = new Map()
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { layerQuad, fitSize, drawFrame, clipGeom, sanitizeProject } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b) => Math.abs(a - b) < 1e-6
const bbox = (q) => {
  const xs = q.map((p) => p.sx), ys = q.map((p) => p.sy)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const L = (extra) => ({ srcWidth: 1920, srcHeight: 1080, x: 0, y: 0, scale: 1, rotation: 0, ...extra })

// ---- cover / stretch / contain ------------------------------------------------
{
  const name = 'cover fills the frame with no border and minimal crop; stretch matches the frame exactly'
  // 16:9 into 9:16
  const [x0, y0, x1, y1] = bbox(layerQuad(L({ fit: 'cover' }), 1080, 1920))
  check(`${name}: cover, 16:9 in 9:16 — no border`, x0 <= 0 && y0 <= 0 && x1 >= 1080 && y1 >= 1920, [x0, y0, x1, y1])
  check(`${name}: cover — the tight side is exactly the frame (minimal crop)`, near(y0, 0) && near(y1, 1920), [y0, y1])
  check(`${name}: cover keeps the source's aspect`, near((x1 - x0) / (y1 - y0), 1920 / 1080), (x1 - x0) / (y1 - y0))
  // 9:16 into 16:9 — the other axis is the tight one
  const [a0, b0, a1, b1] = bbox(layerQuad(L({ srcWidth: 1080, srcHeight: 1920, fit: 'cover' }), 1280, 720))
  check(`${name}: cover, 9:16 in 16:9`, near(a0, 0) && near(a1, 1280) && b0 < 0 && b1 > 720, [a0, b0, a1, b1])
  const s = layerQuad(L({ fit: 'stretch' }), 1080, 1920)
  check(`${name}: stretch`, [[0, 0], [0, 1920], [1080, 0], [1080, 1920]].every(([x, y], i) => near(s[i].sx, x) && near(s[i].sy, y)),
    s.map((p) => [p.sx, p.sy]))
  const c = bbox(layerQuad(L({}), 1080, 1920))
  const c2 = bbox(layerQuad(L({ fit: 'contain' }), 1080, 1920))
  check('contain is the default and leaves bars on a mismatched frame',
    c.every((v, i) => near(v, c2[i])) && near(c[0], 0) && near(c[2], 1080) && c[1] > 0, c)
  check('fitSize: stretch draws at the frame\'s aspect (mask distances follow)',
    near(fitSize(L({ fit: 'stretch' }), 1080, 1920)[0] / fitSize(L({ fit: 'stretch' }), 1080, 1920)[1], 1080 / 1920))
  const half = bbox(layerQuad(L({ fit: 'cover', scale: 0.5 }), 1080, 1920))
  check('the clip scale applies on top of the fit', near(half[3] - half[1], 960), half)
}

// ---- flip ---------------------------------------------------------------------
{
  // corners are TL, BL, TR, BR in uv; a flip mirrors where they land, uv stays —
  // so crop and mask shapes (both in layer uv) travel with the picture
  const plain = layerQuad(L({}), 1280, 720)
  const fx = layerQuad(L({ flipX: true }), 1280, 720)
  const fy = layerQuad(L({ flipY: true }), 1280, 720)
  check('flipX: the source\'s left edge (u = 0) lands on the right, v untouched',
    near(fx[0].sx, plain[2].sx) && near(fx[0].sy, plain[0].sy) && fx[0].u === 0, fx.map((p) => [p.sx, p.sy, p.u]))
  check('flipY: the source\'s top edge (v = 0) lands at the bottom',
    near(fy[0].sy, plain[1].sy) && near(fy[0].sx, plain[0].sx) && fy[0].v === 0, fy.map((p) => [p.sx, p.sy, p.v]))
  const r = layerQuad(L({ flipX: true, rotation: 30, x: 100 }), 1280, 720)
  const r0 = layerQuad(L({ rotation: 30, x: 100 }), 1280, 720)
  const cx = (q) => q.reduce((s, p) => s + p.sx, 0) / 4, cy = (q) => q.reduce((s, p) => s + p.sy, 0) / 4
  check('a flip is about the layer\'s own centre: a rotated, moved layer keeps its centre', near(cx(r), cx(r0)) && near(cy(r), cy(r0)), [cx(r), cx(r0)])
}

// ---- the clip's fields reach the layer, preview and export alike -----------------
{
  const video = { id: 'v', kind: 'video', name: 'v', path: '/v.mp4', duration: 10, width: 1920, height: 1080 }
  const A = (value) => ({ value })
  const clip = {
    id: 'c', kind: 'media', assetId: 'v', start: 0, duration: 5, inPoint: 0, speed: 1, gain: A(1), muted: false, effects: [],
    transform: { x: A(0), y: A(0), scale: A(1), rotation: A(0), opacity: A(1) }, fit: 'cover', flipX: true
  }
  const track = { id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [clip] }
  const project = { width: 1080, height: 1920, fps: 30, background: '#000000', assets: [video], tracks: [track], markers: [] }
  const layers = []
  const comp = {
    setSize() {}, begin() {}, beginOverlay() {}, endOverlay() {}, drawEdgeEffect() {}, drawTransition() {},
    drawLayer: (l) => layers.push(l), drawLayerFx: (ls) => layers.push(...ls)
  }
  drawFrame(comp, project, 1, { get: () => null }, new Map([['c', { displayWidth: 960, displayHeight: 540 }]]))
  const l = layers.find((x) => x.cacheKey === 'c')
  check('drawFrame hands the compositor the clip\'s fit and flip', l?.fit === 'cover' && l?.flipX === true && !l?.flipY, l && { fit: l.fit, flipX: l.flipX })
  const g = clipGeom(project, track, clip, 1)
  check('the gizmo geometry carries them too', g?.fit === 'cover' && g?.flipX === true)
}

// ---- sanitizeProject ----------------------------------------------------------------
{
  const A = (value) => ({ value })
  const mk = (id, extra) => ({
    id, kind: 'media', assetId: 'v', start: 0, duration: 5, inPoint: 0, speed: 1, gain: A(1), muted: false, effects: [],
    transform: { x: A(0), y: A(0), scale: A(1), rotation: A(0), opacity: A(1) }, ...extra
  })
  const p = sanitizeProject({
    id: 'p', name: 'p', width: 1280, height: 720, fps: 30, background: '#000000', markers: [],
    assets: [{ id: 'v', kind: 'video', name: 'v', path: '/v.mp4', duration: 10, width: 1920, height: 1080 }],
    tracks: [{ id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [
      mk('a', { fit: 'cover', flipX: 1, flipY: 0 }), mk('b', { fit: 'zoom', flipX: 0 }), mk('c', { fit: 'contain' })
    ] }]
  })
  const [a, b, c] = p.tracks[0].clips
  check('sanitize keeps a known fit and makes flips booleans (false → absent)',
    a.fit === 'cover' && a.flipX === true && !('flipY' in a), a)
  check('sanitize drops an unknown fit (→ contain) and junk flips',
    !('fit' in b) && !('flipX' in b) && !('fit' in c), { b, c })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
