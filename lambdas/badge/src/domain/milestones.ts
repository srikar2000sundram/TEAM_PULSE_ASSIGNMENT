/** Streak lengths, in days, worth celebrating. */
export const DEFAULT_STREAK_MILESTONES: readonly number[] = [7, 14, 30, 60, 100, 365];

/** Numbers of recorded activities worth celebrating. */
export const DEFAULT_TOTAL_MILESTONES: readonly number[] = [10, 25, 50, 100, 250, 500, 1000];

/**
 * The milestone a count has just reached, if any.
 *
 * A streak and a running total both grow one step at a time, so they pass through each value
 * exactly once: matching exactly (not "at least") means a milestone is announced when it is reached,
 * not on every step after. A streak that breaks and rebuilds reaches the milestone again, which is
 * a real second achievement.
 */
export function milestoneReached(
  count: number,
  milestones: readonly number[] = DEFAULT_STREAK_MILESTONES,
): number | null {
  return milestones.includes(count) ? count : null;
}
