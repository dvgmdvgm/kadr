// Test: group speed change — Alt+drag on a clip edge (the same gesture as
// Ctrl) stretches the whole selection, and the speed bezel in the clip's
// context menu turns it / sets it from a preset. The pure layout maths has
// its own check: scripts/check-speedlayout.mjs.
//
// Makes its own 4 s A/V file with ffmpeg in <tmp>/kadr-test.
// Run: node scripts/e2e45.mjs   (app started with --remote-debugging-port=9777)
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PORT = process.env.KADR_CDP_PORT || 9777
const dir = join(tmpdir(), 'kadr-test')
const media = join(dir, 'speed-av.mp4')
mkdirSync(dir, { recursive: true })
if (!existsSync(media)) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-y', media], { stdio: 'ignore' })
}

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' +
      (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}
async function evalJs(expression, { timeout = 60000 } = {}) {
  const key = `r${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const ALT = 1
async function mouse(type, x, y, modifiers = 0, button = 'left') {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button, clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
    modifiers
  })
}
async function path(points, modifiers = 0) {
  await mouse('mousePressed', points[0].x, points[0].y, modifiers)
  for (const p of points.slice(1)) {
    await mouse('mouseMoved', p.x, p.y, modifiers)
    await new Promise((r) => setTimeout(r, 25))
  }
  const last = points[points.length - 1]
  await mouse('mouseReleased', last.x, last.y, modifiers)
  await new Promise((r) => setTimeout(r, 150))
}
const line = (p0, p1, n = 8) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: p0.x + ((p1.x - p0.x) * i) / n, y: p0.y + ((p1.y - p0.y) * i) / n }))

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// two copies of the A/V file back to back on V1 (twins on A1), zoom 40 px/s
await evalJs(`(async () => {
  const ed = window.kadrEditor
  window.__st = () => ed.useEditor.getState()
  const [aid] = await ed.importFiles([${JSON.stringify(media)}], null)
  const st = window.__st
  st().setZoom(40)
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipsFromAssets([aid, aid], v1.id, 0)
  window.__vid = () => st().project.tracks.find(t => t.name === 'V1').clips
    .slice().sort((a, b) => a.start - b.start)
  window.__aud = () => st().project.tracks.find(t => t.kind === 'audio' && t.clips.length).clips
    .slice().sort((a, b) => a.start - b.start)
  window.__px = (clip) => {
    const el = [...document.querySelectorAll('[data-lane="' + v1.id + '"] .clip')]
      .find(e => Math.abs(parseFloat(e.style.left) - clip.start * st().zoom) < 0.5)
    const r = el.getBoundingClientRect()
    // mid = the extend grip; edge = the plain edge zone, clear of the
    // level line at the top and the transition tip in the bottom corner
    return { l: r.left, r: r.right, mid: r.top + r.height / 2, y: r.top + r.height * 0.68 }
  }
  return true
})()`)
const vid = () => evalJs('window.__vid().map(c => ({ id: c.id, start: c.start, duration: c.duration, speed: c.speed || 1 }))')
const aud = () => evalJs('window.__aud().map(c => ({ start: c.start, duration: c.duration, speed: c.speed || 1 }))')

let v = await vid()
check('setup: two 4 s clips back to back', v.length === 2 && near(v[1].start, 4) && near(v[1].duration, 4),
  JSON.stringify(v))

// 1. Alt+drag the right edge of the second clip with both selected ----------
await evalJs(`(() => { const s = window.__st(); s.select(s.project.tracks.flatMap(t => t.clips.map(c => c.id))); return true })()`)
const hist0 = await evalJs('window.__st().past.length')
let g = await evalJs('window.__px(window.__vid()[1])')
// 4 s → 8 s at 40 px/s: +160 px, i.e. half speed
await path(line({ x: g.r - 3, y: g.mid }, { x: g.r - 3 + 160, y: g.mid }), ALT)
v = await vid()
check('Alt+edge drag slows the whole selection', v.every((c) => near(c.speed, 0.5, 1e-3)), JSON.stringify(v))
check('…each clip keeps its source span', v.every((c) => near(c.duration, 8, 1e-2)))
check('…the group stays back to back from its start', near(v[0].start, 0) && near(v[1].start, v[0].duration, 1e-6))
const a = await aud()
check('…the linked audio follows', a.length === 2 && a.every((c) => near(c.speed, 0.5, 1e-3)) &&
  near(a[1].start, v[1].start), JSON.stringify(a))
check('…as one undo step', (await evalJs('window.__st().past.length')) === hist0 + 1)
await evalJs(`(() => { window.__st().undo(); return true })()`)
v = await vid()
check('undo restores both clips', v.every((c) => near(c.speed, 1) && near(c.duration, 4)), JSON.stringify(v))

// 2. Alt+drag on an unselected clip changes only that clip -----------------
await evalJs(`(() => { window.__st().select([]); return true })()`)
g = await evalJs('window.__px(window.__vid()[0])')
await path(line({ x: g.r - 10, y: g.y }, { x: g.r - 10 - 80, y: g.y }), ALT)
v = await vid()
check('Alt+drag on an unselected clip touches only it',
  near(v[0].speed, 2, 1e-3) && near(v[1].speed, 1), JSON.stringify(v))
await evalJs(`(() => { window.__st().undo(); return true })()`)

// 3. the context-menu bezel -------------------------------------------------
await evalJs(`(() => { const s = window.__st(); s.select(s.project.tracks.flatMap(t => t.clips.map(c => c.id))); return true })()`)
g = await evalJs('window.__px(window.__vid()[0])')
await mouse('mousePressed', g.l + 40, g.y, 0, 'right')
await mouse('mouseReleased', g.l + 40, g.y, 0, 'right')
await new Promise((r) => setTimeout(r, 200))
const ring = await evalJs(`(() => {
  const el = document.querySelector('.ctx-menu .speed-jog')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
})()`)
check('the clip menu carries the speed jog strip', !!ring)
if (ring) {
  await evalJs(`(() => { [...document.querySelectorAll('.ctx-menu .speed-dial button')]
    .find(b => b.textContent === '×2').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 100))
  v = await vid()
  check('a preset sets every selected clip', v.every((c) => near(c.speed, 2)) &&
    near(v[1].start, 2), JSON.stringify(v))

  // 40 px to the right = a quarter of JOG_PX: ×4^(1/4) ≈ 1.41 on top of ×2
  const h1 = await evalJs('window.__st().past.length')
  await path(line({ x: ring.cx - 20, y: ring.cy }, { x: ring.cx + 20, y: ring.cy }))
  v = await vid()
  check('dragging the strip right speeds the group up',
    v.every((c) => c.speed > 2.6 && c.speed < 3.1) && near(v[0].speed, v[1].speed), JSON.stringify(v))
  check('…the menu stays open while dragging', await evalJs('!!document.querySelector(".ctx-menu .speed-jog")'))
  check('…one undo step per drag', (await evalJs('window.__st().past.length')) === h1 + 1)
  await evalJs(`(() => { window.__st().undo(); return true })()`)
  v = await vid()
  check('undo of the drag goes back to ×2', v.every((c) => near(c.speed, 2)), JSON.stringify(v))
}
await mouse('mousePressed', 5, 5)
await mouse('mouseReleased', 5, 5)
ws.close()
