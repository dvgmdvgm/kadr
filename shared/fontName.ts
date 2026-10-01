/**
 * Family and descriptors from a font FILE name, the kadr-lib/fonts
 * convention: "Inter.woff2" → Inter (any weight — variable fonts),
 * "Inter-700.woff2" → Inter 700, "Inter-400-italic.ttf" → Inter 400 italic.
 * The same function lives in electron/fragment-kit/runtime.ts (a file copied
 * into the fragment workspace, which cannot import this one) — change both;
 * scripts/check-text-layout.mjs pins the convention.
 */
export function fontFromFileName(file: string): [string, { weight: string; style?: string }] {
  const base = file.replace(/\.[^.]+$/, '')
  const m = base.match(/^(.+?)(?:[-_ ](\d{3}))?(?:[-_ ](italic))?$/i)
  const family = m?.[1] ?? base
  const desc: { weight: string; style?: string } = { weight: m?.[2] ?? '100 900' }
  if (m?.[3]) desc.style = 'italic'
  return [family, desc]
}

/** A font file in kadr-lib/fonts. */
export const FONT_FILE = /\.(woff2?|ttf|otf)$/i
