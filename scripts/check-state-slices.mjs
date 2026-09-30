// kadr_state slices and tool deadlines (card I3). No app, no claude, no tokens.
//  1. sliceState (src/engine/agentState.ts) on a generated 2000-clip project:
//     the summary is small, a track slice is the track whole, and the slices
//     together cover the project exactly once.
//  2. The REAL bridge (electron/mcp-bridge.cjs) spoken to over MCP stdio, with a
//     fake editor behind /eval that runs the tools' page code against the
//     bundled module: no reply is cut mid-JSON, and a stuck eval comes back as a
//     timeout error at the deadline.
// Cost of getting it wrong: the agent editing from a corrupt picture, or an
// agent hung forever on a page that never answers.
// Run: node scripts/check-state-slices.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import http from 'http'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: { contents: `export * from './src/engine/agentState'`, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', write: false, mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { sliceState, STATE_BUDGET, STATE_FIELDS } = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const threw = (f) => { try { f(); return null } catch (e) { return e.message } }

// ── a generated big project: 8 tracks × 250 clips, 400 assets, markers, texts
const A = (n) => ({ value: n })
const clip = (i, t, start) => ({
  id: `c${t}_${i}`, kind: 'media', assetId: `a${(i * 7 + t) % 400}`, start, duration: 1.5, inPoint: i % 5,
  speed: 1, muted: false, gain: A(1), fadeIn: 0, fadeOut: 0, effects: [], label: `clip ${t}/${i}`,
  transform: { x: A(0), y: A(0), scale: A(1), rotation: A(0), opacity: A(1) }
})
const project = {
  version: 1, id: 'p1', name: 'big', width: 1920, height: 1080, fps: 30, background: '#000',
  tracks: Array.from({ length: 8 }, (_, t) => ({
    id: `T${t}`, kind: t < 4 ? 'video' : 'audio', name: `${t < 4 ? 'V' : 'A'}${t + 1}`, muted: false, locked: t === 7, gain: 1,
    clips: Array.from({ length: 250 }, (_, i) => clip(i, t, i * 2))
  })),
  assets: Array.from({ length: 400 }, (_, i) => ({ id: `a${i}`, kind: 'video', name: `take ${i}.mp4`, path: `D:/media/take ${i}.mp4`, duration: 30, hasWaveform: true })),
  bins: [{ id: 'b1', name: 'rushes', parentId: null }],
  texts: [{ id: 'tx1', name: 'talk', path: 'D:/media/talk.srt', format: 'srt' }],
  markers: [{ id: 'm1', time: 10, label: '1' }, { id: 'm2', time: 100, label: '' , kind: 'beat' }, { id: 'm3', time: 90, end: 120, label: '', kind: 'section' }],
  voiceRuns: [], defects: [], claudeChats: ['s1']
}
const src = {
  project, projectPath: 'D:/p/big.kadr', selection: Array.from({ length: 2000 }, (_, i) => `c${i % 8}_${i >> 3}`),
  playhead: 12.4, range: { start: 10, end: 15 },
  exportPresets: [{ id: 'mp4-1080', name: 'MP4', container: 'mp4', audioOnly: false, user: false }],
  voiceDefects: [{ id: 'd1', timeline: [101, 102] }, { id: 'd2', timeline: [300, 301] }]
}

// 1 — the summary
const sum = sliceState(src)
const sumKB = JSON.stringify(sum).length / 1000
check('summary of 2000 clips (all selected) is under 20 KB', sumKB < 20, `${sumKB.toFixed(1)} KB`)
check('summary: tracks with clip counts', eq(sum.tracks.map((t) => t.clips), Array(8).fill(250)))
check('summary: playhead, range, selection count, marker counts by kind',
  sum.playhead === 12.4 && eq(sum.range, src.range) && sum.selectionCount === 2000 && sum.selection.length === 100 &&
  eq(sum.counts.markers, { user: 1, beat: 1, section: 1 }))

// 2 — a track slice is the track whole, by id or by name
const one = sliceState(src, { tracks: ['T3'] })
check('tracks:[id] returns that track whole', eq(one, { tracks: [project.tracks[3]] }))
check('tracks:[name] is the same', eq(sliceState(src, { tracks: ['V4'] }), one))
check('an unknown track is refused by name', /no track "V9"/.test(threw(() => sliceState(src, { tracks: ['V9'] })) ?? ''))

// 3 — the slices cover the project exactly once
{
  const rebuilt = { ...sliceState(src, { fields: ['meta'] }) }
  delete rebuilt.projectPath
  rebuilt.tracks = project.tracks.map((t) => sliceState(src, { tracks: [t.id] }).tracks[0])
  const rest = STATE_FIELDS.filter((f) => !['meta', 'tracks', 'selection', 'voiceDefects', 'exportPresets'].includes(f))
  Object.assign(rebuilt, sliceState(src, { fields: rest }))
  const ordered = Object.fromEntries(Object.keys(project).map((k) => [k, rebuilt[k]]))
  check('meta + one slice per track + the other fields = the project, exactly',
    eq(ordered, project) && Object.keys(rebuilt).length === Object.keys(project).length,
    Object.keys(rebuilt).filter((k) => !(k in project)).concat(Object.keys(project).filter((k) => !(k in rebuilt))).join(',') || '')
  const ids = rebuilt.tracks.flatMap((t) => t.clips.map((c) => c.id))
  check('every clip once', ids.length === 2000 && new Set(ids).size === 2000)
}

// 4 — a range: overlapping clips on every track, markers and defects in it
{
  const r = sliceState(src, { range: { start: 99, end: 102 }, fields: ['markers', 'voiceDefects', 'assets'] })
  const want = project.tracks.map((t) => t.clips.filter((c) => c.start < 102 && c.start + c.duration > 99).map((c) => c.id))
  check('range: clips overlapping [99,102) on every track', eq(r.tracks.map((t) => t.clips.map((c) => c.id)), want), want[0].join(','))
  check('range: markers in it (a section spanning it too)', eq(r.markers.map((m) => m.id), ['m2', 'm3']))
  check('range: voice defects in it', eq(r.voiceDefects.map((d) => d.id), ['d1']))
  const used = new Set(r.tracks.flatMap((t) => t.clips.map((c) => c.assetId)))
  check('range + assets: only the assets those clips use', r.assets.length === used.size && r.assets.every((a) => used.has(a.id)))
  check('range end ≤ start is refused', !!threw(() => sliceState(src, { range: { start: 5, end: 5 } })))
}

// 5 — too big is refused with a narrower slice, never cut
{
  const msg = threw(() => sliceState(src, { fields: ['tracks'] })) ?? ''
  check('all tracks at once (over budget) is refused, not cut', /never cut/.test(msg) && /range \{start: 0, end: \d+\}/.test(msg), msg.slice(0, 160))
  const len = Number(msg.match(/end: (\d+)\}/)?.[1])
  const r = sliceState(src, { range: { start: 0, end: len } })
  check('…and the range it suggests fits', JSON.stringify(r).length <= STATE_BUDGET, `${len} s`)
}

// ── the real bridge over MCP stdio, a fake editor behind /eval
const TOKEN = 'tok'
globalThis.window = { kadrEditor: {
  sliceState, useEditor: { getState: () => ({ project, projectPath: src.projectPath, selection: src.selection, playhead: src.playhead, range: src.range }) },
  exportPresets: () => src.exportPresets, placeDefects: () => []
} }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const server = http.createServer((req, res) => {
  if (req.method === 'GET') return res.end('ok')
  if (req.headers['x-kadr-token'] !== TOKEN) return res.writeHead(403).end()
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    let r
    try { r = { ok: (await new AsyncFunction(JSON.parse(body).code)()) ?? null } } catch (e) { r = { error: String(e.message) } }
    res.end(JSON.stringify(r))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const DEADLINE = 1500
const bridge = spawn(process.execPath, [join(root, 'electron', 'mcp-bridge.cjs'), String(server.address().port), TOKEN],
  { env: { ...process.env, KADR_MCP_TIMEOUT_MS: String(DEADLINE) }, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let buf = ''
bridge.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const m = JSON.parse(line)
    pending.get(m.id)?.(m); pending.delete(m.id)
  }
})
let nextId = 1
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result
const parses = (t) => { try { JSON.parse(t); return true } catch { return false } }
try {
  const s = await call('kadr_state', {})
  check('bridge: kadr_state with no args is the summary, whole JSON', !s.isError && parses(s.content[0].text) &&
    JSON.parse(s.content[0].text).tracks.length === 8, `${(s.content[0].text.length / 1000).toFixed(1)} KB`)
  const t = await call('kadr_state', { tracks: ['A5'] })
  check('bridge: a one-track slice returns whole', !t.isError && eq(JSON.parse(t.content[0].text).tracks[0], project.tracks[4]))
  const big = await call('kadr_state', { fields: ['tracks'] })
  check('bridge: an over-budget slice is an error that names a narrower one', big.isError && /range \{start/.test(big.content[0].text))
  const huge = await call('kadr_eval', { code: `return 'x'.repeat(5_000_000)` })
  check('bridge: a 5 MB kadr_eval result is refused, not cut mid-JSON',
    huge.isError && !/truncated/.test(huge.content[0].text) && huge.content[0].text.length < 1000, huge.content[0].text.slice(0, 120))
  const t0 = Date.now()
  const stuck = await call('kadr_eval', { code: 'await new Promise(() => {})' })
  const took = Date.now() - t0
  check('bridge: a stuck eval returns a timeout error at the deadline',
    stuck.isError && /timed out after 1\.5 s/.test(stuck.content[0].text) && took >= DEADLINE - 50 && took < DEADLINE + 1000,
    `${took} ms: ${stuck.content[0].text.slice(0, 140)}`)
  const t1 = Date.now()
  const longer = await call('kadr_eval', { code: 'await new Promise((r) => setTimeout(r, 2000)); return 7', timeoutSec: 5 })
  check('bridge: kadr_eval timeoutSec extends its own deadline', !longer.isError && longer.content[0].text.trim() === '7', `${Date.now() - t1} ms`)
} finally {
  bridge.kill()
  server.close()
}
console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
