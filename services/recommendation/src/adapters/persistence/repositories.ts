import type { Database, Queryable } from '@teampulse/db';
import type {
  ActivityTime,
  ActivityTimeRepository,
  DecisionRepository,
  StoredDecision,
  Transaction,
  UnitOfWork,
} from '../../application/ports.js';

class PostgresActivityTimes implements ActivityTimeRepository {
  constructor(private readonly db: Queryable) {}

  async record(entry: { eventId: string; userId: string; habitId: string; occurredAt: Date }) {
    const result = await this.db.query(
      `INSERT INTO activity_times (event_id, user_id, habit_id, occurred_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING`,
      [entry.eventId, entry.userId, entry.habitId, entry.occurredAt],
    );
    return result.rowCount === 1;
  }

  async listSince(userId: string, since: Date): Promise<readonly ActivityTime[]> {
    const { rows } = await this.db.query<{ habit_id: string; occurred_at: Date | string }>(
      `SELECT habit_id, occurred_at FROM activity_times
       WHERE user_id = $1 AND occurred_at >= $2 ORDER BY occurred_at, event_id`,
      [userId, since],
    );
    return rows.map((row) => ({ habitId: row.habit_id, occurredAt: new Date(row.occurred_at) }));
  }

  async purgeBefore(before: Date) {
    return (await this.db.query('DELETE FROM activity_times WHERE occurred_at < $1', [before]))
      .rowCount;
  }

  async deleteAllForUser(userId: string) {
    return (await this.db.query('DELETE FROM activity_times WHERE user_id = $1', [userId]))
      .rowCount;
  }
}

class PostgresDecisions implements DecisionRepository {
  constructor(private readonly db: Queryable) {}

  async save(decision: StoredDecision, now: Date) {
    await this.db.query(
      `INSERT INTO decisions (user_id, habit_id, suggested_time, time_zone, decision, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, habit_id, suggested_time, time_zone)
       DO UPDATE SET decision = EXCLUDED.decision, decided_at = EXCLUDED.decided_at`,
      [
        decision.userId,
        decision.habitId,
        decision.suggestedTime,
        decision.timeZone,
        decision.decision,
        now,
      ],
    );
  }

  async listForUser(userId: string): Promise<readonly StoredDecision[]> {
    const { rows } = await this.db.query<{
      user_id: string;
      habit_id: string;
      suggested_time: string;
      time_zone: string;
      decision: 'accepted' | 'dismissed';
    }>(
      `SELECT user_id, habit_id, suggested_time, time_zone, decision FROM decisions
       WHERE user_id = $1 ORDER BY habit_id, suggested_time, time_zone`,
      [userId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      habitId: row.habit_id,
      suggestedTime: row.suggested_time,
      timeZone: row.time_zone,
      decision: row.decision,
    }));
  }

  async deleteAllForUser(userId: string) {
    return (await this.db.query('DELETE FROM decisions WHERE user_id = $1', [userId])).rowCount;
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({
        activityTimes: new PostgresActivityTimes(queryable),
        decisions: new PostgresDecisions(queryable),
      }),
    );
  }
}
