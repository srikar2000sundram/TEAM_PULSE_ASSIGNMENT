import type { ActivityType } from '@teampulse/contracts';
import type { Cursor } from '@teampulse/kernel';
import type { Outbox } from '@teampulse/outbox';
import type { Activity } from '../domain/activity.js';

/** What this service knows about a habit. It does not own habits; it learns about them by event. */
export interface KnownHabit {
  readonly habitId: string;
  readonly ownerUserId: string;
  /** Null until a HabitCreated or HabitUpdated event has been seen (an archive can arrive first). */
  readonly activityType: ActivityType | null;
  readonly archived: boolean;
}

export interface ActivityListQuery {
  readonly userId: string;
  /** Inclusive `YYYY-MM-DD` bounds. */
  readonly from?: string;
  readonly to?: string;
  readonly habitId?: string;
  readonly limit: number;
  readonly after?: Cursor;
}

export interface ActivityRepository {
  /**
   * Stores the activity unless this user already recorded this habit for this day, in which case
   * the existing one is returned. Decided by the database's unique key, so two simultaneous
   * requests cannot both create it.
   */
  insertIfAbsent(activity: Activity): Promise<{ activity: Activity; created: boolean }>;
  /** Newest first, ordered by (createdAt, id). Only ever the given user's own activities. */
  list(query: ActivityListQuery): Promise<readonly Activity[]>;
  /** How many activities the user has recorded (the current transaction included). */
  countForUser(userId: string): Promise<number>;
  /** Right to erasure. Returns how many were removed. */
  deleteAllForUser(userId: string): Promise<number>;
}

/**
 * The local copy of habit facts, kept up to date from Habit Service events. Events can be
 * redelivered and can arrive out of order, so every operation is idempotent and order-tolerant:
 * - archiving is permanent (a late "updated" never revives an archived habit);
 * - the activity type comes from the newest event seen.
 */
export interface HabitDirectory {
  find(habitId: string): Promise<KnownHabit | null>;
  /** HabitCreated or HabitUpdated. `at` is the event's `occurredAt`. */
  applySnapshot(habit: {
    habitId: string;
    ownerUserId: string;
    activityType: ActivityType;
    at: Date;
  }): Promise<void>;
  /** HabitArchived. */
  applyArchived(habit: { habitId: string; ownerUserId: string; at: Date }): Promise<void>;
  /** Forgets every habit of a deleted user. */
  deleteAllOwnedBy(ownerUserId: string): Promise<number>;
}

export interface Transaction {
  readonly activities: ActivityRepository;
  readonly habits: HabitDirectory;
  readonly outbox: Outbox;
}

/** Runs `work` atomically: commits when it returns, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
