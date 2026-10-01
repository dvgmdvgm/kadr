// Node-side check of «Собрать проект» and relative paths (card H8):
// shared/projectPaths.ts (every path a project holds; relative ↔ absolute;
// the collect plan) and electron/collect.ts (the plan against the disk, the
// copy). Real files in a temp folder, no app.
//
// Cost when wrong: a moved project full of black clips — a path kind the
// collect forgot, or a relative path resolved against the wrong folder.
// Run: node scripts/check-collect.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const load = async (entry) => {
  const js = buildSync({
    entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false,
    external: ['electron'], alias: { '@shared': join(root, 'shared') }, logLevel: 'silent'
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
let pp = {}, col = {}
try { pp = await load('shared/projectPaths.ts') } catch (err) { check('shared/projectPaths.ts loads', false, String(err).split('\n')[0]) }
try { col = await load('electron/collect.ts') } catch (err) { check('electron/collect.ts loads', false, String(err).split('\n')[0]) }
const run = async (name, fn) => { try { await fn() } catch (err) { check(name, false, String(err)) } }

const tmp = mkdtempSync(join(tmpdir(), 'kadr-collect-'))
const put = (p, content) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p }
const user = join(tmp, 'userData'), elsewhere = join(tmp, 'footage'), proj = join(tmp, 'Proj')
const projFile = join(proj, 'film.kadr')

// one of every path kind a project holds
const src = {
  media: put(join(elsewhere, 'a', 'clip.mp4'), 'AAAA'),
  twin: put(join(elsewhere, 'b', 'clip.mp4'), 'BBBBBB'),          // same name, other file
  reversed: put(join(user, 'reversed', 'clip-rev.mp4'), 'RRR'),
  download: put(join(user, 'imported', 'dl-1234.png'), 'PNG'),
  sequence: put(join(user, 'imported', 'shot_0001-seq.mp4'), 'SEQ'),
  voice: put(join(user, 'voice', 'take.flac'), 'VOICE'),
  script: put(join(user, 'voice', 'take.script.txt'), 'hello'),
  runDir: join(user, 'ttsqc-runs', 'take-ab12cd34'),
  srt: put(join(elsewhere, 'subs.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n'),
  inside: put(join(proj, 'already', 'logo.png'), 'LOGO'),
  proxy: put(join(user, 'proxies', 'k-540.mp4'), 'PX'),
  missing: join(elsewhere, 'gone.mov')
}
put(join(src.runDir, 'phrases.json'), '{}')
put(join(src.runDir, 'sub', 'patch0.flac'), 'P')

const asset = (id, path, extra = {}) => ({ id, path, name: id, kind: 'video', duration: 1, width: 1, height: 1, fps: 30, hasAudio: false, ...extra })
const project = {
  version: 1, id: 'p', name: 'film', width: 1920, height: 1080, fps: 30, background: '#000', tracks: [],
  assets: [
    asset('media', src.media, { proxyPath: src.proxy }),
    asset('twin', src.twin),
    asset('rev', src.reversed, { reverseOf: { assetId: 'media', start: 0, duration: 1 } }),
    asset('dl', src.download),
    asset('seq', src.sequence),
    asset('voice', src.voice),
    asset('inside', src.inside),
    asset('gone', src.missing)
  ],
  texts: [{ id: 't', name: 'subs', path: src.srt, format: 'srt' }],
  voiceRuns: [{ id: 'r', assetId: 'voice', scriptPath: src.script, scriptHash: 'x', runDir: src.runDir, duration: 1, tempo: 1, createdAt: 0 }]
}
const frozen = JSON.stringify(project)
const { projectPaths, mapPaths, saveRelative, loadResolved, relPath, absPath } = pp

// ── the card's test ─────────────────────────────────────────────────────────
await run('every path kind is copied and rewritten; paths inside the project are saved relative', async () => {
  const kinds = new Set(projectPaths(project).map((r) => r.kind))
  check('projectPaths names media, proxy, text, script and run paths', ['media', 'proxy', 'text', 'script', 'run'].every((k) => kinds.has(k)), [...kinds].join(','))

  const plan = await col.planCollect(project, projFile)
  const by = (p) => plan.items.find((i) => i.from === p)
  check('the plan copies media, reversed, downloads, sequences, voice-over, script, run folder and transcript',
    [src.media, src.twin, src.reversed, src.download, src.sequence, src.voice, src.script, src.runDir, src.srt].every((p) => by(p)?.action === 'copy'),
    JSON.stringify(plan.items.map((i) => [i.from.slice(tmp.length), i.action])))
  check('a file already inside the project folder is not copied', by(src.inside)?.action === 'inside')
  check('a missing file is reported, not copied', by(src.missing)?.action === 'missing')
  check('the proxy (a rebuildable cache) is not collected', !by(src.proxy))
  check('two files of one name get two names', by(src.media).to !== by(src.twin).to && /clip.*\.mp4$/.test(by(src.twin).to), `${by(src.media).to} / ${by(src.twin).to}`)
  check('the size to copy counts files and the run folder', plan.copyBytes === 4 + 6 + 3 + 3 + 3 + 5 + 5 + 2 + 1 + readFileSync(src.srt).length, String(plan.copyBytes))
  check('free space is reported', typeof plan.free === 'number' && plan.free > 0)

  const seen = []
  const map = await col.copyCollect(plan.items, (p) => seen.push(p))
  check('progress reaches the total', seen.length > 0 && seen.at(-1).done === plan.copyBytes, JSON.stringify(seen.at(-1)))
  for (const i of plan.items.filter((x) => x.action === 'copy')) {
    check(`copied: ${i.from.slice(tmp.length)}`, existsSync(i.to) && i.to.startsWith(join(proj, 'media')))
  }
  check('the run folder is copied whole', existsSync(join(map[src.runDir], 'sub', 'patch0.flac')))
  check('no .part left behind', !JSON.stringify(require_ls(join(proj, 'media'))).includes('.part'))

  const moved = mapPaths(project, (p) => map[p] ?? p)
  check('mapPaths leaves its input alone', JSON.stringify(project) === frozen)
  const a = Object.fromEntries(moved.assets.map((x) => [x.id, x]))
  check('every asset path is rewritten into the project', ['media', 'twin', 'rev', 'dl', 'seq', 'voice'].every((id) => a[id].path.startsWith(join(proj, 'media'))))
  check('the proxy path is left as it was', a.media.proxyPath === src.proxy)
  check('the missing asset keeps its path', a.gone.path === src.missing)
  check('the transcript, the script and the run are rewritten', moved.texts[0].path === map[src.srt] && moved.voiceRuns[0].scriptPath === map[src.script] && moved.voiceRuns[0].runDir === map[src.runDir])
  check('the rest of the asset survives the rewrite', a.rev.reverseOf?.assetId === 'media' && a.media.proxyPath === src.proxy)

  const onDisk = saveRelative(moved, projFile)
  const d = Object.fromEntries(onDisk.assets.map((x) => [x.id, x]))
  check('inside the folder → saved relative with forward slashes', d.media.path === 'media/clip.mp4' && d.inside.path === 'already/logo.png', `${d.media.path} · ${d.inside.path}`)
  check('the run folder and the transcript are relative too', onDisk.voiceRuns[0].runDir === 'media/take-ab12cd34' && onDisk.texts[0].path === 'media/subs.srt', `${onDisk.voiceRuns[0].runDir} · ${onDisk.texts[0].path}`)
  check('outside the folder → stays absolute', d.media.proxyPath === src.proxy && d.gone.path === src.missing)

  // the folder is copied elsewhere and opened there
  const there = join(tmp, 'Other machine', 'Proj copy', 'film.kadr')
  const back = loadResolved(JSON.parse(JSON.stringify(onDisk)), there)
  const b = Object.fromEntries(back.assets.map((x) => [x.id, x]))
  check('opened elsewhere, relative paths resolve against the new folder', b.media.path === join(dirname(there), 'media', 'clip.mp4') && b.inside.path === join(dirname(there), 'already', 'logo.png'), b.media.path)
  check('opened in place, the round trip is exact', JSON.stringify(loadResolved(onDisk, projFile)) === JSON.stringify(moved))

  const again = await col.planCollect(moved, projFile)
  check('collecting again copies nothing', again.copyBytes === 0 && again.items.every((i) => i.action !== 'copy'))

  // «только недостающее»: a new file joins; only it is copied, an equal file already in media/ is reused
  const fresh = put(join(elsewhere, 'new.mp4'), 'NEW!')
  put(join(proj, 'media', 'dup.mp4'), 'DUP')
  const dup = put(join(elsewhere, 'c', 'dup.mp4'), 'DUP')
  const more = { ...moved, assets: [...moved.assets, asset('new', fresh), asset('dup', dup)] }
  const p3 = await col.planCollect(more, projFile)
  check('only the missing file is copied; an equal one already collected is reused',
    p3.items.filter((i) => i.action === 'copy').map((i) => i.from).join() === fresh &&
    p3.items.find((i) => i.from === dup)?.action === 'reuse' && p3.items.find((i) => i.from === dup)?.to === join(proj, 'media', 'dup.mp4'),
    JSON.stringify(p3.items.filter((i) => i.action !== 'inside').map((i) => [i.from.slice(tmp.length), i.action])))
})

await run('a cancel stops between files and leaves no half file', async () => {
  const dir2 = join(tmp, 'Proj2')
  mkdirSync(dir2, { recursive: true })
  const plan = await col.planCollect(project, join(dir2, 'x.kadr'))
  const signal = { cancelled: false }
  let err = null
  await col.copyCollect(plan.items, (p) => { if (p.done > 0) signal.cancelled = true }, signal).catch((e) => { err = e })
  const left = readdirSync(join(dir2, 'media'))
  check('cancelled after the first file', String(err).includes('cancelled') && left.length === 1, left.join())
  check('no .part left', !left.some((n) => n.includes('.part')))
  check('the next plan reuses what was copied', (await col.planCollect(project, join(dir2, 'x.kadr'))).items.filter((i) => i.action === 'reuse').length === 1)
})

await run('J2: a clip\'s LUT travels with the project', async () => {
  const dir3 = join(tmp, 'Proj3'), file3 = join(dir3, 'x.kadr')
  const lutOut = put(join(elsewhere, 'looks', 'teal.cube'), 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')
  const lutIn = put(join(dir3, 'kadr-lib', 'luts', 'warm.cube'), 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')
  const clip = (id, path) => ({ id, lut: { path, intensity: { value: 1 } } })
  const p = { ...project, assets: [], texts: [], voiceRuns: [], tracks: [{ id: 'v', clips: [clip('a', lutOut), clip('b', lutIn), { id: 'c' }] }] }
  check('projectPaths names a clip\'s LUT', projectPaths(p).filter((r) => r.kind === 'lut').map((r) => r.path).join() === [lutOut, lutIn].join())
  const plan = await col.planCollect(p, file3)
  check('a LUT outside the folder is collected, one in kadr-lib/luts is already inside',
    plan.items.find((i) => i.from === lutOut)?.action === 'copy' && plan.items.find((i) => i.from === lutIn)?.action === 'inside')
  const map = await col.copyCollect(plan.items, () => {})
  const onDisk = saveRelative(mapPaths(p, (x) => map[x] ?? x), file3)
  const [a, b, c] = onDisk.tracks[0].clips
  check('the LUT paths are saved relative, the rest of the clip survives',
    a.lut.path === 'media/teal.cube' && b.lut.path === 'kadr-lib/luts/warm.cube' && a.lut.intensity.value === 1 && c.lut === undefined, `${a.lut.path} · ${b.lut.path}`)
  check('opened elsewhere, the LUT resolves against the new folder',
    loadResolved(JSON.parse(JSON.stringify(onDisk)), '/elsewhere/p/x.kadr').tracks[0].clips[1].lut.path === '/elsewhere/p/kadr-lib/luts/warm.cube')
})

await run('relative paths are portable between Windows and POSIX', () => {
  check('win: inside, any case', relPath('C:\\Work\\Proj\\media\\a.mp4', 'c:\\work\\proj') === 'media/a.mp4', relPath('C:\\Work\\Proj\\media\\a.mp4', 'c:\\work\\proj'))
  check('win: a sibling folder with the same prefix is outside', relPath('C:\\Work\\Proj2\\a.mp4', 'C:\\Work\\Proj') === 'C:\\Work\\Proj2\\a.mp4')
  check('posix: inside', relPath('/home/u/p/media/a.mp4', '/home/u/p') === 'media/a.mp4')
  check('posix: resolve', absPath('media/a.mp4', '/mnt/x/p') === '/mnt/x/p/media/a.mp4')
  check('win: resolve keeps backslashes', absPath('media/a.mp4', 'D:\\p') === 'D:\\p\\media\\a.mp4', absPath('media/a.mp4', 'D:\\p'))
  check('an absolute path from the other OS is never re-rooted', absPath('C:\\x\\a.mp4', '/home/u/p') === 'C:\\x\\a.mp4' && absPath('/x/a.mp4', 'D:\\p') === '/x/a.mp4')
  check('an unsaved project (no file) is left alone', saveRelative(project, null) === project)
})

function require_ls(dir) {
  const out = []
  const walk = (d) => { for (const n of readdirSyncSafe(d)) { const p = join(d, n); out.push(p); if (statSync(p).isDirectory()) walk(p) } }
  walk(dir)
  return out
}
function readdirSyncSafe(d) { try { return readdirSync(d) } catch { return [] } }

rmSync(tmp, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
