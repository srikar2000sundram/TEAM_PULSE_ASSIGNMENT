import {
  HABIT_DESCRIPTION_MAX_LENGTH,
  HABIT_TITLE_MAX_LENGTH,
  daysOfWeek,
  type ActivityType,
  type HabitReminder,
  type HabitVisibility,
} from '@teampulse/contracts';
import { conflictError, err, ok, validationError, type Result } from '@teampulse/kernel';

/**
 * Who a habit is shared with. A discriminated union, so "team visibility without a team" and
 * "a private habit that still points at a team" cannot be represented at all.
 */
export type Sharing =
  { readonly visibility: 'private' } | { readonly visibility: 'team'; readonly teamId: string };

/**
 * The person looking at habits. Built from the access token, so `teamIds` are the teams they
 * **belong to**. Managing a team is deliberately absent: a manager sees a team's aggregates
 * (Insight Service), never an individual's habits.
 */
export interface Viewer {
  readonly userId: string;
  readonly teamIds: readonly string[];
}

export interface HabitProps {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly description: string | null;
  readonly activityType: ActivityType;
  readonly sharing: Sharing;
  readonly reminder: HabitReminder | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields a user can change. Absent means unchanged; `null` clears an optional field. */
export interface HabitChanges {
  readonly title?: string;
  readonly description?: string | null;
  readonly activityType?: ActivityType;
  readonly sharing?: Sharing;
  readonly reminder?: HabitReminder | null;
}

const invalid = (code: string, message: string) => err(validationError(code, message));

function normaliseTitle(raw: string): Result<string> {
  const title = raw.trim();
  return title.length >= 1 && title.length <= HABIT_TITLE_MAX_LENGTH
    ? ok(title)
    : invalid('habit.title_invalid', `The title must be 1 to ${HABIT_TITLE_MAX_LENGTH} characters`);
}

/** Blank means "no description", so there is one representation of nothing. */
function normaliseDescription(raw: string | null | undefined): Result<string | null> {
  if (raw === null || raw === undefined) return ok(null);
  const description = raw.trim();
  if (description === '') return ok(null);
  return description.length <= HABIT_DESCRIPTION_MAX_LENGTH
    ? ok(description)
    : invalid(
        'habit.description_invalid',
        `The description must be at most ${HABIT_DESCRIPTION_MAX_LENGTH} characters`,
      );
}

/** Days in calendar order, so equal reminders are stored and compared identically. */
function normaliseReminder(reminder: HabitReminder | null | undefined): HabitReminder | null {
  if (reminder === null || reminder === undefined) return null;
  return {
    ...reminder,
    daysOfWeek: daysOfWeek.filter((day) => reminder.daysOfWeek.includes(day)),
  };
}

/**
 * A comparison key independent of property order (PostgreSQL jsonb does not preserve it) and of
 * day order (normalised on the way in).
 */
const reminderKey = (reminder: HabitReminder | null): string =>
  reminder === null
    ? ''
    : `${reminder.daysOfWeek.join(',')}|${reminder.remindAt}|${reminder.timeZone}`;

/**
 * Immutable: every change returns a new Habit. Archiving is a soft delete, so streaks and history
 * built on the habit remain meaningful; erasing a user removes their habits for real.
 */
export class Habit {
  private constructor(private readonly props: HabitProps) {}

  static create(input: {
    id: string;
    ownerUserId: string;
    title: string;
    description?: string | null | undefined;
    activityType: ActivityType;
    sharing: Sharing;
    reminder?: HabitReminder | null | undefined;
    now: Date;
  }): Result<Habit> {
    const title = normaliseTitle(input.title);
    if (!title.ok) return title;
    const description = normaliseDescription(input.description);
    if (!description.ok) return description;

    return ok(
      new Habit({
        id: input.id,
        ownerUserId: input.ownerUserId,
        title: title.value,
        description: description.value,
        activityType: input.activityType,
        sharing: input.sharing,
        reminder: normaliseReminder(input.reminder),
        archivedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    );
  }

  /** Rebuilds a habit from stored state. Used by repositories only. */
  static restore(props: HabitProps): Habit {
    return new Habit(props);
  }

  get id(): string {
    return this.props.id;
  }
  get ownerUserId(): string {
    return this.props.ownerUserId;
  }
  get title(): string {
    return this.props.title;
  }
  get description(): string | null {
    return this.props.description;
  }
  get activityType(): ActivityType {
    return this.props.activityType;
  }
  get sharing(): Sharing {
    return this.props.sharing;
  }
  get visibility(): HabitVisibility {
    return this.props.sharing.visibility;
  }
  /** The team the habit is shared with, or null for a private habit. */
  get teamId(): string | null {
    return this.props.sharing.visibility === 'team' ? this.props.sharing.teamId : null;
  }
  get reminder(): HabitReminder | null {
    return this.props.reminder;
  }
  get archivedAt(): Date | null {
    return this.props.archivedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isArchived(): boolean {
    return this.props.archivedAt !== null;
  }

  isOwnedBy(userId: string): boolean {
    return this.props.ownerUserId === userId;
  }

  /**
   * The single definition of who may see a habit:
   * - the owner always sees it (archived or not);
   * - everyone else sees it only while it is active, shared with a team, and they belong to that
   *   team. Roles grant nothing: admins and managers follow the same rule as anyone else.
   *
   * Repositories must enforce exactly this in their queries, so hidden habits are never even
   * loaded. The shared repository contract suite checks that each implementation agrees.
   */
  isVisibleTo(viewer: Viewer): boolean {
    if (this.isOwnedBy(viewer.userId)) return true;
    return (
      !this.isArchived &&
      this.props.sharing.visibility === 'team' &&
      viewer.teamIds.includes(this.props.sharing.teamId)
    );
  }

  /** Applies a partial update. An archived habit is read-only. */
  apply(changes: HabitChanges, now: Date): Result<Habit> {
    if (this.isArchived) {
      return err(conflictError('habit.archived', 'An archived habit cannot be changed'));
    }

    let title = this.props.title;
    if (changes.title !== undefined) {
      const result = normaliseTitle(changes.title);
      if (!result.ok) return result;
      title = result.value;
    }

    let description = this.props.description;
    if (changes.description !== undefined) {
      const result = normaliseDescription(changes.description);
      if (!result.ok) return result;
      description = result.value;
    }

    return ok(
      new Habit({
        ...this.props,
        title,
        description,
        activityType: changes.activityType ?? this.props.activityType,
        sharing: changes.sharing ?? this.props.sharing,
        reminder:
          changes.reminder === undefined
            ? this.props.reminder
            : normaliseReminder(changes.reminder),
        updatedAt: now,
      }),
    );
  }

  /** Idempotent: archiving an archived habit returns it unchanged (and keeps the first time). */
  archive(now: Date): Habit {
    return this.isArchived ? this : new Habit({ ...this.props, archivedAt: now, updatedAt: now });
  }

  /** Withdraws the habit from its team, for example because the owner left that team. */
  makePrivate(now: Date): Habit {
    return new Habit({ ...this.props, sharing: { visibility: 'private' }, updatedAt: now });
  }

  /**
   * True when other services would see a different habit: they hold the visibility, activity type
   * and reminder (never the title or notes), so only those changes are worth an event.
   */
  differsForSubscribers(other: Habit): boolean {
    return (
      this.visibility !== other.visibility ||
      this.activityType !== other.activityType ||
      reminderKey(this.reminder) !== reminderKey(other.reminder)
    );
  }
}
