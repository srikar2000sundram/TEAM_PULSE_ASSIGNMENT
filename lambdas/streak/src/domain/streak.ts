/** A person's streak on one habit. `version` supports optimistic concurrency in the store. */
export interface StreakState {
  readonly userId: string;
  readonly habitId: string;
  /** Consecutive days ending at `lastActivityDate`. */
  readonly currentStreak: number;
  readonly longestStreak: number;
  /** The most recent day counted, `YYYY-MM-DD`. */
  readonly lastActivityDate: string;
  /** Starts at 1 and grows by one with every stored change. */
  readonly version: number;
}

/**
 * What an activity did to the streak:
 * - `started`: the first activity ever for this habit;
 * - `continued`: the day after the last one, so the streak grew;
 * - `reset`: a gap of more than a day, so a new streak of 1 begins (the longest is kept);
 * - `repeated`: the same day again (a redelivered event): nothing changes;
 * - `backdated`: a day before the last counted one: ignored, see the note on `applyActivity`.
 */
export type StreakOutcome = 'started' | 'continued' | 'reset' | 'repeated' | 'backdated';

const DAY_MS = 86_400_000;

/** Whole days from `earlier` to `later`, both `YYYY-MM-DD`. Calendar days, so no DST surprises. */
export const daysBetween = (earlier: string, later: string): number =>
  Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);

/**
 * The streak rules, as a pure function.
 *
 * Only the activity date matters, never the arrival order of events, so a duplicate delivery of the
 * same activity gives the same state. A back-dated activity (a day before the last counted day) is
 * ignored rather than recomputed: rebuilding a streak from history would need every past activity
 * here, and the Event Tracking Service allows at most a week of back-filling. The limit is that
 * filling in a missed day after a later one was already recorded does not repair the streak.
 */
export function applyActivity(
  previous: StreakState | null,
  activity: { userId: string; habitId: string; activityDate: string },
): { state: StreakState; outcome: StreakOutcome } {
  if (previous === null) {
    return {
      outcome: 'started',
      state: {
        userId: activity.userId,
        habitId: activity.habitId,
        currentStreak: 1,
        longestStreak: 1,
        lastActivityDate: activity.activityDate,
        version: 1,
      },
    };
  }

  const gap = daysBetween(previous.lastActivityDate, activity.activityDate);
  if (gap === 0) return { outcome: 'repeated', state: previous };
  if (gap < 0) return { outcome: 'backdated', state: previous };

  const currentStreak = gap === 1 ? previous.currentStreak + 1 : 1;
  return {
    outcome: gap === 1 ? 'continued' : 'reset',
    state: {
      ...previous,
      currentStreak,
      longestStreak: Math.max(previous.longestStreak, currentStreak),
      lastActivityDate: activity.activityDate,
      version: previous.version + 1,
    },
  };
}
