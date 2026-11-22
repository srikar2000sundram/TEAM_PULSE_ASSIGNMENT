import type { ActivityType } from '@teampulse/contracts';
import { err, ok, validationError, type Result } from '@teampulse/kernel';

export interface ActivityProps {
  readonly id: string;
  readonly userId: string;
  readonly habitId: string;
  readonly activityType: ActivityType;
  /** Calendar day, `YYYY-MM-DD`. A plain string: a day has no time zone. */
  readonly activityDate: string;
  /** The user's teams at the moment of the activity (a snapshot, so Insight needs no lookup). */
  readonly teamIds: readonly string[];
  /** When it was recorded. Also the pagination key. */
  readonly createdAt: Date;
}

/** One completion of one habit on one day. Immutable: a record of what happened. */
export class Activity {
  private constructor(private readonly props: ActivityProps) {}

  static record(input: Omit<ActivityProps, 'createdAt'> & { now: Date }): Activity {
    const { now, ...rest } = input;
    return new Activity({ ...rest, createdAt: now });
  }

  /** Rebuilds an activity from stored state. Used by repositories only. */
  static restore(props: ActivityProps): Activity {
    return new Activity(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get habitId(): string {
    return this.props.habitId;
  }
  get activityType(): ActivityType {
    return this.props.activityType;
  }
  get activityDate(): string {
    return this.props.activityDate;
  }
  get teamIds(): readonly string[] {
    return this.props.teamIds;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
}

/** How far back a day can be filled in. Injected so operators can tune it. */
export interface DatePolicy {
  readonly backfillDays: number;
}

export const DEFAULT_DATE_POLICY: DatePolicy = { backfillDays: 7 };

const DAY_MS = 86_400_000;

/** The calendar day of an instant in UTC, `YYYY-MM-DD`. */
export const utcDay = (instant: Date): string => instant.toISOString().slice(0, 10);

/** Whole days from `earlier` to `later` (both `YYYY-MM-DD`). */
const daysBetween = (earlier: string, later: string): number =>
  Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);

/**
 * Which days may be recorded: not in the future, and not older than the back-fill window.
 *
 * "Today" is the server's UTC day, but people live in every time zone, so tomorrow's UTC date is
 * allowed: someone in Sydney completing a habit in their morning is already on that date. The
 * window stops a streak from being rewritten arbitrarily far into the past.
 */
export function checkActivityDate(
  activityDate: string,
  now: Date,
  policy: DatePolicy,
): Result<string> {
  const today = utcDay(now);
  const ahead = daysBetween(today, activityDate);
  if (ahead > 1) {
    return err(validationError('activity.date_in_future', 'The activity date is in the future'));
  }
  if (-ahead > policy.backfillDays) {
    return err(
      validationError(
        'activity.date_too_old',
        `Activities can be recorded for at most ${policy.backfillDays} days back`,
      ),
    );
  }
  return ok(activityDate);
}
