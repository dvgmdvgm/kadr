// Node-side check of the main-side settings store (shared/settings.ts, the
// schema; electron/settings.ts, `userData/settings.json`). No app.
//
// The bug this guards: settings lived in the renderer's localStorage (main
// could not read them, and the profile lock could lose a write), or in
// env-only / hand-edited knobs nobody could see. Costs: a broken settings
// file that stops the editor from starting; a file full of defaults that
// freezes today's defaults for good; an env override the user cannot see.
// Run: node scripts/check-settings.mjs
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const out = await build({
    stdin: {
      contents: "export * from './electron/settings'\nexport * from './shared/settings'",
      resolveDir: root, loader: 'ts'
    },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { '@shared': join(root, 'shared') }
  })
  mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
} catch (err) {
  check('electron/settings.ts + shared/settings.ts load', false, String(err).split('\n')[0])
}
const { openSettings, SETTINGS, fromLegacy } = mod
const fresh = () => mkdtempSync(join(tmpdir(), 'kadr-settings-'))
const file = (d) => join(d, 'settings.json')

if (openSettings) {
  // › a broken settings file never blocks startup
  for (const [what, body] of [['garbage', '{"general.lang": "en",'], ['an array', '[1,2]'], ['empty', '']]) {
    const d = fresh()
    writeFileSync(file(d), body)
    const warns = []
    let s = null
    try { s = openSettings(d, {}, (m) => warns.push(m)) } catch (err) { check(`${what}: opening does not throw`, false, String(err)) }
    check(`a broken settings file (${what}) starts with defaults and one warning`,
      !!s && s.effective('general.lang').value === 'ru' && s.effective('general.lang').source === 'default' && warns.length === 1,
      `${warns.length} warnings: ${warns.join(' | ')}`)
  }
  {
    const d = fresh()
    writeFileSync(file(d), JSON.stringify({ 'general.lang': 'fr', 'editing.trackHeight': 900, 'editing.snapBeats': false, 'nope.key': 1 }))
    const warns = []
    const s = openSettings(d, {}, (m) => warns.push(m))
    check('a bad value is healed, the good ones survive',
      s.effective('general.lang').value === 'ru' && s.effective('editing.trackHeight').value === 140 &&
      s.effective('editing.snapBeats').value === false && warns.length === 1,
      JSON.stringify(s.snapshot().user) + ' / ' + warns.join(' | '))
  }
  {
    const d = fresh()
    const s = openSettings(d, {}, () => {})
    check('no file at all: defaults, no warning, nothing written', s.effective('editing.snapBeats').value === true && !existsSync(file(d)))
  }

  // › only differences from the defaults are written
  {
    const d = fresh()
    const s = openSettings(d, {}, () => {})
    await s.set({ 'general.lang': 'en', 'editing.trackHeight': 56, 'editing.snapBeats': true })
    const onDisk = JSON.parse(readFileSync(file(d), 'utf8'))
    check('only differences from the defaults are written', JSON.stringify(onDisk) === '{"general.lang":"en"}', JSON.stringify(onDisk))
    await s.set({ 'general.lang': 'ru' })
    check('setting a value back to its default removes it from the file', readFileSync(file(d), 'utf8').trim() === '{}')
    await s.set({ 'editing.trackHeight': 80 })
    await s.set({ 'editing.trackHeight': null })
    check('null resets a key to its default', s.effective('editing.trackHeight').source === 'default')
    await s.set({ 'editing.confirmDelete': false, 'bogus.key': 3, 'general.lang': 42 })
    check('unknown keys and wrong types are refused, not written',
      JSON.stringify(JSON.parse(readFileSync(file(d), 'utf8'))) === '{"editing.confirmDelete":false}')
    // survives a restart: a second store over the same folder reads it back
    const again = openSettings(d, {}, () => {})
    check('a setting changed through the API survives a restart',
      again.effective('editing.confirmDelete').value === false && again.effective('editing.confirmDelete').source === 'user')
    const writes = []
    for (let i = 0; i < 20; i++) writes.push(s.set({ 'editing.trackHeight': 40 + i }))
    await Promise.all(writes)
    check('concurrent writes land in order (the last one wins on disk)',
      JSON.parse(readFileSync(file(d), 'utf8'))['editing.trackHeight'] === 59)
    rmSync(d, { recursive: true, force: true })
  }

  // › an env variable wins and is reported as the source
  {
    const d = fresh()
    writeFileSync(file(d), JSON.stringify({ 'tools.ffmpeg': 'C:/mine/ffmpeg.exe' }))
    const s = openSettings(d, { KADR_FFMPEG: 'D:/env/ffmpeg.exe' }, () => {})
    const e = s.effective('tools.ffmpeg')
    check('an env variable wins and is reported as the source', e.value === 'D:/env/ffmpeg.exe' && e.source === 'env', JSON.stringify(e))
    check('the user value under an env override is still the file\'s', s.snapshot().user['tools.ffmpeg'] === 'C:/mine/ffmpeg.exe')
    check('the snapshot carries the env value for the renderer', s.snapshot().env['tools.ffmpeg'] === 'D:/env/ffmpeg.exe')
    const s2 = openSettings(d, {}, () => {})
    check('without the variable the user value is effective', s2.effective('tools.ffmpeg').source === 'user')
    check('every env knob in the schema names its variable',
      SETTINGS['tools.ffmpeg'].env === 'KADR_FFMPEG' && SETTINGS['tools.ffprobe'].env === 'KADR_FFPROBE')
  }

  // the localStorage values being migrated parse as they did in store.ts
  check('legacy localStorage values parse like the old store',
    fromLegacy('editing.snapBeats', '0') === false && fromLegacy('editing.snapBeats', '1') === true &&
    fromLegacy('editing.trackHeight', '999') === 140 && fromLegacy('editing.trackHeight', 'x') === undefined &&
    fromLegacy('general.lang', 'en') === 'en' && fromLegacy('general.lang', 'de') === undefined)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
