import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { readdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import type { KadrApi, ExportProgress } from '@shared/types'
import { rawEncodeArgs, rawTempExt, isSeqFrame, ALPHA_MODE_HELP, knowsAlphaMode } from '@shared/rawEncode'
import { running, type SettingsSnapshot } from '@shared/settings'

// Direct export encoder: ffmpeg is spawned HERE, in the renderer process
// (sandbox is off), so raw frames go straight from JS memory into its stdin
// through one kernel pipe. Every cross-process route (IPC invoke, WebSocket)
// tops out near ~350 MB/s in Electron — ~20 ms of main-thread per 1080p
// frame, slower than the encode itself.
let rawEnc: ChildProcess | null = null
let rawEncErr = ''
let rawEncExit: Promise<void> | null = null
let rawOut = ''

// capability token for the kadr:// media protocol (issue #13). Sync on purpose:
// fileUrl must work from the renderer's very first frame.
const MEDIA_TOKEN: string = ipcRenderer.sendSync('media:token')

function dropSequence(pattern: string) {
  try {
    for (const f of readdirSync(dirname(pattern))) {
      if (isSeqFrame(pattern, f)) try { unlinkSync(join(dirname(pattern), f)) } catch { /* taken */ }
    }
  } catch { /* the folder went */ }
}

// K11: asked once per ffmpeg path, on the first transparent export (~1 s, sync)
const alphaModeOf = new Map<string, boolean>()
const alphaMode = (bin: string) => {
  if (!alphaModeOf.has(bin)) alphaModeOf.set(bin, knowsAlphaMode(spawnSync(bin, ALPHA_MODE_HELP, { encoding: 'utf8' }).stdout ?? ''))
  return alphaModeOf.get(bin)!
}

const api: KadrApi = {
  rawEncodeStart: (o) => {
    // the settings' ffmpeg (as at launch, env first) and export temp folder
    const snap: SettingsSnapshot = ipcRenderer.sendSync('settings:get')
    // a container that holds the codec; a PNG sequence brings its own numbered path
    const out = o.out ?? join(String(running('storage.tempDir', snap) || tmpdir()), `kadr-export-raw-${Date.now()}.${rawTempExt(o.codec)}`)
    const bin = String(running('tools.ffmpeg', snap))
    const child = spawn(bin, rawEncodeArgs({ ...o, out, alphaMode: !!o.alpha && alphaMode(bin) }), {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    rawEnc = child
    rawOut = out
    rawEncErr = ''
    child.stderr!.on('data', (c) => { rawEncErr += c })
    // a kill mid-frame is EPIPE here; the frame's write callback already reports it
    child.stdin!.on('error', () => { /* see rawEncodeFrame */ })
    rawEncExit = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        rawEnc = null
        if (code === 0) resolve()
        else reject(new Error(`raw encoder exited ${code}: ${rawEncErr.slice(0, 800)}`))
      })
    })
    rawEncExit.catch(() => { /* surfaced via frame/end */ })
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(out))
      child.once('error', (e) => { rawEnc = null; reject(e) })
    })
  },
  // with contextIsolation off the view arrives BY REFERENCE — zero copies;
  // resolve = ffmpeg's stdin accepted the memory, only then reuse the buffer
  rawEncodeFrame: (view) =>
    new Promise((resolve, reject) => {
      const stdin = rawEnc?.stdin
      if (!stdin || stdin.destroyed) {
        reject(new Error(`raw encoder gone: ${rawEncErr.slice(0, 300)}`))
        return
      }
      // The frame buffer is handed over BY REFERENCE (contextIsolation is
      // off exactly to avoid an 8 MB copy per frame) and the exporter reuses
      // it as soon as this promise resolves. `write()` returning true only
      // means "you may keep writing" — the chunk itself can still sit in the
      // stream's queue, still pointing at our buffer, so resolving on it let
      // the next frame overwrite data ffmpeg had not read yet: exports came
      // out with occasional TORN frames (half frame k, half frame k+2) and
      // no two runs were pixel-identical. The write callback fires only once
      // the chunk has actually been flushed to the pipe.
      stdin.write(view, (err) => (err ? reject(err) : resolve()))
    }),
  rawEncodeEnd: async () => {
    rawEnc?.stdin?.end()
    await rawEncExit
    rawEncExit = null
  },
  rawEncodeKill: () => {
    // a killed PNG sequence is not an export: its frames go once ffmpeg has let go of them
    const seq = rawOut.includes('%06d') ? rawOut : ''
    if (seq && rawEnc) rawEnc.once('close', () => dropSequence(seq))
    try { rawEnc?.kill('SIGKILL') } catch { /* gone */ }
    rawEnc = null
    rawEncExit = null
  },

  openMediaDialog: () => ipcRenderer.invoke('media:open-dialog'),
  openFolderDialog: () => ipcRenderer.invoke('media:open-folder-dialog'),
  scanMedia: (paths) => ipcRenderer.invoke('media:scan', paths),
  buildSequence: (run, fps) => ipcRenderer.invoke('media:sequence', run, fps),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  fileUrl: (path) => {
    // Windows paths (D:\dir\file) must become /D:/dir/file — a raw drive
    // letter glued after the host ('kadr://mediaD:\…') is an INVALID URL:
    // the element never loads and the preview spins forever (issue #6)
    const posix = path.replace(/\\/g, '/')
    const abs = posix.startsWith('/') ? posix : `/${posix}`
    // ?t= is the capability token gating the protocol (issue #13, see main.ts);
    // ? and # are escaped above, so the query can only be this one
    return `kadr://media${encodeURI(abs).replace(/[?#]/g, encodeURIComponent)}?t=${MEDIA_TOKEN}`
  },
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f) } catch { return '' }
  },
  downloadMedia: (url) => ipcRenderer.invoke('media:download', url),
  saveBlobMedia: (name, mime, data) => ipcRenderer.invoke('media:save-blob', name, mime, data),
  portalFiles: (key) => ipcRenderer.invoke('media:portal-files', key),
  clipboardMedia: () => ipcRenderer.invoke('media:clipboard-paste'),
  dropLog: (entry) => ipcRenderer.send('debug:drop-log', entry),

  saveProjectDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  readProject: (path) => ipcRenderer.invoke('project:read', path),
  writeProject: (path, project) => ipcRenderer.invoke('project:write', path, project),
  collectPlan: (project, path) => ipcRenderer.invoke('project:collect-plan', project, path),
  collectRun: (project, path) => ipcRenderer.invoke('project:collect-run', project, path),
  collectCancel: () => ipcRenderer.invoke('project:collect-cancel'),
  onCollectProgress: (cb) => {
    const handler = (_e: unknown, p: { done: number; total: number; file: string }) => cb(p)
    ipcRenderer.on('project:collect-progress', handler)
    return () => ipcRenderer.removeListener('project:collect-progress', handler)
  },
  autosaveProject: (project, mainPath) => ipcRenderer.invoke('project:autosave', project, mainPath),
  backupOffer: () => ipcRenderer.invoke('backup:offer'),
  revealBackup: (file) => ipcRenderer.invoke('backup:reveal', file),
  onCloseRequest: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:close-request', handler)
    ipcRenderer.send('app:close-guard')
    return () => ipcRenderer.removeListener('app:close-request', handler)
  },
  closeWindow: () => ipcRenderer.send('app:close'),
  onOpenProject: (cb) => {
    const handler = (_e: unknown, path: string) => cb(path)
    ipcRenderer.on('app:open-project', handler)
    void ipcRenderer.invoke('app:argv-project').then((p: string | null) => { if (p) cb(p) })
    return () => ipcRenderer.removeListener('app:open-project', handler)
  },

  storageScan: (projects, open) => ipcRenderer.invoke('storage:scan', projects, open),
  storagePrune: (req) => ipcRenderer.invoke('storage:prune', req),
  readUserStore: (name) => ipcRenderer.invoke('store:read', name),
  writeUserStore: (name, data) => ipcRenderer.invoke('store:write', name, data),
  listTemplates: () => ipcRenderer.invoke('template:list'),
  saveTemplate: (name, project) => ipcRenderer.invoke('template:save', name, project),
  settingsGet: () => ipcRenderer.sendSync('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  probeTool: (key, value) => ipcRenderer.invoke('settings:probe-tool', key, value),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  setZoom: (factor) => webFrame.setZoomFactor(factor),

  reverseMedia: (path, start, duration, info) =>
    ipcRenderer.invoke('media:reverse', path, start, duration, info),
  onReverseProgress: (cb) => {
    const handler = (_e: unknown, p: { path: string; start: number; duration: number; progress: number }) => cb(p)
    ipcRenderer.on('reverse:progress', handler)
    return () => ipcRenderer.removeListener('reverse:progress', handler)
  },
  requestProxy: (path, duration, opts) => ipcRenderer.invoke('proxy:request', path, duration, opts),
  requestDecoded: (path, duration, opts) => ipcRenderer.invoke('media:decoded', path, duration, opts),
  libFonts: (projectPath) => ipcRenderer.invoke('fonts:lib', projectPath),
  lutImport: (src, projectPath) => ipcRenderer.invoke('lut:import', src, projectPath),
  pickDirectory: (title) => ipcRenderer.invoke('dialog:pick-dir', title),
  saveSnapshot: (dir, baseName, png) => ipcRenderer.invoke('snapshot:save', dir, baseName, png),
  measureLoudness: (path, start, duration) => ipcRenderer.invoke('media:loudness', path, start, duration),
  meanVolume: (path, start, duration) => ipcRenderer.invoke('media:mean-volume', path, start, duration),
  detectScenes: (path, start, duration, threshold) => ipcRenderer.invoke('media:scenes', path, start, duration, threshold),
  audioEnvelope: (req) => ipcRenderer.invoke('audio:envelope', req),
  audioAnalyze: (req) => ipcRenderer.invoke('audio:analyze', req),
  soundLibrary: (rescan) => ipcRenderer.invoke('sounds:library', !!rescan),
  soundSetMeta: (id, meta) => ipcRenderer.invoke('sounds:set-meta', id, meta),
  onProxyProgress: (cb) => {
    const handler = (_e: unknown, p: { path: string; progress: number }) => cb(p)
    ipcRenderer.on('proxy:progress', handler)
    return () => ipcRenderer.removeListener('proxy:progress', handler)
  },

  exportDialog: (name, ext) => ipcRenderer.invoke('export:dialog', name, ext),
  hwEncoders: () => ipcRenderer.invoke('encoders:list'),
  exportBegin: (job) => ipcRenderer.invoke('export:begin', job),
  exportVideoChunk: (data, position) => ipcRenderer.invoke('export:video-chunk', data, position),
  exportRawBegin: (width, height, fps, outWidth, outHeight, alpha) =>
    ipcRenderer.invoke('export:raw-begin', width, height, fps, outWidth, outHeight, alpha),
  exportRawFrame: (data) => ipcRenderer.invoke('export:raw-frame', data),
  exportRawEnd: () => ipcRenderer.invoke('export:raw-end'),
  exportUseVideo: (path) => ipcRenderer.invoke('export:use-video', path),
  exportVideoDone: () => ipcRenderer.invoke('export:video-done'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  exportAwake: (on) => ipcRenderer.invoke('export:awake', on),
  exportReveal: (open) => ipcRenderer.invoke('export:reveal', open),
  onExportProgress: (cb) => {
    const handler = (_e: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },

  fragmentEnsure: () => ipcRenderer.invoke('fragment:ensure'),
  fragmentServer: () => ipcRenderer.invoke('fragment:server'),
  fragmentCreate: (spec, projectDir) => ipcRenderer.invoke('fragment:create', spec, projectDir),
  fragmentDelete: (id) => ipcRenderer.invoke('fragment:delete', id),
  fragmentRelocate: (projectDir, ids) => ipcRenderer.invoke('fragment:relocate', projectDir, ids),
  fragmentWriteFile: (id, name, content) => ipcRenderer.invoke('fragment:write-file', id, name, content),
  fragmentParamsWrite: (id, patch) => ipcRenderer.invoke('fragment:params-write', id, patch),
  fragmentCaptureStart: (id, url, w, h, fps) =>
    ipcRenderer.invoke('fragment:capture-start', id, url, w, h, fps),
  fragmentCaptureStop: (id) => ipcRenderer.invoke('fragment:capture-stop', id),
  fragmentCaptureSync: (id, msg) => ipcRenderer.send('fragment:capture-sync', id, msg),
  fragmentCaptureQuery: (id) => ipcRenderer.invoke('fragment:capture-query', id),
  onFragmentFrame: (cb) => {
    const handler = (_e: unknown, p: { id: string; w: number; h: number; data: Uint8Array }) => cb(p)
    ipcRenderer.on('fragment:frame', handler)
    return () => ipcRenderer.removeListener('fragment:frame', handler)
  },
  fragmentTypecheck: (id) => ipcRenderer.invoke('fragment:typecheck', id),
  probeBasic: (path) => ipcRenderer.invoke('media:probe-basic', path),
  statMany: (paths) => ipcRenderer.invoke('media:stat-many', paths),
  relinkScan: (folder, wanted) => ipcRenderer.invoke('media:relink-scan', folder, wanted),
  fragmentMedia: (path, projectDir, opts) => ipcRenderer.invoke('media:fragment-media', path, projectDir, opts),
  fragmentInspect: (id) => ipcRenderer.invoke('fragment:inspect', id),
  fragmentCollide: (id, step) => ipcRenderer.invoke('fragment:collide', id, step),
  modelImport: (path, projectDir, opts) => ipcRenderer.invoke('model:import', path, projectDir, opts),
  modelList: (projectDir) => ipcRenderer.invoke('model:list', projectDir),
  fragmentCaptureResize: (id, w, h) => ipcRenderer.invoke('fragment:capture-resize', id, w, h),
  onFragmentCaptureLog: (cb) => {
    const handler = (_e: unknown, p: { id: string; level: 'error' | 'warn'; msg: string }) => cb(p)
    ipcRenderer.on('fragment:capture-log', handler)
    return () => ipcRenderer.removeListener('fragment:capture-log', handler)
  },
  fragmentRender: (id, opts) => ipcRenderer.invoke('fragment:render', id, opts),
  fragmentCancelRender: () => ipcRenderer.invoke('fragment:cancel-render'),
  gpuGet: () => ipcRenderer.invoke('gpu:get'),
  gpuSet: (pref: string) => ipcRenderer.invoke('gpu:set', pref),
  gpuReport: (renderer: string) => ipcRenderer.invoke('gpu:report', renderer),
  onFragmentProgress: (cb) => {
    const handler = (_e: unknown, p: { id: string; phase: string; progress: number }) => cb(p)
    ipcRenderer.on('fragment:progress', handler)
    return () => ipcRenderer.removeListener('fragment:progress', handler)
  },

  ttsSpeakPhrase: (req) => ipcRenderer.invoke('tts:speak-phrase', req),
  voiceSplice: (req) => ipcRenderer.invoke('voice:splice', req),
  voiceSilenceAt: (path, at) => ipcRenderer.invoke('voice:silence-at', path, at),
  voiceVerdicts: (req) => ipcRenderer.invoke('voice:verdicts', req),
  voiceReindex: (req) => ipcRenderer.invoke('voice:reindex', req),
  voiceVersions: (req) => ipcRenderer.invoke('voice:versions', req),
  voiceLearn: (req) => ipcRenderer.invoke('voice:learn', req),
  voiceSelfTest: (python) => ipcRenderer.invoke('voice:selftest', python),
  voiceCheck: (req) => ipcRenderer.invoke('voice:check', req),
  voiceCheckCancel: () => ipcRenderer.invoke('voice:cancel'),
  voicePhraseAt: (req) => ipcRenderer.invoke('voice:phrase-at', req),
  onVoiceProgress: (cb) => {
    const handler = (_e: unknown, p: { progress: number; stage: string }) => cb(p)
    ipcRenderer.on('voice:progress', handler)
    return () => ipcRenderer.removeListener('voice:progress', handler)
  },

  ttsHasKey: () => ipcRenderer.invoke('tts:has-key'),
  ttsIsMock: () => ipcRenderer.invoke('tts:is-mock'),
  ttsSetKey: (key) => ipcRenderer.invoke('tts:set-key', key),
  ttsVoices: (proxy) => ipcRenderer.invoke('tts:voices', proxy),
  ttsSpeak: (req) => ipcRenderer.invoke('tts:speak', req),
  ttsCancel: () => ipcRenderer.invoke('tts:cancel'),
  onTtsProgress: (cb) => {
    const handler = (_e: unknown, p: { progress: number; stage: string; text?: string }) => cb(p)
    ipcRenderer.on('tts:progress', handler)
    return () => ipcRenderer.removeListener('tts:progress', handler)
  },

  transcribe: (req) => ipcRenderer.invoke('transcribe:run', req),
  transcribeCancel: () => ipcRenderer.invoke('transcribe:cancel'),
  speechPython: () => ipcRenderer.invoke('speech:python'),
  onTranscribeProgress: (cb) => {
    const handler = (_e: unknown, p: { progress: number; text: string }) => cb(p)
    ipcRenderer.on('transcribe:progress', handler)
    return () => ipcRenderer.removeListener('transcribe:progress', handler)
  },
  readTextFile: (path) => ipcRenderer.invoke('file:read-text', path),
  writeTextFile: (path, content) => ipcRenderer.invoke('file:write-text', path, content),
  statFile: (path) => ipcRenderer.invoke('file:stat', path),

  claudeOpen: (cols, rows, cwd, chatId) => ipcRenderer.invoke('claude:open', cols, rows, cwd, chatId),
  claudeChats: (ids) => ipcRenderer.invoke('claude:chats', ids),
  claudeInput: (data) => ipcRenderer.send('claude:input', data),
  claudeResize: (cols, rows) => ipcRenderer.send('claude:resize', cols, rows),
  claudeClose: () => ipcRenderer.invoke('claude:close'),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  revealClaudeEnv: () => ipcRenderer.send('claude:reveal-env'),
  onClaudeData: (cb) => {
    const handler = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on('claude:data', handler)
    return () => ipcRenderer.removeListener('claude:data', handler)
  },
  onClaudeExit: (cb) => {
    const handler = (_e: unknown, code: number) => cb(code)
    ipcRenderer.on('claude:exit', handler)
    return () => ipcRenderer.removeListener('claude:exit', handler)
  }
}

// contextIsolation is off (see main.ts: export frames pass by reference),
// so the api object lands on the shared window directly; the bridge branch
// keeps working if isolation is ever re-enabled.
if (process.contextIsolated) contextBridge.exposeInMainWorld('kadr', api)
else (globalThis as unknown as { kadr: KadrApi }).kadr = api
