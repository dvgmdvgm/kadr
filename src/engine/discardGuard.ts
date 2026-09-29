import type { Project, Track } from '@shared/types'

/**
 * Whether replacing the open project (New, Open, closing the window) must ask
 * first. Every edit makes a new project object, so "unsaved" is simply "not
 * the object that was last written or opened" — the same rule as the dirty
 * dot. `saved` is null before the app recorded anything: nothing to lose yet.
 * Test: `node scripts/check-discard-guard.mjs`.
 */
export function needsConfirm(project: Project, saved: Project | null): boolean {
  return saved !== null && project !== saved
}

/**
 * «Удалить дорожку»: how many clips the question must name before the track
 * goes, or 0 to delete at once — an empty track, or «Подтверждать удаление»
 * switched off. Test: `node scripts/check-destructive-confirm.mjs`.
 */
export function trackDeleteAsks(track: Pick<Track, 'clips'>, confirmOn: boolean): number {
  return confirmOn ? track.clips.length : 0
}
