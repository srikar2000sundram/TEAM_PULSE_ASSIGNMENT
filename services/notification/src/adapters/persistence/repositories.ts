import {
  type BadgeKind,
  type DayOfWeek,
  type NotificationKind,
  type NotificationPreferences,
} from '@teampulse/contracts';
import type { Database, Queryable } from '@teampulse/db';
import type {
  NotificationListQuery,
  NotificationRepository,
  ParticipantRepository,
  PreferenceRepository,
  ReminderRepository,
  StoredReminder,
  Transaction,
  UnitOfWork,
} from '../../application/ports.js';
import { Notification, type NotificationContent } from '../../domain/notification.js';
import type { ReminderSchedule } from '../../domain/reminder.js';

/* Content <-> columns. The kind is a column; the numbers live in a small jsonb object. */

type Params = Record<string, string | number>;

const toParams = (content: NotificationContent): Params => {
  switch (content.kind) {
    case 'milestone':
      return { milestoneKind: content.milestoneKind, threshold: content.threshold };
    case 'badge':
      return { badgeKind: content.badgeKind };
    case 'challenge_completed':
    case 'reminder':
      return {};
  }
};

const toContent = (kind: NotificationKind, params: Params): NotificationContent => {
  switch (kind) {
    case 'milestone':
      return {
        kind,
        milestoneKind: params['milestoneKind'] === 'total' ? 'total' : 'streak',
        threshold: Number(params['threshold']),
      };
    case 'badge':
      return { kind, badgeKind: params['badgeKind'] as BadgeKind };
    case 'challenge_completed':
    case 'reminder':
      return { kind };
  }
};

interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  params: Params;
  source_id: string;
  created_at: Date;
  read_at: Date | null;
}

const COLUMNS = 'id, user_id, kind, params, source_id, created_at, read_at';

const toNotification = (row: NotificationRow): Notification =>
  Notification.restore({
    id: row.id,
    userId: row.user_id,
    content: toContent(row.kind, row.params),
    sourceId: row.source_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  });

class PostgresNotifications implements NotificationRepository {
  constructor(private readonly db: Queryable) {}

  async insertMany(notifications: readonly Notification[]) {
    let inserted = 0;
    for (const n of notifications) {
      const result = await this.db.query(
        `INSERT INTO notifications (id, user_id, kind, params, source_id, created_at, read_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (user_id, source_id) DO NOTHING`,
        [
          n.id,
          n.userId,
          n.kind,
          JSON.stringify(toParams(n.content)),
          n.sourceId,
          n.createdAt,
          n.readAt,
        ],
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  async list(query: NotificationListQuery) {
    const params: unknown[] = [query.userId];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['user_id = $1'];
    if (query.unreadOnly) where.push('read_at IS NULL');
    if (query.after !== undefined) {
      where.push(`(created_at, id) < (${bind(query.after.createdAt)}, ${bind(query.after.id)})`);
    }
    const { rows } = await this.db.query<NotificationRow>(
      `SELECT ${COLUMNS} FROM notifications WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ${bind(query.limit)}`,
      params,
    );
    return rows.map(toNotification);
  }

  async unreadCount(userId: string) {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return rows[0]?.n ?? 0;
  }

  async markRead(userId: string, id: string, now: Date) {
    // The user id is part of the condition, so another person's notification is simply not found.
    const { rows } = await this.db.query<NotificationRow>(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3)
        WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId, now],
    );
    return rows[0] === undefined ? null : toNotification(rows[0]);
  }

  async deleteAllForUser(userId: string) {
    return (await this.db.query('DELETE FROM notifications WHERE user_id = $1', [userId])).rowCount;
  }
}

interface PreferenceRow extends NotificationPreferences {
  user_id: string;
}

const toPreferences = (row: PreferenceRow): NotificationPreferences => ({
  milestones: row.milestones,
  badges: row.badges,
  challenges: row.challenges,
  reminders: row.reminders,
});

class PostgresPreferences implements PreferenceRepository {
  constructor(private readonly db: Queryable) {}

  async find(userId: string) {
    const { rows } = await this.db.query<PreferenceRow>(
      'SELECT user_id, milestones, badges, challenges, reminders FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    return rows[0] === undefined ? null : toPreferences(rows[0]);
  }

  async findMany(userIds: readonly string[]) {
    if (userIds.length === 0) return new Map<string, NotificationPreferences>();
    const { rows } = await this.db.query<PreferenceRow>(
      `SELECT user_id, milestones, badges, challenges, reminders FROM notification_preferences
        WHERE user_id = ANY($1::uuid[])`,
      [[...userIds]],
    );
    return new Map(rows.map((row) => [row.user_id, toPreferences(row)] as const));
  }

  async save(userId: string, preferences: NotificationPreferences, now: Date) {
    await this.db.query(
      `INSERT INTO notification_preferences (user_id, milestones, badges, challenges, reminders, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET milestones = excluded.milestones, badges = excluded.badges,
         challenges = excluded.challenges, reminders = excluded.reminders, updated_at = excluded.updated_at`,
      [
        userId,
        preferences.milestones,
        preferences.badges,
        preferences.challenges,
        preferences.reminders,
        now,
      ],
    );
  }

  async deleteForUser(userId: string) {
    return (
      await this.db.query('DELETE FROM notification_preferences WHERE user_id = $1', [userId])
    ).rowCount;
  }
}

interface ReminderRow {
  habit_id: string;
  user_id: string;
  days_of_week: DayOfWeek[];
  remind_at: string;
  time_zone: string;
}

class PostgresReminders implements ReminderRepository {
  constructor(private readonly db: Queryable) {}

  async applySnapshot(reminder: {
    habitId: string;
    userId: string;
    schedule: ReminderSchedule | null;
    at: Date;
  }) {
    const { schedule } = reminder;
    // Order-tolerant upsert: the newest event decides the schedule (including clearing it), and
    // `archived` is never cleared.
    await this.db.query(
      `INSERT INTO reminders (habit_id, user_id, days_of_week, remind_at, time_zone, archived, last_event_at)
       VALUES ($1, $2, $3::text[], $4, $5, false, $6)
       ON CONFLICT (habit_id) DO UPDATE SET
         days_of_week = CASE WHEN excluded.last_event_at >= reminders.last_event_at
                             THEN excluded.days_of_week ELSE reminders.days_of_week END,
         remind_at = CASE WHEN excluded.last_event_at >= reminders.last_event_at
                          THEN excluded.remind_at ELSE reminders.remind_at END,
         time_zone = CASE WHEN excluded.last_event_at >= reminders.last_event_at
                          THEN excluded.time_zone ELSE reminders.time_zone END,
         last_event_at = GREATEST(reminders.last_event_at, excluded.last_event_at)`,
      [
        reminder.habitId,
        reminder.userId,
        schedule === null ? null : [...schedule.daysOfWeek],
        schedule?.remindAt ?? null,
        schedule?.timeZone ?? null,
        reminder.at,
      ],
    );
  }

  async applyArchived(reminder: { habitId: string; userId: string; at: Date }) {
    // May arrive before the habit's creation event: store a placeholder with no schedule.
    await this.db.query(
      `INSERT INTO reminders (habit_id, user_id, archived, last_event_at) VALUES ($1, $2, true, $3)
       ON CONFLICT (habit_id) DO UPDATE SET archived = true,
         last_event_at = GREATEST(reminders.last_event_at, excluded.last_event_at)`,
      [reminder.habitId, reminder.userId, reminder.at],
    );
  }

  async listActive(): Promise<readonly StoredReminder[]> {
    const { rows } = await this.db.query<ReminderRow>(
      `SELECT habit_id, user_id, days_of_week, remind_at, time_zone FROM reminders
        WHERE archived = false AND days_of_week IS NOT NULL`,
    );
    return rows.map((row) => ({
      habitId: row.habit_id,
      userId: row.user_id,
      schedule: {
        daysOfWeek: row.days_of_week,
        remindAt: row.remind_at,
        timeZone: row.time_zone,
      },
    }));
  }

  async claimOccurrence(habitId: string, localDate: string, now: Date) {
    const result = await this.db.query(
      `INSERT INTO reminder_occurrences (habit_id, local_date, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (habit_id, local_date) DO NOTHING`,
      [habitId, localDate, now],
    );
    return result.rowCount === 1;
  }

  async purgeOccurrences(before: Date) {
    return (await this.db.query('DELETE FROM reminder_occurrences WHERE created_at < $1', [before]))
      .rowCount;
  }

  async deleteAllForUser(userId: string) {
    return (await this.db.query('DELETE FROM reminders WHERE user_id = $1', [userId])).rowCount;
  }
}

class PostgresParticipants implements ParticipantRepository {
  constructor(private readonly db: Queryable) {}

  async add(challengeId: string, userId: string) {
    await this.db.query(
      'INSERT INTO challenge_participants (challenge_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [challengeId, userId],
    );
  }

  async usersOf(challengeId: string) {
    const { rows } = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM challenge_participants WHERE challenge_id = $1 ORDER BY user_id',
      [challengeId],
    );
    return rows.map((row) => row.user_id);
  }

  async deleteAllForUser(userId: string) {
    return (await this.db.query('DELETE FROM challenge_participants WHERE user_id = $1', [userId]))
      .rowCount;
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({
        notifications: new PostgresNotifications(queryable),
        preferences: new PostgresPreferences(queryable),
        reminders: new PostgresReminders(queryable),
        participants: new PostgresParticipants(queryable),
      }),
    );
  }
}
