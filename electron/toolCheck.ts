// «Проверить» on the settings screen: runs a tool path the user typed (or the
// one found automatically when the field is empty) and reports its version line.
// A tool that does not answer in 10 s is reported as such — a hung network
// drive must not leave the row spinning.
import { execFile } from 'child_process'
import { pyLabel, type PyCmd } from './speechPython'
import { speechPython } from './transcribe'
import { pythonFor } from './voice'
import { setting } from './appSettings'
import type { ToolCheck } from '@shared/types'

const TIMEOUT_MS = 10000

function run(c: PyCmd, args: string[]): Promise<ToolCheck> {
  return new Promise((resolve) => {
    execFile(c.command, [...c.args, ...args], { timeout: TIMEOUT_MS, windowsHide: true }, (err, out, errOut) => {
      const full = `${out}\n${errOut}`.trim().split(/\r?\n/)[0] ?? ''
      if (err && !full) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean }
        return resolve({ ok: false, cmd: pyLabel(c), line: e.killed ? `no answer in ${TIMEOUT_MS / 1000} s` : String(e.code ?? e.message) })
      }
      // «ffmpeg version 2025-01-08-git-…-essentials_build-www.gyan.dev Copyright …» → up to the build hash
      const line = full.replace(/\s+Copyright.*$/, '').replace(/-(essentials|full)_build.*$/, '')
      resolve({ ok: !err, cmd: pyLabel(c), line, full })
    })
  })
}

export async function probeTool(key: string, value: string): Promise<ToolCheck> {
  const v = value.trim()
  if (key === 'tools.ffmpeg' || key === 'tools.ffprobe') {
    return run({ command: v || setting<string>(key), args: [] }, ['-version'])
  }
  if (key === 'tools.speechPython') {
    if (v) return run({ command: v, args: [] }, ['--version'])
    const r = await speechPython()
    if ('error' in r) return { ok: false, cmd: '', line: r.error }
    const c = await run(r, ['--version'])
    return { ...c, line: `${c.line} · ${r.device}` }
  }
  if (key === 'tools.detectorPython') return run(v ? { command: v, args: [] } : await pythonFor(), ['--version'])
  return { ok: false, cmd: '', line: `unknown tool ${key}` }
}
