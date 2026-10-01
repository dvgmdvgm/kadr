// The project's format presets (card H2): the Inspector's rows, D's «Новый
// проект» settings and newProject() read them. Pure, no imports — checked in
// plain node by scripts/check-fps-rational.mjs.

/** 1080p, 4K, 9:16, 4:5 */
export const RESOLUTION_PRESETS: readonly [number, number][] = [[1920, 1080], [3840, 2160], [1080, 1920], [1080, 1350]]

/** frame rates as exact rationals [num, den]; `project.fps` stores num / den
    (a number, so every existing consumer keeps working) — 30000/1001 reaches
    ffmpeg's `-r` as 29.97002997… and ffprobe reads it back as 30000/1001 */
export const FPS_PRESETS: readonly [number, number][] = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]
]

/** a decimal NTSC rate (23.976, 29.97, 59.94) as the rational it names;
    anything else unchanged */
export function exactFps(fps: number): number {
  const n = Math.round(fps * 1.001)
  return fps % 1 && Math.abs(fps * 1.001 - n) < 0.01 && Math.abs(fps - n) > 0.01 ? (n * 1000) / 1001 : fps
}

/** 23.976 · 29.97 · 59.94 · 25 — dot decimal, the caller localises */
export const fpsLabel = (fps: number) => String(Math.floor(fps * 1000 + 1e-6) / 1000)
