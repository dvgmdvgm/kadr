import { createHash } from 'crypto'
import { HDR_VERSION } from '@shared/hdr'

/**
 * The identity of a cached artefact derived from a media file.
 *
 * Proxies, decoded intermediates and reversed renders all name themselves this
 * way: the source path, its size and its mtime, hashed. That is what makes the
 * caches safe to delete — the same source produces the same name again, so a
 * wiped proxy is rebuilt under the name the project already points at.
 *
 * It lives in its own file because the storage panel has to compute these
 * names too, in order to say WHICH project an anonymous 20-hex file belongs
 * to. A second copy of this formula would drift, and a drifted formula would
 * label a live cache entry as orphaned — which is a delete button pointed at
 * the wrong file.
 */
export function mediaCacheKey(
  srcPath: string,
  size: number,
  mtimeMs: number,
  suffix = ''
): string {
  return createHash('sha1')
    .update(`${srcPath}:${size}:${Math.round(mtimeMs)}${suffix}`)
    .digest('hex')
    .slice(0, 20)
}

/** a project's folder of backups (electron/backups.ts): BY PATH, never by name —
    a user's projects are routinely all called "Untitled" (see storage.ts) */
export const projectKey = (projectPath: string): string =>
  createHash('sha1').update(projectPath).digest('hex').slice(0, 20)

/** proxies: an alpha proxy is a different artefact (webm), so a different key;
    an HDR source's proxy is tone-mapped to SDR (shared/hdr.ts) — ':sdr' plus
    the conversion's generation, so neither a proxy built before that existed
    nor one made with an older curve is taken for the current one; ':c' = tagged with
    its source's colour space (J11) — an untagged proxy showed an HD source BT.601 */
const SDR = `:sdr${HDR_VERSION > 1 ? HDR_VERSION : ''}`
export const proxySuffix = (alpha?: boolean, sdr?: boolean) => (alpha ? ':a' : (sdr ? SDR : '') + ':c')

/** decoded: packed colour+matte, plain alpha, an HDR source tone-mapped, or none of these;
    ':p2' = J12's pack (matte in range once, gaps, full tags) — ':p' ones exported 0.92× dark */
export const decodedSuffix = (opts?: { alpha?: boolean; packed?: boolean; sdr?: boolean }) =>
  opts?.packed ? ':p2' : opts?.alpha ? ':a' : opts?.sdr ? SDR : ''

/** K9: a denoised copy, `<key>-<nr>.flac`: the key is the source's alone, so the
    storage panel ties every strength of it to the project (the part after '-'
    is afftdn's `nr`, dB — another strength is another file) */
export const DENOISE_SUFFIX = ':dn'
export const denoiseName = (key: string, nr: number) => `${key}-${+nr.toFixed(2)}`

/** reversed: the same source cut differently is a different render */
export const reverseSuffix = (start: number, duration: number) =>
  `:${start.toFixed(3)}:${duration.toFixed(3)}`
