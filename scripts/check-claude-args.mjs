// Node-side check of electron/claudeArgs.ts and electron/claude-plugin/ — how the
// panel's claude gets Kadr's skills. No app, no network, no claude session.
//
// The bug this guards: the skills used to be copied into ~/.claude/skills, so
// they were listed in EVERY claude session on the machine (and on a CRLF
// checkout the front-matter regex skipped all four, leaving a stale copy
// behind). Now they are a plugin passed with --plugin-dir to the panel's
// claude only; Kadr writes nothing into ~/.claude/skills and removes the
// copies it once put there (marked ones only).
// D3: the session options (claude.* settings) — extra args APPEND and never
// remove Kadr's flags; bypassPermissions cannot be configured by any route;
// claude.embedChats=false keeps the conversations out of the .kadr.
// Run: node scripts/check-claude-args.mjs
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync, build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'electron', 'claudeArgs.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/claudeArgs.ts loads', false, String(err).split('\n')[0])
}
const { claudeArgs, removeManagedSkills, splitArgs } = mod

// --- the panel's claude gets --plugin-dir and --mcp-config, and nothing is written to ~/.claude/skills
if (claudeArgs) {
  const a = claudeArgs({ mcpConfig: 'M.json', systemHint: 'HINT', pluginDir: 'P', chat: { resume: false, id: 'abc' } })
  const at = (flag) => a[a.indexOf(flag) + 1]
  check('--plugin-dir points at the plugin', at('--plugin-dir') === 'P', JSON.stringify(a))
  check('--mcp-config points at the generated config', at('--mcp-config') === 'M.json')
  check('--append-system-prompt carries the hint', at('--append-system-prompt') === 'HINT')
  check('a new chat gets --session-id', at('--session-id') === 'abc' && !a.includes('--resume'))
  const r = claudeArgs({ mcpConfig: 'M.json', systemHint: 'H', pluginDir: 'P', chat: { resume: true, id: 'xyz' } })
  check('a known chat gets --resume', r[r.indexOf('--resume') + 1] === 'xyz' && !r.includes('--session-id'))
  const o = claudeArgs({ mcpConfig: 'M.json', systemHint: 'H', pluginDir: 'P', replace: ['--foo'], extraArgs: ['--bar'], model: 'opus' })
  check('a legacy args replace (claude-env.json) still replaces everything', JSON.stringify(o) === '["--foo"]', JSON.stringify(o))

  // --- the session options (D3): each combination, exactly
  const base = { mcpConfig: 'M', systemHint: 'H', pluginDir: 'P' }
  const K = ['--mcp-config', 'M', '--plugin-dir', 'P', '--append-system-prompt', 'H']
  const table = [
    ['no options', {}, [...K]],
    ['model', { model: 'opus' }, [...K, '--model', 'opus']],
    ['empty model = the user default', { model: '' }, [...K]],
    ['permission default = no flag', { permissionMode: 'default' }, [...K]],
    ['permission plan', { permissionMode: 'plan' }, [...K, '--permission-mode', 'plan']],
    ['strict MCP', { strictMcp: true }, [...K, '--strict-mcp-config']],
    ['all, with a chat and extra args last', { model: 'sonnet', permissionMode: 'acceptEdits', strictMcp: true, chat: { resume: true, id: 'c1' }, extraArgs: ['--verbose'] },
      [...K, '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--resume', 'c1', '--verbose']]
  ]
  for (const [name, opts, want] of table) {
    const got = claudeArgs({ ...base, ...opts })
    check(`table: ${name}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  }

  // › "extra args never remove Kadr's own flags" — cost: the agent without tools or skills
  const x = claudeArgs({ ...base, chat: { resume: false, id: 'n' }, extraArgs: ['--verbose'] })
  check('extra args never remove Kadr\'s own flags',
    x.includes('--plugin-dir') && x.includes('--mcp-config') && x.includes('--session-id') && x.at(-1) === '--verbose', JSON.stringify(x))

  // › "bypass permissions cannot be configured" — the agent has a shell
  const bad = claudeArgs({ ...base, permissionMode: 'bypassPermissions',
    extraArgs: ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--permission-mode=bypassPermissions', '--allow-dangerously-skip-permissions', '--verbose'] })
  check('bypass permissions cannot reach the command line',
    !bad.some((s) => /bypass|dangerously/i.test(s)) && bad.at(-1) === '--verbose', JSON.stringify(bad))
}

if (splitArgs) {
  check('extra args are split like a shell line, quotes kept together',
    JSON.stringify(splitArgs(`--verbose  --add-dir "C:\\My Media" --x='a b'`)) === JSON.stringify(['--verbose', '--add-dir', 'C:\\My Media', '--x=a b']))
  check('an empty line is no args', splitArgs('   ').length === 0)
} else check('claudeArgs.ts exports splitArgs', false)

// --- the settings API refuses bypassPermissions
try {
  const out = await build({
    stdin: { contents: "export * from './electron/settings'", resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { '@shared': join(root, 'shared') }
  })
  const { openSettings } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
  const dir = mkdtempSync(join(tmpdir(), 'kadr-claude-set-'))
  const s = openSettings(dir, {}, () => {})
  await s.set({ 'claude.permissionMode': 'bypassPermissions' })
  const e = s.effective('claude.permissionMode')
  check('bypass permissions cannot be configured', e.value === 'default' && e.source === 'default', JSON.stringify(e))
  await s.set({ 'claude.permissionMode': 'plan' })
  check('an allowed mode is kept', s.effective('claude.permissionMode').value === 'plan')
  check('strict MCP is on and chats are embedded by default',
    s.effective('claude.strictMcp').value === true && s.effective('claude.embedChats').value === true)
  const env = openSettings(dir, { KADR_CLAUDE_CMD: 'stub' }, () => {})
  check('KADR_CLAUDE_CMD is the env source of claude.command', JSON.stringify(env.effective('claude.command')) === '{"value":"stub","source":"env"}')
  rmSync(dir, { recursive: true, force: true })
} catch (err) {
  check('the claude settings load', false, String(err).split('\n')[0])
}

// › "embedChats=false writes no transcripts into the .kadr"
{
  const cfg = mkdtempSync(join(tmpdir(), 'kadr-claude-cfg-'))
  mkdirSync(join(cfg, 'projects', 'x'), { recursive: true })
  const SECRET = 'my private prompt'
  writeFileSync(join(cfg, 'projects', 'x', 'c1.jsonl'), JSON.stringify({ type: 'user', message: { content: SECRET } }) + '\n')
  process.env.CLAUDE_CONFIG_DIR = cfg
  const src = readFileSync(join(root, 'electron', 'chats.ts'), 'utf8')
  const chats = await import('data:text/javascript;base64,' + Buffer.from(transformSync(src, { loader: 'ts', format: 'esm' }).code).toString('base64'))
  const p = { id: 'p', claudeChats: ['c1', 'gone'] }
  const on = JSON.stringify(await chats.withTranscripts(p))
  check('embedChats on (default) embeds the transcript', on.includes('my private prompt') && on.includes('claudeTranscripts'))
  const off = JSON.stringify(await chats.withTranscripts(p, false))
  check('embedChats=false writes no transcripts into the .kadr',
    !off.includes('my private prompt') && !off.includes('claudeTranscripts') && JSON.parse(off).claudeChats.join() === 'c1', off)
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(cfg, { recursive: true, force: true })
  const main = readFileSync(join(root, 'electron', 'main.ts'), 'utf8')
  // a call per line: H8 wrapped the project in saveRelative(…), whose ')' ended a [^)]* match early
  const calls = main.split('\n').filter((l) => /withTranscripts\(/.test(l)).map((l) => l.trim())
  check('both project writers pass the embedChats setting',
    calls.length === 2 && calls.every((c) => c.includes("'claude.embedChats'")), calls.join(' | '))
}

if (removeManagedSkills) {
  const skills = join(tmpdir(), `kadr-skills-${process.pid}`)
  rmSync(skills, { recursive: true, force: true })
  const put = (name, body) => { mkdirSync(join(skills, name), { recursive: true }); writeFileSync(join(skills, name, 'SKILL.md'), body) }
  put('kadr-editor', '---\r\nname: kadr-editor\r\n---\r\n<!-- managed by Kadr: rewritten -->\r\n')
  put('kadr-3d', '---\nname: kadr-3d\n---\n<!-- managed by Kadr: rewritten -->\n')
  put('kadr-mine', '---\nname: kadr-mine\n---\nmy own\n')
  put('other', '<!-- managed by Kadr -->\n')
  const removed = await removeManagedSkills(skills)
  const left = readdirSync(skills).sort()
  check('marked kadr-* copies are removed, everything else kept',
    JSON.stringify(left) === '["kadr-mine","other"]', `left ${left.join(',')}; removed ${removed}`)
  const missing = join(skills, 'nope')
  check('a missing skills folder is not created', (await removeManagedSkills(missing)).length === 0 && !existsSync(missing))
  rmSync(skills, { recursive: true, force: true })
}

// --- the plugin itself
const plugin = join(root, 'electron', 'claude-plugin')
const manifest = (() => { try { return JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) } catch { return null } })()
check('plugin.json names the plugin "kadr"', manifest?.name === 'kadr')
const want = ['3d', 'editor', 'motion', 'music']
const have = existsSync(join(plugin, 'skills')) ? readdirSync(join(plugin, 'skills')).sort() : []
check('the plugin ships the four skills', JSON.stringify(have) === JSON.stringify(want), have.join(','))
for (const name of have) {
  const md = readFileSync(join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
  check(`${name}: LF only, front matter names it`, !md.includes('\r') && new RegExp(`^---\\n[\\s\\S]*?^name: ${name}$`, 'm').test(md))
  const stale = md.match(/kadr-(editor|music|motion|3d)\b/g)
  check(`${name}: no reference to the old skill names`, !stale, stale?.join(','))
}
const ts = readFileSync(join(root, 'electron', 'claude.ts'), 'utf8')
check('claude.ts builds args with claudeArgs and the plugin dir', /claudeArgs\(/.test(ts) && ts.includes("'claude-plugin'"))
check('claude.ts no longer writes skills (no syncSkill)', !ts.includes('syncSkill') && !/kadr-(editor|music|motion|3d)\b/.test(ts))

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
