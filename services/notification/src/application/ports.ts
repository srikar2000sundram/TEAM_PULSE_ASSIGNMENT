import type { NotificationPreferences } from '@teampulse/contracts';
import type { Cursor } from '@teampulse/kernel';
import type { Notification } from '../domain/notification.js';
import type { ReminderSchedule } from '../domain/reminder.js';

export interface NotificationListQuery {
  readonly userId: string;
  readonly unreadOnly: boolean;
  readonly limit: number;
  readonly after?: Cursor;
}

export interface NotificationRepository {
  /**
   * Stores each notification unless the same user already has one for the same source. This is what
   * makes handling an event twice harmless. Returns how many were new.
   */
  insertMany(notifications: readonly Notification[]): Promise<number>;
  /** Newest first, ordered by (createdAt, id). Only ever the given user's own notifications. */
  list(query: NotificationListQuery): Promise<readonly Notification[]>;
  unreadCount(userId: string): Promise<number>;
  /** Marks the user's own notification as read. Null when it does not exist or is not theirs. */
  markRead(userId: string, id: string, now: Date): Promise<Notification | null>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface PreferenceRepository {
  find(userId: string): Promise<NotificationPreferences | null>;
  /** One query for many people; people without stored preferences are simply absent. */
  findMany(userIds: readonly string[]): Promise<ReadonlyMap<string, NotificationPreferences>>;
  save(userId: string, preferences: NotificationPreferences, now: Date): Promise<void>;
  deleteForUser(userId: string): Promise<number>;
}

export interface StoredReminder {
  readonly habitId: string;
  readonly userId: string;
  readonly schedule: ReminderSchedule;
}

/**
 * Reminder schedules, kept up to date from Habit Service events. Events can be redelivered and can
 * arrive out of order, so both operations are idempotent and order-tolerant: the newest event decides
 * the schedule (including clearing it), and archiving is permanent.
 */
export interface ReminderRepository {
  /** HabitCreated or HabitUpdated. A null schedule means "no reminder". `at` is `occurredAt`. */
  applySnapshot(reminder: {
    habitId: string;
    userId: string;
    schedule: ReminderSchedule | null;
    at: Date;
  }): Promise<void>;
  /** HabitArchived. */
  applyArchived(reminder: { habitId: string; userId: string; at: Date }): Promise<void>;
  /** Reminders that are neither archived nor cleared. */
  listActive(): Promise<readonly StoredReminder[]>;
  /** Records that this day's reminder is being sent. False when it was already recorded. */
  claimOccurrence(habitId: string, localDate: string, now: Date): Promise<boolean>;
  /** Housekeeping: forget occurrences recorded before `before`. */
  purgeOccurrences(before: Date): Promise<number>;
  deleteAllForUser(userId: string): Promise<number>;
}

/** Who joined which challenge, so a ChallengeCompleted event (which names no people) can be fanned out. */
export interface ParticipantRepository {
  add(challengeId: string, userId: string): Promise<void>;
  usersOf(challengeId: string): Promise<readonly string[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface Transaction {
  readonly notifications: NotificationRepository;
  readonly preferences: PreferenceRepository;
  readonly reminders: ReminderRepository;
  readonly participants: ParticipantRepository;
}

/** Runs `work` atomically: commits when it returns, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
