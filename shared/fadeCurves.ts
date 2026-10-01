// K2: the shape of an audio fade. ONE table for both ends of the pipeline:
// the preview multiplies the element's volume by fadeGain() every frame, and
// the export hands ffmpeg's afade the same curve by name — the formulas below
// are af_afade.c's own, so what is heard while editing is what gets exported
// (scripts/check-fade-curves.mjs runs ffmpeg against them).
//
// 'qsin' is the equal-power curve: a sin fade-in over a cos fade-out sums to
// constant POWER, so two uncorrelated sources hold their loudness through the
// overlap; a linear pair dips ~3 dB in the middle. A clip without a stored
// curve is linear — every project made before K2 sounds as it did.

export type FadeCurve = 'lin' | 'qsin' | 'log' | 'exp'
export const FADE_CURVES: FadeCurve[] = ['lin', 'qsin', 'log', 'exp']

/** afade's own name for the curve */
export const AFADE_CURVE: Record<FadeCurve, string> = { lin: 'tri', qsin: 'qsin', log: 'log', exp: 'exp' }

/** gain 0..1 at x = the fraction of the fade travelled towards full level (fade-in:
    elapsed / length; fade-out: remaining / length) — af_afade.c fade_gain() */
export function fadeGain(curve: FadeCurve | undefined, x: number): number {
  const g = Math.min(1, Math.max(0, x))
  switch (curve) {
    case 'qsin': return Math.sin((g * Math.PI) / 2)
    case 'log': return Math.min(1, Math.max(0, 1 + 0.2 * Math.log10(g)))
    case 'exp': return Math.exp(-11.512925464970227 * (1 - g))
    default: return g
  }
}

/** the i18n key of each curve's name (menu and settings) */
export const FADE_CURVE_NAME = { lin: 'fcLin', qsin: 'fcQsin', log: 'fcLog', exp: 'fcExp' } as const
