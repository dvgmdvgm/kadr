// Node-side check of electron/toolSpawn.ts — how the fragment workspace's tools
// (npm, vite, remotion, tsc) are spawned per platform. No app, no network.
//
// The bug this guards: on Windows `spawn('npm')` / `spawn('npx')` → ENOENT (they
// are .cmd shims, and a .cmd needs a shell since CVE-2024-27980), `.bin/tsc` is
// an sh script, and the vite watchdog was `sh -c … kill -0 <winpid>` — so every
// fragment feature (captions, neon wave, 3D, exports with a fragment) was dead.
// Run: node scripts/check-toolspawn.mjs [workspace]
//   with a workspace that has node_modules, the entries are checked on disk too
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'electron', 'toolSpawn.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { workspaceTool } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const win = process.platform === 'win32'
const WS = join(tmpdir(), `kadr-toolspawn-${process.pid}`)
const run = (c, opts = {}) => spawnSync(c.command, c.args, { shell: c.shell, encoding: 'utf8', timeout: 60000, windowsHide: true, ...opts })

// --- on this platform every tool resolves to something spawnable --------------
const npm = run(workspaceTool('npm', ['-v'], { workspace: WS }))
check('npm -v spawns through the helper', npm.status === 0 && /^\d+\.\d+/.test(npm.stdout.trim()),
  npm.error ? String(npm.error) : npm.stdout.trim() || npm.stderr.trim())

if (win) {
  // "on win32 every workspace tool resolves to an executable command"
  for (const tool of ['vite', 'remotion', 'tsc']) {
    const c = workspaceTool(tool, ['--x'], { workspace: WS, platform: 'win32' })
    const entry = tool === 'vite' ? c.args[3] : c.args[0]
    check(`win32 ${tool}: node runs the JS entry, no shell, no .cmd, no sh`,
      c.command === 'node' && !c.shell && entry.startsWith(join(WS, 'node_modules')) && /\.js$|[\\/]tsc$/.test(entry),
      `${c.command} ${entry}`)
  }
  const ws = process.argv[2]
  if (ws && existsSync(join(ws, 'node_modules'))) {
    for (const tool of ['vite', 'remotion', 'tsc']) {
      const c = workspaceTool(tool, [], { workspace: ws })
      const entry = tool === 'vite' ? c.args[3] : c.args[0]
      check(`${tool}'s entry exists in ${ws}`, existsSync(entry), entry)
    }
    const v = run(workspaceTool('tsc', ['-v'], { workspace: ws }), { cwd: ws })
    check('tsc -v runs in the workspace', v.status === 0 && /Version/.test(v.stdout), v.stdout.trim() || v.stderr.trim())
  }
}

// --- POSIX spawns exactly what it always did -----------------------------------
const P = { workspace: '/w', platform: 'linux', parentPid: 42 }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
check('posix npm unchanged', same(workspaceTool('npm', ['install'], P), { command: 'npm', args: ['install'] }))
check('posix remotion unchanged', same(workspaceTool('remotion', ['render', 'x'], P), { command: 'npx', args: ['remotion', 'render', 'x'] }))
check('posix tsc unchanged', same(workspaceTool('tsc', ['-p', 'c'], P), { command: '/w/node_modules/.bin/tsc'.replace(/\//g, win ? '\\' : '/'), args: ['-p', 'c'] }))
check('posix vite watchdog unchanged', same(workspaceTool('vite', ['--port', '5621', '--strictPort'], P), {
  command: 'sh',
  args: ['-c', '"./node_modules/.bin/vite" --port 5621 --strictPort & V=$!; ' +
    '(while kill -0 42 2>/dev/null; do sleep 3; done; kill $V 2>/dev/null) & wait $V']
}))

// --- the vite watchdog: the server lives while its parent lives, dies with it --
// a stand-in vite that just stays up and reports its pid; a stand-in parent
mkdirSync(join(WS, 'node_modules', 'vite', 'bin'), { recursive: true })
mkdirSync(join(WS, 'node_modules', '.bin'), { recursive: true })
writeFileSync(join(WS, 'node_modules', 'vite', 'bin', 'vite.js'), 'console.log("pid", process.pid); setInterval(() => {}, 1000)')
writeFileSync(join(WS, 'node_modules', '.bin', 'vite'), '#!/bin/sh\necho pid $$\nexec sleep 60\n')
if (!win) chmodSync(join(WS, 'node_modules', '.bin', 'vite'), 0o755)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
const c = workspaceTool('vite', [], { workspace: WS, parentPid: parent.pid })
const dog = spawn(c.command, c.args, { cwd: WS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
dog.stdout.on('data', (d) => { out += d })
dog.stderr.on('data', (d) => { out += d })
let vitePid = 0
for (let i = 0; i < 50 && !vitePid; i++) { await sleep(100); vitePid = Number(out.match(/pid (\d+)/)?.[1] || 0) }
check('the watchdog starts vite', vitePid > 0, out.trim().slice(-200))
await sleep(3500)
check('vite stays up while its parent lives', vitePid > 0 && alive(vitePid))
parent.kill()
let gone = false
for (let i = 0; i < 80 && !gone; i++) { await sleep(100); gone = !alive(vitePid) }
check('vite dies within a watchdog tick of its parent', gone)
if (!gone && vitePid) try { process.kill(vitePid) } catch { /* gone */ }
dog.kill()
rmSync(WS, { recursive: true, force: true })

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
