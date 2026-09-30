// Node-side check of shared/exportPresets.ts — the user's export presets
// (`userData/export-presets.json`, read back through sanitizeUserPresets) and
// the file-name template. No app.
//
// The bug this guards: the export dialog forgot everything on close, and a
// store read back blindly is one hand edit away from a dialog that throws.
// Costs: lost presets, or a broken export dialog.
// Run: node scripts/check-export-presets.mjs
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
  const src = readFileSync(join(root, 'shared', 'exportPresets.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/exportPresets.ts loads', false, String(err).split('\n')[0])
}
const { sanitizeUserPresets, userPreset, fileNameFrom } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const yt = {
  id: 'yt1080', name: 'YouTube 1080p (MP4 H.264)', container: 'mp4', codec: 'avc', ffmpegVideo: 'copy',
  width: 1920, height: 1080, fps: 'project', videoBitrate: 10_000_000, audioCodec: 'aac', audioBitrate: '192k'
}
const mp3 = { ...yt, id: 'mp3', name: 'MP3', container: 'mp3', audioCodec: 'libmp3lame', audioBitrate: '320k', audioOnly: true }
const builtinIds = [yt.id, mp3.id]

run('a user preset round-trips every job field', () => {
  const a = userPreset(yt, { motionBlur: false, frameBlending: true, fastEncoder: true }, 'Мой 1080', 'user-a')
  const b = userPreset(mp3, { motionBlur: true, frameBlending: false, fastEncoder: false }, 'Подкаст', 'user-b')
  const back = sanitizeUserPresets(JSON.parse(JSON.stringify([a, b])), builtinIds)
  const same = JSON.stringify(back) === JSON.stringify([a, b])
  // every field of the built-in it came from survives, plus the three render options
  const fields = [...Object.keys(yt), 'motionBlur', 'frameBlending', 'fastEncoder']
  const missing = fields.filter((k) => !(k in back[0]))
  check('a user preset round-trips every job field', same && !missing.length && back[0].id === 'user-a' &&
    back[0].name === 'Мой 1080' && back[0].fastEncoder === true && back[1].audioOnly === true,
    same ? `missing: ${missing.join(',')}` : JSON.stringify(back))
})

run('a broken file falls back to the built-ins', () => {
  const junk = [null, undefined, 42, 'x', {}, { presets: [] }, [1, 'a', null]]
  const bad = junk.map((j) => sanitizeUserPresets(j, builtinIds))
  check('a broken file falls back to the built-ins (no user presets, no throw)', bad.every((r) => Array.isArray(r) && r.length === 0),
    JSON.stringify(bad))
})

run('a broken entry is dropped, the good ones stay', () => {
  const good = userPreset(yt, { motionBlur: true, frameBlending: true, fastEncoder: false }, 'Ok', 'user-ok')
  const raw = [
    { ...good, width: 'huge' },
    { ...good, id: 'user-noname', name: '  ' },
    { ...good, id: 'yt1080' }, // may not shadow a built-in
    { ...good, id: 'user-c', container: 'avi' },
    { ...good, id: 'user-d', motionBlur: 'yes' },
    good,
    { ...good, name: 'dup' } // a second copy of the same id
  ]
  const r = sanitizeUserPresets(raw, builtinIds)
  check('a broken entry is dropped, the good ones stay', r.length === 1 && r[0].id === 'user-ok' && r[0].name === 'Ok',
    r.map((p) => p.id).join(','))
})

run('unknown fields are not carried', () => {
  const good = userPreset(yt, { motionBlur: true, frameBlending: true, fastEncoder: false }, 'Ok', 'user-ok')
  const r = sanitizeUserPresets([{ ...good, evil: '<script>' }], builtinIds)
  check('unknown fields are not carried', r.length === 1 && !('evil' in r[0]))
})

run('the file-name template', () => {
  const d = new Date(2026, 8, 3, 14, 5)
  const v = { project: 'Мой ролик', preset: 'YouTube 1080p (MP4 H.264)', date: d }
  const cases = [
    ['{project}', 'Мой ролик'],
    ['{project}_{preset}_{date}', 'Мой ролик_YouTube 1080p (MP4 H.264)_2026-09-03'],
    ['{project}: a/b\\c*?"<>|', 'Мой ролик_ a_b_c______'],
    ['', 'Мой ролик'],
    ['   ', 'Мой ролик'],
    ['{nope}-{project}', '{nope}-Мой ролик']
  ]
  const got = cases.map(([t]) => fileNameFrom(t, v))
  check('the file-name template fills {project} {preset} {date} and strips what a file name cannot hold',
    got.every((g, i) => g === cases[i][1]), JSON.stringify(got))
  check('an empty result falls back to «export»', fileNameFrom('{project}', { ...v, project: '' }) === 'export' &&
    fileNameFrom('...', v) === 'export', JSON.stringify([fileNameFrom('{project}', { ...v, project: '' }), fileNameFrom('...', v)]))
})

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
