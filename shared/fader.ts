// K6: the fader's taper and the mixer's numbers — one table for the track
// strips, the master and the Inspector's gain range, so one position means one
// dB everywhere (canvas K, RULES 6). Position is 0…1 from the bottom.

const MINUS = '−'
/** [dB, position] from the top; −40…−∞ is linear from −40 down to −60, then silence */
const TAPER: [number, number][] = [[6, 1], [0, 0.8], [-6, 0.65], [-12, 0.5], [-24, 0.3], [-40, 0.14]]
const FLOOR = -60

export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity)
export const dbToGain = (db: number): number => (db === -Infinity ? 0 : Math.pow(10, db / 20))

export function faderPos(db: number): number {
  if (db >= TAPER[0][0]) return 1
  for (let i = 1; i < TAPER.length; i++) {
    const [d1, p1] = TAPER[i - 1], [d0, p0] = TAPER[i]
    if (db >= d0) return p0 + (p1 - p0) * (db - d0) / (d1 - d0)
  }
  const [d1, p1] = TAPER[TAPER.length - 1]
  return db <= FLOOR ? 0 : p1 * (db - FLOOR) / (d1 - FLOOR)
}

export function posDb(pos: number): number {
  if (pos <= 0) return -Infinity
  if (pos >= 1) return TAPER[0][0]
  for (let i = 1; i < TAPER.length; i++) {
    const [d1, p1] = TAPER[i - 1], [d0, p0] = TAPER[i]
    if (pos >= p0) return d0 + (d1 - d0) * (pos - p0) / (p1 - p0)
  }
  const [d1, p1] = TAPER[TAPER.length - 1]
  return FLOOR + (d1 - FLOOR) * pos / p1
}

const signed = (v: number) => (v === -Infinity ? `${MINUS}∞` : (v >= 0.05 ? '+' : v <= -0.05 ? MINUS : '') + Math.abs(v).toFixed(1))

/** a level in dB as the strip prints it: «0.0», «−6.0», «+3.0», «−∞» */
export const dbText = (db: number): string => signed(db)

/** LUFS / dBTP: anything below −70 (silence, the filter's tail) is «−∞» (K3 finding 3) */
export const lufsText = (v: number): string => (!Number.isFinite(v) || v < -70 ? `${MINUS}∞` : signed(v))

export const panText = (p: number): string =>
  Math.abs(p) < 0.005 ? 'C' : `${p < 0 ? 'L' : 'R'} ${Math.round(Math.abs(p) * 100)}`
