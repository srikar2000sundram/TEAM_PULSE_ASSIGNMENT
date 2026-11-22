import { habitReminderSchema, type ActivityType } from '@teampulse/contracts';
import type { Database, Queryable } from '@teampulse/db';
import { PostgresOutbox } from '@teampulse/outbox';
import type {
  HabitListQuery,
  HabitRepository,
  Transaction,
  UnitOfWork,
} from '../../application/ports.js';
import { Habit, type Sharing, type Viewer } from '../../domain/habit.js';

/* Row shape returned by the driver, and the mapping into the domain object. */

interface HabitRow {
  id: string;
  owner_user_id: string;
  title: string;
  description: string | null;
  activity_type: ActivityType;
  visibility: 'private' | 'team';
  team_id: string | null;
  reminder: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toHabit = (row: HabitRow): Habit => {
  const sharing: Sharing =
    row.visibility === 'team' && row.team_id !== null
      ? { visibility: 'team', teamId: row.team_id }
      : { visibility: 'private' };
  return Habit.restore({
    id: row.id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    description: row.description,
    activityType: row.activity_type,
    sharing,
    // Stored reminders were validated on the way in; parsing again guards against hand-edited rows.
    reminder: row.reminder === null ? null : habitReminderSchema.parse(row.reminder),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

/**
 * The visibility rule of `Habit.isVisibleTo`, as SQL: the owner, or an active habit shared with a
 * team the viewer belongs to. `$ownerParam` and `$teamsParam` are placeholders numbers.
 */
const visibleTo = (ownerParam: number, teamsParam: number): string =>
  `(owner_user_id = $${ownerParam} OR (archived_at IS NULL AND visibility = 'team' AND team_id = ANY($${teamsParam}::uuid[])))`;

class PostgresHabits implements HabitRepository {
  constructor(private readonly db: Queryable) {}

  async insert(habit: Habit) {
    await this.db.query(
      `INSERT INTO habits
         (id, owner_user_id, title, description, activity_type, visibility, team_id, reminder,
          archived_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        habit.id,
        habit.ownerUserId,
        habit.title,
        habit.description,
        habit.activityType,
        habit.visibility,
        habit.teamId,
        habit.reminder === null ? null : JSON.stringify(habit.reminder),
        habit.archivedAt,
        habit.createdAt,
        habit.updatedAt,
      ],
    );
  }

  async findVisible(id: string, viewer: Viewer, options: { lock?: boolean } = {}) {
    const { rows } = await this.db.query<HabitRow>(
      `SELECT * FROM habits WHERE id = $1 AND ${visibleTo(2, 3)}${options.lock === true ? ' FOR UPDATE' : ''}`,
      [id, viewer.userId, [...viewer.teamIds]],
    );
    return rows[0] === undefined ? null : toHabit(rows[0]);
  }

  async update(habit: Habit) {
    await this.db.query(
      `UPDATE habits
          SET title = $2, description = $3, activity_type = $4, visibility = $5, team_id = $6,
              reminder = $7::jsonb, archived_at = $8, updated_at = $9
        WHERE id = $1`,
      [
        habit.id,
        habit.title,
        habit.description,
        habit.activityType,
        habit.visibility,
        habit.teamId,
        habit.reminder === null ? null : JSON.stringify(habit.reminder),
        habit.archivedAt,
        habit.updatedAt,
      ],
    );
  }

  async countActiveOwnedBy(ownerUserId: string) {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM habits WHERE owner_user_id = $1 AND archived_at IS NULL',
      [ownerUserId],
    );
    return rows[0]?.n ?? 0;
  }

  async list(query: HabitListQuery) {
    const params: unknown[] = [query.viewer.userId];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const where: string[] = [];
    if (query.scope === 'mine') {
      where.push('owner_user_id = $1');
      where.push(query.status === 'archived' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    } else {
      // Other people's habits: only active ones shared with a team the viewer belongs to.
      where.push('owner_user_id <> $1');
      where.push('archived_at IS NULL');
      where.push("visibility = 'team'");
      where.push(`team_id = ANY(${bind([...query.viewer.teamIds])}::uuid[])`);
      if (query.teamId !== undefined) where.push(`team_id = ${bind(query.teamId)}`);
    }
    if (query.activityType !== undefined) where.push(`activity_type = ${bind(query.activityType)}`);
    if (query.after !== undefined) {
      where.push(`(created_at, id) < (${bind(query.after.createdAt)}, ${bind(query.after.id)})`);
    }

    const { rows } = await this.db.query<HabitRow>(
      `SELECT * FROM habits WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ${bind(query.limit)}`,
      params,
    );
    return rows.map(toHabit);
  }

  async withdrawFromTeam(ownerUserId: string, teamId: string, now: Date) {
    const { rows } = await this.db.query<HabitRow>(
      `UPDATE habits SET visibility = 'private', team_id = NULL, updated_at = $3
        WHERE owner_user_id = $1 AND team_id = $2
        RETURNING *`,
      [ownerUserId, teamId, now],
    );
    return rows.map(toHabit);
  }

  async deleteAllOwnedBy(ownerUserId: string) {
    const result = await this.db.query('DELETE FROM habits WHERE owner_user_id = $1', [
      ownerUserId,
    ]);
    return result.rowCount;
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({ habits: new PostgresHabits(queryable), outbox: new PostgresOutbox(queryable) }),
    );
  }
}
