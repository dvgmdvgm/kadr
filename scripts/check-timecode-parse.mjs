// Node-side check of keyboard navigation (card E6): the go-to-timecode field's
// parser, the next/previous edit point, and the I/O/X, Ctrl+A and Ctrl+X store
// actions.
//
// Cost of getting it wrong: a jump to the wrong frame; Up/Down skipping an edit.
// Run: node scripts/check-timecode-parse.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = (entry) => buildSync({
  entryPoints: [join(root, ...entry)],
  bundle: true, format: 'esm', platform: 'neutral', write: false,
  mainFields: ['module', 'main'],
  alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
}).outputFiles[0].text
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
const load = (text) => import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
const { parseTimecode, formatTime, nextEdit, toFrame } = await load(bundle(['src', 'engine', 'timelineMath.ts']))
const { useEditor, newClipDefaults } = await load(bundle(['src', 'state', 'store.ts']))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!ok) fails++
}
const near = (a, b, e = 1e-9) => a !== null && Math.abs(a - b) < e
const ntsc = (k) => k * 1001 / 30000

// ---------------------------------------------------------------- the parser
{
  // what the display shows, typed back, is the same frame — every frame of 2 h
  for (const fps of [29.97, 30, 24, 25, 60, 23.976]) {
    const bad = []
    for (let k = 0; k < fps * 7200 && bad.length < 3; k += 7) {
      const t = toFrame(k / fps, fps)
      const back = parseTimecode(formatTime(t, fps), fps, 0)
      if (!near(back, t)) bad.push({ k, shown: formatTime(t, fps), back })
    }
    check(`absolute and relative timecodes parse at 29.97 and 30 fps: the display round-trips at ${fps}`, !bad.length, bad)
  }
  const cases = [
    // [text, fps, current, expected]
    ['00:00:01:00', 30, 0, 1],
    ['01:02:03:04', 30, 0, 3723 + 4 / 30],
    ['00:00:01:00', 29.97, 0, ntsc(30)],          // the frame the display calls 00:00:01.00
    ['00:01:00:00', 29.97, 0, ntsc(1799)],        // 1799·1001/30000 = 60.027 s, the first frame ≥ 60 s
    ['00:00:02.15', 30, 0, 2.5],                  // the display's own form
    ['2.15', 30, 0, 2.5],                         // ss.ff
    ['02:03', 30, 0, 2.1],                        // ss:ff
    ['1:02:03', 30, 0, 62.1],                     // mm:ss:ff
    ['12', 30, 0, 12],                            // bare seconds
    ['+2s', 30, 10, 12],
    ['+2s', 29.97, ntsc(300), toFrame(ntsc(300) + 2, 29.97)],
    ['-10f', 30, 10, 10 - 10 / 30],
    ['-10f', 29.97, ntsc(300), ntsc(290)],
    ['+1.5s', 24, 4, 5.5],
    ['+00:00:01:00', 30, 3, 4],
    ['-10f', 30, 0.1, 0],                         // never before 0
    ['90f', 30, 5, 3],
    [' 00:00:05:00 ', 30, 0, 5]
  ]
  for (const [text, fps, cur, want] of cases) {
    const got = parseTimecode(text, fps, cur)
    check(`"${text}" at ${fps} fps from ${cur.toFixed(3)} → ${want.toFixed(4)}`, near(got, want), got)
  }
  for (const text of ['', 'abc', '1:2:3:4:5', '00:00:01:30', '+', '5x', '1..2', '+-2s']) {
    check(`"${text}" is refused (null)`, parseTimecode(text, 30, 7) === null, parseTimecode(text, 30, 7))
  }
}

// ---------------------------------------------------------------- next / previous edit
{
  const tracks = [
    { id: 'v', locked: false, clips: [{ start: 0, duration: 3 }, { start: 3, duration: 3 }] },
    { id: 'a', locked: false, clips: [{ start: 1, duration: 4 }] },
    { id: 'l', locked: true, clips: [{ start: 2, duration: 5 }] }
  ]
  const walk = (t, dir) => { const out = []; for (let x = nextEdit(tracks, t, dir); x !== null; x = nextEdit(tracks, x, dir)) out.push(x); return out }
  check('Down stops at every clip edge of the unlocked tracks', JSON.stringify(walk(0, 1)) === '[1,3,5,6]', walk(0, 1))
  check('Up stops at every clip edge and at 0', JSON.stringify(walk(6, -1)) === '[5,3,1,0]', walk(6, -1))
  check('from between edges Down goes to the next one', nextEdit(tracks, 3.5, 1) === 5)
  check('from 0 Up has nowhere to go', nextEdit(tracks, 0, -1) === null)
}

// ---------------------------------------------------------------- store actions
const S = () => useEditor.getState()
const clip = (id, start, duration, extra = {}) => ({
  ...newClipDefaults(), id, assetId: 'x', start, duration, inPoint: 0, speed: 1,
  kind: 'media', label: id, ...extra
})
const project = () => ({
  ...S().project,
  fps: 30,
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1,
      clips: [clip('c1', 0, 3), clip('c2', 3, 3, { linkId: 'L' })] },
    { id: 'a1', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1,
      clips: [clip('c3', 3, 3, { linkId: 'L' })] },
    { id: 'lk', kind: 'video', name: 'V2', muted: false, locked: true, gain: 1,
      clips: [clip('c4', 0, 9)] }
  ]
})
const reset = (extra = {}) => useEditor.setState({ project: project(), past: [], future: [], selection: [], range: null, clipboard: [], playhead: 0, ...extra })
const clipsOf = (tid) => S().project.tracks.find((t) => t.id === tid).clips.map((c) => `${c.start}-${c.start + c.duration}`).join(',')

{
  reset({ playhead: 1.2 })
  S().markIn()
  check('I with no range marks in→end of the timeline', near(S().range?.start, 1.2) && near(S().range?.end, 9), S().range)
  S().setPlayhead(4); S().markOut()
  check('O keeps the in and sets the out', near(S().range?.start, 1.2) && near(S().range?.end, 4), S().range)
  S().setPlayhead(5); S().markIn()
  check('I past the out: the out goes to the end of the timeline', near(S().range?.start, 5) && near(S().range?.end, 9), S().range)
  reset({ playhead: 2 }); S().markOut()
  check('O with no range marks 0→out', near(S().range?.start, 0) && near(S().range?.end, 2), S().range)
  S().setPlayhead(1.23456); S().markIn()
  check('I lands on a frame', near(S().range?.start, 37 / 30), S().range)

  reset({ playhead: 4 }); S().markClip()
  check('X marks the clip under the playhead (top unlocked track)', near(S().range?.start, 3) && near(S().range?.end, 6), S().range)
  reset({ playhead: 3 }); S().markClip()
  check('X at a cut marks the clip that starts there', near(S().range?.start, 3) && near(S().range?.end, 6), S().range)
  reset({ playhead: 4, selection: ['c3'] }); S().markClip()
  check('X prefers the selected clip under the playhead', near(S().range?.start, 3), S().range)
  reset({ playhead: 7 }); S().markClip()
  check('X over nothing (only a locked clip) leaves the range alone', S().range === null, S().range)

  reset({ playhead: 0 }); S().goToEdit(1)
  check('Down moves the playhead to the next edit', S().playhead === 3, S().playhead)
  S().goToEdit(1); S().goToEdit(1)
  check('Down past the last edit stays', S().playhead === 6, S().playhead)
  S().goToEdit(-1); S().goToEdit(-1)
  check('Up walks back to 0', S().playhead === 0, S().playhead)

  reset(); S().selectAll()
  check('Ctrl+A selects every clip on the unlocked tracks', JSON.stringify([...S().selection].sort()) === '["c1","c2","c3"]', S().selection)
  S().select([])
  check('Ctrl+Shift+A deselects', S().selection.length === 0)

  reset({ selection: ['c1'] }); S().cut()
  check('Ctrl+X on a selection copies it and lifts it (no ripple)', S().clipboard.length === 1 && clipsOf('v1') === '3-6' && S().past.length === 1, { cb: S().clipboard.length, v1: clipsOf('v1'), past: S().past.length })
  S().undo()
  check('one undo restores the cut', clipsOf('v1') === '0-3,3-6')
  reset({ range: { start: 2, end: 4 } }); S().cut()
  // copyRange (Ctrl+C) copies a locked track's piece too; the lift leaves it in place
  check('Ctrl+X on a range copies its pieces and lifts it', S().clipboard.length === 4 && clipsOf('v1') === '0-2,4-6' && clipsOf('a1') === '4-6' && S().past.length === 1,
    { cb: S().clipboard.length, v1: clipsOf('v1'), a1: clipsOf('a1') })
  reset(); S().cut()
  check('Ctrl+X with nothing selected does nothing', S().past.length === 0 && S().clipboard.length === 0)
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
