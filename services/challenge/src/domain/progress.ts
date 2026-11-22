import { addDays } from './dates.js';
import type { BadgeRule } from './challenge.js';

export interface ProgressStats {
  /** One point per qualifying activity. */
  readonly points: number;
  /** Different days with at least one qualifying activity. */
  readonly activeDays: number;
  /** The longest run of consecutive days with a qualifying activity. */
  readonly longestStreak: number;
}

/**
 * Everything a participant's progress means, derived from the dates of their qualifying
 * activities (one entry per activity, in any order, repeats allowed).
 *
 * Deriving it from the activity ledger instead of keeping counters means a replayed or reordered
 * event can never leave a counter wrong: the same ledger always gives the same answer.
 */
export function statsOf(activityDates: readonly string[]): ProgressStats {
  const days = [...new Set(activityDates)].sort();
  let longest = 0;
  let run = 0;
  let previous: string | undefined;
  for (const day of days) {
    run = previous !== undefined && addDays(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { points: activityDates.length, activeDays: days.length, longestStreak: longest };
}

/** The badge rules these statistics satisfy. A rule is satisfied once and for good. */
export function satisfiedRules(
  rules: readonly BadgeRule[],
  stats: ProgressStats,
): readonly BadgeRule[] {
  return rules.filter((rule) => {
    switch (rule.kind) {
      case 'streak':
        return stats.longestStreak >= rule.threshold;
      case 'total':
        return stats.points >= rule.threshold;
      case 'milestone':
        return stats.activeDays >= rule.threshold;
    }
  });
}

export interface Standing {
  readonly userId: string;
  readonly points: number;
}

export interface RankedStanding extends Standing {
  readonly rank: number;
}

/**
 * Competition ranking: equal points share a rank and the next rank is skipped (1, 2, 2, 4). Order
 * is by points, highest first, then by user id so the result is stable.
 */
export function rankStandings(standings: readonly Standing[]): RankedStanding[] {
  const sorted = [...standings].sort(
    (a, b) => b.points - a.points || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  let rank = 0;
  return sorted.map((standing, index) => {
    if (index === 0 || standing.points !== sorted[index - 1]?.points) rank = index + 1;
    return { ...standing, rank };
  });
}
