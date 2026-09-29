// How to run a tool of the fragment workspace, per platform — the ONE place
// that knows (npm, the vite dev server, remotion, tsc).
//
// On Windows `npm`/`npx` are .cmd shims that spawn() does not resolve without
// a shell, and since CVE-2024-27980 node refuses to spawn a .cmd without
// `shell: true` at all; `node_modules/.bin/*` are sh scripts, and there is no
// sh. So node runs each tool's own JS entry there, and npm goes through the
// shell (its argv is a constant). POSIX spawns exactly what it always did.
// Pure — no electron import — so scripts/check-toolspawn.mjs can test it.
import { join } from 'path'

export type WorkspaceTool = 'npm' | 'vite' | 'remotion' | 'tsc'
export interface ToolCommand { command: string; args: string[]; shell?: boolean }

/**
 * Kills the tool when the parent pid dies — orphaned children inherit
 * Electron's listening sockets and would block the next launch. Runs under
 * node on win32: MSYS `kill -0` cannot see Windows pids, so a sh watchdog
 * there killed vite at once. The tool is its child: stop both with a tree kill.
 */
const WIN_WATCHDOG =
  "const {spawn,execFileSync}=require('child_process');const [ppid,...a]=process.argv.slice(1);" +
  "const c=spawn(process.execPath,a,{stdio:'inherit',windowsHide:true});" +
  "const t=setInterval(()=>{try{process.kill(+ppid,0)}catch{clearInterval(t);" +
  "try{execFileSync('taskkill',['/pid',String(c.pid),'/T','/F'])}catch{}process.exit(0)}},3000);" +
  "c.on('exit',(code)=>{clearInterval(t);process.exit(code??1)})"

export function workspaceTool(
  tool: WorkspaceTool,
  args: string[],
  opts: { workspace: string; parentPid?: number; platform?: NodeJS.Platform }
): ToolCommand {
  const win = (opts.platform ?? process.platform) === 'win32'
  const nm = (...p: string[]) => join(opts.workspace, 'node_modules', ...p)
  switch (tool) {
    case 'npm':
      // one string: node deprecates (DEP0190) args passed alongside shell: true
      return win ? { command: ['npm', ...args].join(' '), args: [], shell: true } : { command: 'npm', args }
    case 'vite': {
      const ppid = String(opts.parentPid ?? process.pid)
      if (win) return { command: 'node', args: ['-e', WIN_WATCHDOG, ppid, nm('vite', 'bin', 'vite.js'), ...args] }
      // The bin runs directly (NOT via npx — npx makes vite a grandchild the
      // watchdog's kill couldn't reach).
      return {
        command: 'sh',
        args: ['-c',
          `"./node_modules/.bin/vite" ${args.join(' ')} & V=$!; ` +
          `(while kill -0 ${ppid} 2>/dev/null; do sleep 3; done; kill $V 2>/dev/null) & ` +
          'wait $V']
      }
    }
    case 'remotion':
      // the CLI's own entry: also spares npx's startup and its network probe
      return win
        ? { command: 'node', args: [nm('@remotion', 'cli', 'remotion-cli.js'), ...args] }
        : { command: 'npx', args: ['remotion', ...args] }
    case 'tsc':
      return win
        ? { command: 'node', args: [nm('typescript', 'bin', 'tsc'), ...args] }
        : { command: nm('.bin', 'tsc'), args }
  }
}
