// The panel's claude command line, and the cleanup of skills Kadr once copied
// into ~/.claude/skills. Pure (fs only, no electron) so
// scripts/check-claude-args.mjs can run it.
//
// Kadr's skills are a session plugin (electron/claude-plugin, name "kadr"):
// --plugin-dir loads them for the panel's claude only, as kadr:editor,
// kadr:music, kadr:motion and kadr:3d. They used to be copied into
// ~/.claude/skills, which listed them in every claude session on the machine.
import { promises as fs } from 'fs'
import { join } from 'path'

export interface ClaudeArgsInput {
  mcpConfig: string
  systemHint: string
  pluginDir: string
  /** a chat to resume, or the id a new one starts with; absent with a replace */
  chat?: { resume: boolean; id: string }
  /** settings `claude.*` (shared/settings.ts); empty model / 'default' mode add no flag */
  model?: string
  permissionMode?: string
  strictMcp?: boolean
  /** `claude.extraArgs`, split: APPENDED after Kadr's flags, never instead of them */
  extraArgs?: string[]
  /** legacy claude-env.json `args`: replaces everything (a wrapper that may not be claude) */
  replace?: string[]
}

/** extra-arg spellings that would switch permission checks off */
const isBypass = (s: string) =>
  /^--(allow-)?dangerously-skip-permissions$/.test(s) || /^--permission-mode=bypassPermissions$/.test(s)

export function claudeArgs(a: ClaudeArgsInput): string[] {
  if (a.replace) return a.replace
  const extra: string[] = []
  const x = a.extraArgs ?? []
  for (let i = 0; i < x.length; i++) {
    if (x[i] === '--permission-mode' && x[i + 1] === 'bypassPermissions') { i++; continue }
    if (!isBypass(x[i])) extra.push(x[i])
  }
  // the setting's enum (shared/settings.ts) already refuses it; never bypassPermissions: the agent has a shell
  const mode = a.permissionMode === 'bypassPermissions' ? undefined : a.permissionMode
  return [
    '--mcp-config', a.mcpConfig,
    '--plugin-dir', a.pluginDir,
    '--append-system-prompt', a.systemHint,
    ...(a.model ? ['--model', a.model] : []),
    ...(mode && mode !== 'default' ? ['--permission-mode', mode] : []),
    ...(a.strictMcp ? ['--strict-mcp-config'] : []),
    ...(a.chat ? [a.chat.resume ? '--resume' : '--session-id', a.chat.id] : []),
    ...extra
  ]
}

/** `claude.extraArgs` as typed in one line: spaces split, '…' and "…" group. */
export function splitArgs(line: string): string[] {
  return [...line.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map((m) => m[0].replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
}

/** the line every skill Kadr once copied carried — only such folders are removed */
const SKILL_MARK = '<!-- managed by Kadr'

/**
 * Remove the `kadr-*` folders in `root` (~/.claude/skills) whose SKILL.md
 * carries Kadr's mark: copies from the versions that synced skills globally.
 * A folder without the mark is the user's own and is never touched. Returns
 * the names removed.
 */
export async function removeManagedSkills(root: string): Promise<string[]> {
  const removed: string[] = []
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || !d.name.startsWith('kadr-')) continue
    const md = await fs.readFile(join(root, d.name, 'SKILL.md'), 'utf8').catch(() => '')
    if (!md.includes(SKILL_MARK)) continue
    await fs.rm(join(root, d.name), { recursive: true, force: true })
    removed.push(d.name)
  }
  return removed
}
