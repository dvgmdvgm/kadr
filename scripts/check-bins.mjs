// Node-side check of shared/bins.ts — the media bin's folders (card H5):
// healing on load, moving, deleting, and the rows the bin draws. No app.
//
// Cost when wrong: media lost by tidying up — a folder delete that takes its
// assets with it, or a parentId cycle in a hand-edited .kadr that hides a
// whole subtree (and its footage) from the bin for good.
// Run: node scripts/check-bins.mjs
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
  const src = readFileSync(join(root, 'shared', 'bins.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/bins.ts loads', false, String(err).split('\n')[0])
}
const { healBins, dissolveBin, moveInto, binRows, newBinName } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const asset = (id, binId) => ({ id, path: `D:/m/${id}.mp4`, name: `${id}.mp4`, kind: 'video', duration: 1,
  width: 1, height: 1, fps: 30, hasAudio: false, ...(binId ? { binId } : {}) })
const proj = () => ({
  bins: [
    { id: 'A', name: 'Interview', parentId: null },
    { id: 'B', name: 'B-roll', parentId: null },
    { id: 'C', name: 'Drone', parentId: 'B' }
  ],
  assets: [asset('a1', 'A'), asset('a2', 'A'), asset('b1', 'B'), asset('c1', 'C'), asset('r1')]
})
const ids = (xs) => xs.map((x) => x.id).join(',')

run('deleting a folder never deletes assets', () => {
  const p = proj()
  dissolveBin(p, 'B')
  check('deleting a folder never deletes assets', p.assets.length === 5, ids(p.assets))
  check('  its assets move to the root', !('binId' in p.assets.find((a) => a.id === 'b1')))
  check('  its subfolder moves to the root, keeping its own assets',
    p.bins.find((b) => b.id === 'C')?.parentId === null && p.assets.find((a) => a.id === 'c1').binId === 'C')
  check('  other folders untouched', p.assets.find((a) => a.id === 'a1').binId === 'A' && p.bins.length === 2)
  const q = proj()
  dissolveBin(q, 'nope')
  check('  an unknown id changes nothing', JSON.stringify(q) === JSON.stringify(proj()))
})

run('a cycle in parentId is healed on load', () => {
  const p = {
    bins: [
      { id: 'X', name: 'x', parentId: 'Y' },
      { id: 'Y', name: 'y', parentId: 'Z' },
      { id: 'Z', name: 'z', parentId: 'X' },
      { id: 'S', name: 's', parentId: 'S' },
      { id: 'K', name: 'k', parentId: 'X' }
    ],
    assets: [asset('x1', 'X'), asset('k1', 'K')]
  }
  healBins(p)
  const roots = p.bins.filter((b) => b.parentId === null).map((b) => b.id)
  // every folder reaches the root by walking up
  const reaches = p.bins.every((b) => {
    const seen = new Set()
    let cur = b
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) return false
      seen.add(cur.id)
      cur = p.bins.find((x) => x.id === cur.parentId)
    }
    return !!cur
  })
  check('a cycle in parentId is healed on load', reaches && roots.length === 2, `roots ${roots}`)
  check('  a self-parent is a root', p.bins.find((b) => b.id === 'S').parentId === null)
  check('  no folder or asset lost', p.bins.length === 5 && p.assets.every((a) => a.binId))
  const rows = binRows(p.bins, p.assets, p.assets, { collapsed: new Set(), filtering: false })
  check('  after healing every asset is on a row', rows.filter((r) => r.kind === 'asset').length === 2)
})

run('healing junk', () => {
  const p = {
    bins: [null, { id: 'A', name: 'a', parentId: 'gone' }, { id: 'A', name: 'dup', parentId: null },
      { id: 7, name: 'n' }, { id: 'N', name: '   ', parentId: undefined }, 'x'],
    assets: [asset('a1', 'A'), asset('g1', 'gone'), { ...asset('n1'), binId: 5 }]
  }
  healBins(p)
  check('junk folders dropped, the first of a duplicate id kept', ids(p.bins) === 'A,N' && p.bins[0].name === 'a')
  check('  an unknown parent is the root', p.bins[0].parentId === null && p.bins[1].parentId === null)
  check('  an empty name gets one', typeof p.bins[1].name === 'string' && p.bins[1].name.trim().length > 0)
  check('  an asset in a missing folder goes to the root',
    !('binId' in p.assets[1]) && !('binId' in p.assets[2]) && p.assets[0].binId === 'A')
  const q = { assets: [asset('a1', 'Z')] }
  healBins(q)
  check('  a project without bins gets [] and root assets', Array.isArray(q.bins) && !('binId' in q.assets[0]))
})

run('move', () => {
  const p = proj()
  check('assets move into a folder', moveInto(p, ['r1', 'a1'], [], 'C') &&
    p.assets.find((a) => a.id === 'r1').binId === 'C' && p.assets.find((a) => a.id === 'a1').binId === 'C')
  check('  and back to the root', moveInto(p, ['r1'], [], null) && !('binId' in p.assets.find((a) => a.id === 'r1')))
  check('  a folder never goes into itself or its own subfolder',
    !moveInto(p, [], ['B'], 'C') && !moveInto(p, [], ['B'], 'B') && p.bins.find((b) => b.id === 'B').parentId === null)
  check('  a folder moves into another', moveInto(p, [], ['A'], 'C') && p.bins.find((b) => b.id === 'A').parentId === 'C')
  check('  a no-op move reports no change', !moveInto(p, ['c1'], [], 'C'))
})

run('rows', () => {
  const p = proj()
  const all = p.assets
  const open = binRows(p.bins, all, all, { collapsed: new Set(), filtering: false })
  const seq = open.map((r) => (r.kind === 'bin' ? `[${r.bin.name}:${r.depth}:${r.count}]` : `${r.asset.id}:${r.depth}`)).join(' ')
  check('folders first (natural name order), then the root assets, children indented',
    seq === '[B-roll:0:2] [Drone:1:1] c1:2 b1:1 [Interview:0:2] a1:1 a2:1 r1:0', seq)
  const shut = binRows(p.bins, all, all, { collapsed: new Set(['B']), filtering: false })
  check('  a collapsed folder hides its subtree', shut.map((r) => r.kind === 'bin' ? r.bin.id : r.asset.id).join(',') ===
    'B,A,a1,a2,r1')
  // the shown list is binView's order: it is kept inside each folder
  const shown = [all[4], all[1], all[0]]
  const f = binRows(p.bins, shown, all, { collapsed: new Set(['A']), filtering: true })
  check('  while filtering: only folders holding a match, open, in the shown order',
    f.map((r) => r.kind === 'bin' ? r.bin.id : r.asset.id).join(',') === 'A,a2,a1,r1')
})

run('names', () => {
  const p = proj()
  check('new folder names count up', newBinName(p.bins, 'Interview') === 'Interview 2' &&
    newBinName(p.bins, 'Папка') === 'Папка')
})

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
