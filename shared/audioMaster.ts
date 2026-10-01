/**
 * The export's master stage: a brick-wall peak limiter on the summed mix.
 *
 * Why it exists: the mix is a plain float sum (amix + volume=N) and nothing
 * stopped it from going over full scale — the encoder then hard-clipped it.
 * A loud master (phonk, EDM, anything mastered to 0 dBFS) under a single 808
 * hit measured +9.8 dBFS in a real project, i.e. audible crackle on
 * exactly the hits that matter.
 *
 * ffmpeg 4.3's alimiter, measured here:
 *  - it holds peaks at `limit` exactly (a 1.8 click came out at the limit);
 *  - below the limit it is transparent — gain 1, bit for bit;
 *  - it DELAYS the signal by its look-ahead: 239 samples at 48 kHz with the
 *    5 ms attack (not 240: at 240 the residual is 0.06, at 239 it is 0.0);
 *  - it does not flush that look-ahead at the end of the stream, so the last
 *    239 samples never come out.
 * Hence the chain: pad 239 samples of silence in front of it, limit, drop the
 * first 239 samples. Result, checked on pink noise below the limit: the same
 * length and bit-identical to the input (scripts/check-limiter.mjs). An export
 * that never reaches the limit is therefore unchanged by this stage.
 *
 * The mix is 48 kHz by construction (segmentChain's aformat), which is what the
 * sample counts assume. Auto-levelling is off (`level=disabled`): this is a
 * safety limiter, not a loudness maximiser.
 */
/**
 * −1 dBFS: the same −1 dBTP ceiling normalizeClip aims for. 0.95 was tried
 * first and a real MP3 export of a limited mix still decoded at −0.1 dB — the
 * codec's reconstruction adds overshoot on top of whatever the mix peaks at,
 * so the limit has to leave room for it.
 */
export const MASTER_LIMIT = 0.891
export const MASTER_SR = 48000
export const MASTER_ATTACK_MS = 5
export const MASTER_RELEASE_MS = 50
const LOOKAHEAD_SAMPLES = 239

/**
 * G9, the loudness target: the true-peak ceiling a targeted export aims for.
 * The limiter holds SAMPLE peaks; the reconstructed wave between samples, and
 * a lossy codec's decode, go over them — measured on clicks through AAC and
 * MP3, +0.3 to +0.6 dB. Aiming 0.5 dB under the −1 dBTP the platforms ask for
 * leaves that room (electron/ffmpeg.ts fitLoudness lowers the ceiling until
 * the chain's true peak is under this).
 */
export const TP_AIM = -1.5
/** the true peak a targeted export's FILE must not pass, dBTP (what the platforms ask for) */
export const TP_CEILING = -1
/** the export's loudness targets, LUFS (the dialog's «Громкость»); off = none */
export const LOUDNESS_TARGETS = [-14, -16, -23] as const

/**
 * The master chain. `limit` and `gainDb` are the loudness target's (G9): a
 * linear gain in front, a lower ceiling; with neither the chain is the plain
 * safety limiter, string for string.
 */
export function masterLimiterChain(limit = MASTER_LIMIT, gainDb = 0): string[] {
  return [
    ...(gainDb ? [`volume=${gainDb.toFixed(3)}dB`] : []),
    `apad=pad_len=${LOOKAHEAD_SAMPLES}`,
    `alimiter=limit=${+limit.toFixed(4)}:attack=${MASTER_ATTACK_MS}:release=${MASTER_RELEASE_MS}:level=disabled`,
    `atrim=start_sample=${LOOKAHEAD_SAMPLES}`,
    'asetpts=N/SR/TB'
  ]
}
