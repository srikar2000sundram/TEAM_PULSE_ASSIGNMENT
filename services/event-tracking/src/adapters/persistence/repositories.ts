import type { ActivityType } from '@teampulse/contracts';
import type { Database, Queryable } from '@teampulse/db';
import { PostgresOutbox } from '@teampulse/outbox';
import type {
  ActivityListQuery,
  ActivityRepository,
  HabitDirectory,
  KnownHabit,
  Transaction,
  UnitOfWork,
} from '../../application/ports.js';
import { Activity } from '../../domain/activity.js';

/* Row shapes returned by the driver, and the mapping into domain objects. */

interface ActivityRow {
  id: string;
  user_id: string;
  habit_id: string;
  activity_type: ActivityType;
  /** Selected as text (`to_char`): the driver would otherwise turn a date into a local-time Date. */
  activity_date: string;
  team_ids: string[];
  created_at: Date;
}

/** Every query selects the date as text, in this exact form. */
const ACTIVITY_COLUMNS = `id, user_id, habit_id, activity_type,
  to_char(activity_date, 'YYYY-MM-DD') AS activity_date, team_ids, created_at`;

const toActivity = (row: ActivityRow): Activity =>
  Activity.restore({
    id: row.id,
    userId: row.user_id,
    habitId: row.habit_id,
    activityType: row.activity_type,
    activityDate: row.activity_date,
    teamIds: row.team_ids,
    createdAt: row.created_at,
  });

class PostgresActivities implements ActivityRepository {
  constructor(private readonly db: Queryable) {}

  async insertIfAbsent(activity: Activity) {
    // The unique key decides, not a read-then-write: two simultaneous requests cannot both insert.
    const inserted = await this.db.query(
      `INSERT INTO activities (id, user_id, habit_id, activity_type, activity_date, team_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)
       ON CONFLICT (user_id, habit_id, activity_date) DO NOTHING`,
      [
        activity.id,
        activity.userId,
        activity.habitId,
        activity.activityType,
        activity.activityDate,
        [...activity.teamIds],
        activity.createdAt,
      ],
    );
    if (inserted.rowCount === 1) return { activity, created: true };

    const { rows } = await this.db.query<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities
        WHERE user_id = $1 AND habit_id = $2 AND activity_date = $3`,
      [activity.userId, activity.habitId, activity.activityDate],
    );
    const existing = rows[0];
    if (existing === undefined) throw new Error('activity vanished between insert and read');
    return { activity: toActivity(existing), created: false };
  }

  async list(query: ActivityListQuery) {
    const params: unknown[] = [query.userId];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['user_id = $1'];
    if (query.from !== undefined) where.push(`activity_date >= ${bind(query.from)}`);
    if (query.to !== undefined) where.push(`activity_date <= ${bind(query.to)}`);
    if (query.habitId !== undefined) where.push(`habit_id = ${bind(query.habitId)}`);
    if (query.after !== undefined) {
      where.push(`(created_at, id) < (${bind(query.after.createdAt)}, ${bind(query.after.id)})`);
    }
    const { rows } = await this.db.query<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ${bind(query.limit)}`,
      params,
    );
    return rows.map(toActivity);
  }

  async countForUser(userId: string) {
    const { rows } = await this.db.query<{ total: string }>(
      'SELECT count(*) AS total FROM activities WHERE user_id = $1',
      [userId],
    );
    // count() is a bigint, which the driver returns as text.
    return Number(rows[0]?.total ?? 0);
  }

  async deleteAllForUser(userId: string) {
    const result = await this.db.query('DELETE FROM activities WHERE user_id = $1', [userId]);
    return result.rowCount;
  }
}

interface KnownHabitRow {
  habit_id: string;
  owner_user_id: string;
  activity_type: ActivityType | null;
  archived: boolean;
}

class PostgresHabitDirectory implements HabitDirectory {
  constructor(private readonly db: Queryable) {}

  async find(habitId: string): Promise<KnownHabit | null> {
    const { rows } = await this.db.query<KnownHabitRow>(
      'SELECT habit_id, owner_user_id, activity_type, archived FROM known_habits WHERE habit_id = $1',
      [habitId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          habitId: row.habit_id,
          ownerUserId: row.owner_user_id,
          activityType: row.activity_type,
          archived: row.archived,
        };
  }

  async applySnapshot(habit: {
    habitId: string;
    ownerUserId: string;
    activityType: ActivityType;
    at: Date;
  }) {
    // Order-tolerant upsert. The type comes from the newest event (or fills in a gap), `archived`
    // is never cleared, and the owner never changes once known.
    await this.db.query(
      `INSERT INTO known_habits (habit_id, owner_user_id, activity_type, archived, last_event_at)
       VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (habit_id) DO UPDATE SET
         activity_type = CASE
           WHEN known_habits.activity_type IS NULL OR excluded.last_event_at >= known_habits.last_event_at
             THEN excluded.activity_type ELSE known_habits.activity_type END,
         last_event_at = GREATEST(known_habits.last_event_at, excluded.last_event_at)`,
      [habit.habitId, habit.ownerUserId, habit.activityType, habit.at],
    );
  }

  async applyArchived(habit: { habitId: string; ownerUserId: string; at: Date }) {
    // May arrive before the habit's creation event: store a placeholder with no type yet.
    await this.db.query(
      `INSERT INTO known_habits (habit_id, owner_user_id, activity_type, archived, last_event_at)
       VALUES ($1, $2, NULL, true, $3)
       ON CONFLICT (habit_id) DO UPDATE SET
         archived = true,
         last_event_at = GREATEST(known_habits.last_event_at, excluded.last_event_at)`,
      [habit.habitId, habit.ownerUserId, habit.at],
    );
  }

  async deleteAllOwnedBy(ownerUserId: string) {
    const result = await this.db.query('DELETE FROM known_habits WHERE owner_user_id = $1', [
      ownerUserId,
    ]);
    return result.rowCount;
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({
        activities: new PostgresActivities(queryable),
        habits: new PostgresHabitDirectory(queryable),
        outbox: new PostgresOutbox(queryable),
      }),
    );
  }
}
