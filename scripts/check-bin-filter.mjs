// Node-side check of shared/binView.ts — what the media bin shows, in which
// order (card H4): search, sort, the «used» count and the unused filter. Both
// layouts (grid and list) render the same `binView` list. No app.
//
// Cost when wrong: assets that cannot be found — a search that misses «.MOV»,
// a sort that shuffles equal items on every click, a used count that says 0
// for footage on the timeline (and «Неиспользуемые» offers it for deletion).
// Run: node scripts/check-bin-filter.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'shared', 'binView.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/binView.ts loads', false, String(err).split('\n')[0])
}
const { binView, usageCounts, assetExt } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const A = (id, name, path, kind, duration) => ({ id, name, path, kind, duration, width: 0, height: 0, fps: 0, hasAudio: false })
const assets = [
  A('a', 'Interview.MOV', 'D:/f/Interview.MOV', 'video', 30),
  A('b', 'clip10.mp4', '/f/clip10.mp4', 'video', 5),
  A('c', 'music.wav', '/f/music.wav', 'audio', 120),
  A('d', 'clip2.mp4', '/f/clip2.mp4', 'video', 5),
  A('e', 'logo.png', '/f/logo.png', 'image', 0),
  A('f', 'intro', '/f/intro.mov', 'video', 12), // a name without its extension
  A('g', 'Beach 01.MP4', '/f/Beach 01.MP4', 'video', 5)
]
const ids = (l) => l.map((a) => a.id).join('')
const opts = (o = {}) => ({ query: '', sort: 'added', desc: false, unusedOnly: false, ...o })

run('search matches name and extension case-insensitively in both layouts; sort is stable', () => {
  const none = new Map()
  check('empty query keeps every asset in added order', ids(binView(assets, opts(), none)) === 'abcdefg')
  check('the extension of the path', assetExt(assets[5]) === 'mov' && assetExt(assets[0]) === 'mov')
  check('«mov» finds .MOV and a name without its extension', ids(binView(assets, opts({ query: 'mov' }), none)) === 'af')
  check('«.MP4» finds .mp4 and .MP4', ids(binView(assets, opts({ query: '.MP4' }), none)) === 'bdg')
  check('«INTER» finds Interview.MOV', ids(binView(assets, opts({ query: 'INTER' }), none)) === 'a')
  check('words must all match, in any order', ids(binView(assets, opts({ query: 'mp4 beach' }), none)) === 'g')
  check('surrounding spaces are ignored', ids(binView(assets, opts({ query: '  logo ' }), none)) === 'e')
  check('no match → empty', binView(assets, opts({ query: 'zzz' }), none).length === 0)

  const byDur = binView(assets, opts({ sort: 'duration' }), none)
  check('duration ascending, equal ones in added order', ids(byDur) === 'ebdgfac', ids(byDur))
  const byDurDesc = binView(assets, opts({ sort: 'duration', desc: true }), none)
  check('duration descending, equal ones STILL in added order', ids(byDurDesc) === 'cafbdge', ids(byDurDesc))
  const byName = binView(assets, opts({ sort: 'name' }), none)
  check('name: natural (clip2 before clip10), case-insensitive', ids(byName) === 'gdbafec', ids(byName))
  const byType = binView(assets, opts({ sort: 'type' }), none)
  check('type: video, image, audio; added order inside', ids(byType) === 'abdfgec', ids(byType))
  check('added descending = newest first', ids(binView(assets, opts({ desc: true }), none)) === 'gfedcba')
  const twice = binView(binView(assets, opts({ sort: 'duration' }), none), opts({ sort: 'duration' }), none)
  check('sorting a sorted list changes nothing', ids(twice) === ids(byDur))
  check('the input array is not reordered', ids(assets) === 'abcdefg')
})

run('the used count matches the clips on the timeline; a linked pair is one use', () => {
  const tracks = [
    { clips: [
      { id: '1', assetId: 'a', linkId: 'L1' },
      { id: '2', assetId: 'b' },
      { id: '3', assetId: 'b' },
      { id: '4', kind: 'text' } // no asset
    ] },
    { clips: [{ id: '5', assetId: 'a', linkId: 'L1' }, { id: '6', assetId: 'a', linkId: 'L2' }, { id: '7', assetId: 'c' }] }
  ]
  const uses = usageCounts(tracks)
  check('a: two placements (the A/V twin of one is not counted twice)', uses.get('a') === 2, String(uses.get('a')))
  check('b: two clips', uses.get('b') === 2)
  check('c: one', uses.get('c') === 1)
  check('unused ones are absent (0)', !uses.get('d'))
  check('«Неиспользуемые» keeps only assets with no clip', ids(binView(assets, opts({ unusedOnly: true }), uses)) === 'defg')
  check('unused + search', ids(binView(assets, opts({ unusedOnly: true, query: 'clip' }), uses)) === 'd')
})

console.log(fails ? `\n${fails} FAILED` : '\nall PASS')
process.exit(fails ? 1 : 0)
