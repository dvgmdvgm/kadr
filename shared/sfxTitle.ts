/**
 * A sound's readable name from its id: the bundled files are named like
 * `impactSoft_medium_000.ogg`, which the library showed as is. Words split at
 * `_`, `-` and camelCase, the number loses its padding, only the first word is
 * capitalised. A user's own sound keeps the name they gave the file.
 */
export function soundTitle(id: string): string {
  const base = id.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')
  if (id.startsWith('user:')) return base
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? String(Number(w)) : w.toLowerCase()))
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
