// K7: audio scrub (src/engine/scrub.ts). Dragging the playhead while paused
// plays short grains of what sounds at the scrub position, from elements of
// their own. The cost this guards: a sound that keeps going after the drag —
// a seek that lands after the mouse is up, a grain that never stops itself.
// Fake clock, fake elements whose seeks complete when the test says so.
// Run: node scripts/check-scrub-grains.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  entryPoints: [join(root, 'src/engine/scrub.ts')], bundle: true, platform: 'node', format: 'esm',
  write: false, logLevel: 'error', alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const { createScrub, SCRUB_GAP_MS, SCRUB_GRAIN_MS } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// a clock and a timer queue the test advances by hand
let now = 0
let timers = []
const later = (fn, ms) => { const h = { at: now + ms, fn }; timers.push(h); return h }
const cancel = (h) => { timers = timers.filter((x) => x !== h) }
const advance = (to) => {
  for (;;) {
    const due = timers.filter((x) => x.at <= to).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    now = due.at
    cancel(due)
    due.fn()
  }
  now = to
}

// an element whose seek completes only when `land()` is called
const log = []
const fakeEl = (key) => {
  const el = {
    key, paused: true, currentTime: 0, onseeked: null, pendingSeek: false,
    play() { el.paused = false; log.push({ key, at: now, what: 'play', t: el.currentTime }) },
    pause() { if (!el.paused) log.push({ key, at: now, what: 'pause' }); el.paused = true },
    land() { if (el.pendingSeek) { el.pendingSeek = false; el.onseeked?.() } }
  }
  return new Proxy(el, {
    set(o, p, v) { o[p] = v; if (p === 'currentTime') o.pendingSeek = true; return true }
  })
}
const els = new Map()
const voice = (g) => { if (!els.has(g.key)) els.set(g.key, fakeEl(g.key)); return els.get(g.key) }
// two clips sound everywhere; the source time is the timeline time + 10
const grains = (t) => ['a', 'b'].map((key) => ({ key, at: t + 10 }))
const landAll = () => { for (const el of els.values()) el.land() }

const scrub = createScrub({ now: () => now, grains, voice, later, cancel })

check('the gap and the grain are the card\'s numbers', SCRUB_GAP_MS === 60 && SCRUB_GRAIN_MS === 80,
  `gap ${SCRUB_GAP_MS} ms, grain ${SCRUB_GRAIN_MS} ms`)

// a drag: a pointer move every 8 ms for 1 s, seeks landing 5 ms after each move
scrub.begin()
for (let i = 0; i <= 125; i++) {
  advance(i * 8)
  scrub.move(i * 0.01)
  advance(i * 8 + 5)
  landAll()
}
const starts = log.filter((e) => e.what === 'play' && e.key === 'a').map((e) => e.at)
const gaps = starts.slice(1).map((x, i) => x - starts[i])
check('grains are emitted at most every 60 ms', starts.length > 0 && Math.min(...gaps) >= SCRUB_GAP_MS,
  `${starts.length} grains in 1 s, smallest gap ${Math.min(...gaps)} ms`)
check('…and a steady drag keeps emitting them', starts.length >= 1000 / (SCRUB_GAP_MS + 8) - 1, `${starts.length}`)
check('every clip at the position gets its grain', log.filter((e) => e.what === 'play' && e.key === 'b').length === starts.length)
const last = log.filter((e) => e.what === 'play' && e.key === 'a').at(-1)
check('a grain plays from the scrub position in the source', Math.abs(last.t - (1.2 + 10)) < 0.05, `${last.t}`)

// the mouse goes up while a seek is still in flight
advance(1100)
scrub.move(1.3) // emits (gap passed), the seek is pending
check("the last move emitted (its seek is in flight)", [...els.values()].every((el) => el.pendingSeek))
const before = log.length
scrub.end()
check('the drag ending pauses every voice at once', [...els.values()].every((el) => el.paused))
landAll() // the seek lands after the drag ended
advance(5000)
const after = log.slice(before).filter((e) => e.what === 'play')
check('grains never play after the drag ends — not even a seek landing late', after.length === 0,
  after.map((e) => `${e.key}@${e.at}`).join(' '))
check('no timer is left behind', timers.length === 0, `${timers.length}`)
scrub.move(1.4) // a move after end (a late pointermove) starts nothing
landAll()
check('a move after the end starts nothing until a new drag', log.slice(before).every((e) => e.what !== 'play'))

// a lost pointerup: no end() at all — each grain still stops itself
log.length = 0
scrub.begin()
advance(10000)
scrub.move(2)
advance(10005)
landAll()
advance(10005 + SCRUB_GRAIN_MS + 1)
check('a grain stops by itself after ~80 ms even with no end', [...els.values()].every((el) => el.paused),
  log.map((e) => `${e.key}:${e.what}@${e.at - 10000}`).join(' '))

// a clip's grain is not cut short by another clip's newer grain
log.length = 0
advance(20000)
scrub.move(3)
advance(20002); els.get('a').land()
advance(20004); els.get('b').land()
check('each voice keeps its own seek (one clip landing never cancels another)',
  log.filter((e) => e.what === 'play').length === 2, log.map((e) => e.key + e.what).join(' '))
scrub.end()

// ---- K12: a scrub voice sounds like playback — the clip's effects between the
// element and its gain, its pan into the track's bus (the track's effects, the
// strip's meter), the denoised copy once it exists. Fake WebAudio, real modules.
{
  const { installFakeWebAudio } = await import('./fake-webaudio.mjs')
  const fake = installFakeWebAudio()
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
  const asked = []
  globalThis.window = { kadr: { fileUrl: (p) => 'kadr://' + p, audioDenoise: (p, nr) => { asked.push([p, nr]); return Promise.resolve(`/cache/dn-${nr}.flac`) } } }
  globalThis.Audio = class { paused = true; play() { this.paused = false; return Promise.resolve() } pause() { this.paused = true } removeAttribute() { this.src = '' } load() {} }
  const live = buildSync({
    stdin: {
      contents: `export { scrub } from './src/engine/scrubAudio'
        export { workletReady } from './src/engine/audio'
        export { useEditor } from './src/state/store'`,
      resolveDir: root, loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  const L = await import('data:text/javascript;base64,' + Buffer.from(live).toString('base64'))
  await L.workletReady()
  const eq = { id: 'f1', type: 'eq', enabled: true, params: {} }
  const p = structuredClone(L.useEditor.getState().project)
  p.assets = [{ id: 'x', kind: 'audio', path: '/media/voice.wav', name: 'voice.wav', duration: 20, hasAudio: true }]
  const clip = (id, fx) => ({ id, kind: 'media', assetId: 'x', start: 0, duration: 10, inPoint: 0, outPoint: 10, speed: 1, gain: { value: 1 }, muted: false, transform: {}, audioFx: fx })
  p.tracks = [{ id: 'a1', kind: 'audio', name: 'A1', clips: [clip('c1', [eq, { id: 'f2', type: 'denoise', enabled: true, params: { nr: 12 } }])], muted: false, locked: false, gain: 1 }]
  L.useEditor.setState({ project: p })
  const drag = () => { L.scrub.begin(); L.scrub.move(2); L.scrub.end() }
  drag()
  await new Promise((r) => setTimeout(r, 0)) // the denoise build answers
  drag() // the next grain plays the copy
  const voices = fake.nodes.filter((n) => n.kind === 'source')
  const v = voices.at(-1)
  const first = [...v.out]
  check('a scrub voice goes through the clip\'s effects first (element → kadr-fx → gain)',
    first.length === 1 && first[0].kind === 'kadr-fx' && [...first[0].out][0]?.kind === 'gain',
    first.map((n) => n.kind).join(','))
  const bus = [...fake.reach(v)].filter((n) => n.kind === 'gain')
  check('…and into its track\'s bus, not straight to the master (gain → pan → bus → post → master)',
    bus.length >= 4, bus.length)
  check('the denoised copy is asked for and played once it exists',
    asked.length === 1 && asked[0][1] === 12 && v.el.src === 'kadr:///cache/dn-12.flac', `${JSON.stringify(asked)} ${v.el.src}`)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
