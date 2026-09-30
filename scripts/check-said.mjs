// Main's errors in the UI language (card H9): main throws `saidError(key,
// args)` (shared/said.ts) instead of a Russian literal, Electron wraps it as
// «Error invoking remote method 'x': Error: <mark>{json}», and the renderer's
// window.kadr wrapper (`speakMainErrors`, src/i18n.ts) says it in the UI
// language. Cost of getting it wrong: the English UI showing Russian errors
// again, or a bare key/JSON blob where a sentence should be.
// Run: node scripts/check-said.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = buildSync({
  stdin: {
    contents: "export * from './src/i18n'; export { said, saidError } from './shared/said'; export { useSettings } from './src/state/store'",
    resolveDir: root, loader: 'ts'
  },
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
const { spoken, speakMainErrors, said, saidError, useSettings } = await import(
  'data:text/javascript;base64,' + Buffer.from(out).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const lang = (l) => useSettings.setState({ lang: l })

// what an IPC rejection's message looks like once Electron has wrapped it
const ipc = (e) => `Error invoking remote method 'tts:voices': Error: ${e.message}`
const unreachable = saidError('eTtsUnreachable', { via: { key: 'eTtsViaProxy', args: { proxy: 'http://p:1' } }, msg: 'ECONNRESET' })

lang('en')
check('a nested Said inside an IPC error reads in English',
  spoken(ipc(unreachable)) === 'ElevenLabs is unreachable (via proxy http://p:1): ECONNRESET', spoken(ipc(unreachable)))
lang('ru')
check('… and in Russian with the Russian UI',
  spoken(ipc(unreachable)) === 'ElevenLabs недоступен (через прокси http://p:1): ECONNRESET', spoken(ipc(unreachable)))
lang('en')
check('a warning string (no IPC wrap) with a number arg',
  spoken(said('eTtsInnerPause', { s: '0.82' })) === 'a 0.82 s pause inside the phrase')
check('plain text passes through untouched', spoken('ffmpeg exited 1') === 'ffmpeg exited 1')
check('an unknown key reads as the key, never as JSON', spoken(said('noSuchKey')) === 'noSuchKey')

// the window.kadr wrapper: rejections are said, other results untouched
const plain = new Error('plain')
globalThis.kadr = {
  failSaid: () => Promise.reject(new Error(ipc(saidError('eMdStl')))),
  failPlain: () => Promise.reject(plain),
  ok: () => Promise.resolve(7),
  sync: (a) => a + 1,
  n: 5
}
speakMainErrors()
const k = globalThis.kadr
const r1 = await k.failSaid().then(() => null, (e) => e)
check('a rejected call carries the sentence in the UI language', r1?.message === 'STL: could not read the triangles', r1?.message)
const r2 = await k.failPlain().then(() => null, (e) => e)
check('an error without a Said is rethrown as it was', r2 === plain)
check('resolved and synchronous results and non-functions are untouched',
  (await k.ok()) === 7 && k.sync(1) === 2 && k.n === 5)

// I12: the Python driver says its failures the same way — a Said on its last
// stderr line, after whatever Python printed before it (no models are loaded)
const { spawnSync } = await import('child_process')
const { mkdtempSync, writeFileSync } = await import('fs')
const { tmpdir } = await import('os')
const py = process.env.KADR_TTSQC_PYTHON || process.env.KADR_PYTHON || 'python'
// the env main spawns it with (electron/voice.ts): utf-8 pipes, whatever the system code page
const drv = (...a) => spawnSync(py, [join(root, 'scripts', 'ttsqc_run.py'), ...a], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
if (spawnSync(py, ['--version']).status !== 0) {
  console.log(`SKIP  the Python driver rows — no working ${py}`)
} else {
  const run = mkdtempSync(join(tmpdir(), 'kadr-said-'))
  const bad = drv('check', '--bogus')
  const none = drv()
  const noIdx = drv('phrase-at', '--run-dir', run, '--start', '0', '--end', '1')
  writeFileSync(join(run, 'phrase-index.json'), JSON.stringify({ duration: 10 }))
  const other = drv('phrase-at', '--run-dir', run, '--start', '0', '--end', '1', '--audio-duration', '5')
  // what main's runDriver rejects with, as the page's window.kadr wrapper sees it
  const said = (r) => spoken(`Error invoking remote method 'voice:phrase-at': Error: ${r.stderr.trim()}`)
  lang('en')
  check('driver: bad arguments read in English', /^the voice-over detector refused its arguments: the following arguments are required/.test(said(bad)), said(bad))
  check('driver: no command reads in English', said(none) === 'the voice-over detector needs a command: --selftest, check, learn or phrase-at', said(none))
  check('driver: a run without an analysis reads in English', said(noIdx) === 'the run has no analysis — analyse the voice-over again', said(noIdx))
  check('driver: another version of the audio reads in English',
    said(other) === 'the analysis belongs to another version of the voice-over (10.000 s vs 5.000 s on the timeline) — run the defect check again and the marks will land exactly', said(other))
  lang('ru')
  check('driver: … and in Russian with the Russian UI', said(noIdx) === 'в прогоне нет разбора — переразберите озвучку' &&
    /^детектор озвучки не принял аргументы: /.test(said(bad)), `${said(noIdx)} | ${said(bad)}`)
  check('driver: the exit codes are kept (2 for arguments, 1 for a failure)', bad.status === 2 && none.status === 2 && noIdx.status === 1,
    `${bad.status} ${none.status} ${noIdx.status}`)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
