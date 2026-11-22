import { migrate } from '@teampulse/db';
import { PgliteDatabase } from '@teampulse/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

const db = new PgliteDatabase();
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, MIGRATIONS);
});
afterAll(() => db.close());

const U = '00000000-0000-4000-8000-000000000001';
const H = '00000000-0000-4000-8000-000000000002';
const TEAM = '00000000-0000-4000-8000-0000000000a1';

const activity = (o: { id?: string; type?: string; date?: string; teams?: string[] } = {}) =>
  db.query(
    `INSERT INTO activities (id, user_id, habit_id, activity_type, activity_date, team_ids, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], now())`,
    [
      o.id ?? '00000000-0000-4000-8000-0000000000f1',
      U,
      H,
      o.type ?? 'walking',
      o.date ?? '2026-11-20',
      o.teams ?? [],
    ],
  );

describe('the schema enforces its own invariants (defence in depth)', () => {
  it('creates the three tables', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('activities', 'known_habits', 'outbox') ORDER BY 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual(['activities', 'known_habits', 'outbox']);
  });

  it('allows one activity per user, habit and day, and rejects a duplicate', async () => {
    await activity();
    await expect(activity({ id: '00000000-0000-4000-8000-0000000000f2' })).rejects.toThrow(
      /activities_once_per_day/,
    );
    await expect(
      activity({ id: '00000000-0000-4000-8000-0000000000f3', date: '2026-11-19' }),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown activity type and an impossible date', async () => {
    await expect(activity({ type: 'skydiving' })).rejects.toThrow(/activities_type_valid/);
    await expect(activity({ date: '2026-02-30' })).rejects.toThrow();
  });

  it('rejects more than 20 teams in the snapshot', async () => {
    const teams = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await expect(activity({ teams })).rejects.toThrow(/activities_team_ids_max/);
    await expect(activity({ teams: [TEAM] })).resolves.toBeDefined();
  });

  it('rejects an unknown activity type on a known habit, but allows an unknown (null) one', async () => {
    const insert = (type: string | null) =>
      db.query(
        `INSERT INTO known_habits (habit_id, owner_user_id, activity_type, archived, last_event_at)
         VALUES ($1, $2, $3, false, now())`,
        [H, U, type],
      );
    await expect(insert('skydiving')).rejects.toThrow(/known_habits_type_valid/);
    await expect(insert(null)).resolves.toBeDefined();
  });
});
