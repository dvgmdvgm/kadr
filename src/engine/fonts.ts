// Fonts for text clips (card F2): the project's kadr-lib/fonts (registered in
// this page, so the preview AND the export draw them — both paint the text in
// this page's canvas), the system's (`queryLocalFonts`), and a short fallback
// list for when the system refuses to list them.
import { fontFromFileName } from '@shared/fontName'
import { bumpFontEpoch } from './text'
import { logWarn } from './log'
import { useEditor } from '@/state/store'

export const FALLBACK_FONTS = [
  'sans-serif', 'serif', 'monospace',
  'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Impact'
]

const registered = new Map<string, Promise<unknown>>()

/** Register the project's kadr-lib/fonts (once per file); resolves when they
    have loaded. A face that finishes loading redraws every text layer. */
export async function registerLibFonts(projectPath: string | null): Promise<string[]> {
  if (!projectPath) return []
  const files = await window.kadr.libFonts(projectPath).catch(() => [] as string[])
  const fams = new Set<string>()
  await Promise.all(files.map((path) => {
    const [family, desc] = fontFromFileName(path.split(/[\\/]/).pop()!)
    fams.add(family)
    let p = registered.get(path)
    if (!p) {
      const face = new FontFace(family, `url("${window.kadr.fileUrl(path)}")`, desc)
      document.fonts.add(face)
      p = face.load().then(bumpFontEpoch, (e) => logWarn('fonts', 'font failed to load', { path, error: String(e) }))
      registered.set(path, p)
    }
    return p
  }))
  return [...fams].sort()
}

/** Everything a text clip's font list offers: project, system, fallback. */
export async function fontChoices(projectPath: string | null): Promise<{ project: string[]; system: string[] }> {
  const project = await registerLibFonts(projectPath)
  let system: string[] = []
  try {
    // needs a user gesture: called when the font list is opened
    const w = window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }
    if (w.queryLocalFonts) system = [...new Set((await w.queryLocalFonts()).map((f) => f.family))].sort((a, b) => a.localeCompare(b))
  } catch { /* permission refused or no API: the fallback list */ }
  return { project, system: system.length ? system : FALLBACK_FONTS }
}

/** The project's faces are registered when a project path is set (open, save as). */
export function wireFonts(): void {
  void registerLibFonts(useEditor.getState().projectPath)
  useEditor.subscribe((s, prev) => { if (s.projectPath !== prev.projectPath) void registerLibFonts(s.projectPath) })
}
