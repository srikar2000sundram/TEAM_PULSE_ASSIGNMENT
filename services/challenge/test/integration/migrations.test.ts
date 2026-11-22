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

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const C = id(1);
const U = id(2);
const R = id(3);

const challenge = (
  o: {
    name?: string;
    type?: string;
    status?: string;
    starts?: string;
    ends?: string;
    completedOn?: string | null;
  } = {},
) =>
  db.query(
    `INSERT INTO challenges (id, name, activity_type, team_id, starts_on, ends_on, status, created_at, updated_at, completed_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8)`,
    [
      C,
      o.name ?? 'Steps',
      o.type ?? 'walking',
      id(9),
      o.starts ?? '2026-11-20',
      o.ends ?? '2026-11-30',
      o.status ?? 'active',
      o.completedOn ?? null,
    ],
  );

const rule = (o: { kind?: string; threshold?: number; id?: string } = {}) =>
  db.query('INSERT INTO badge_rules (id, challenge_id, kind, threshold) VALUES ($1, $2, $3, $4)', [
    o.id ?? R,
    C,
    o.kind ?? 'total',
    o.threshold ?? 5,
  ]);

describe('the schema enforces its own invariants (defence in depth)', () => {
  it('creates every table', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('challenges', 'badge_rules', 'participations', 'progress_ledger',
                             'awarded_badges', 'outbox') ORDER BY 1`,
    );
    expect(rows).toHaveLength(6);
  });

  it('rejects a bad name, activity type and status', async () => {
    await expect(challenge({ name: '' })).rejects.toThrow(/challenges_name_length/);
    await expect(challenge({ name: 'x'.repeat(81) })).rejects.toThrow(/challenges_name_length/);
    await expect(challenge({ type: 'flying' })).rejects.toThrow(/challenges_activity_type_valid/);
    await expect(challenge({ status: 'paused' })).rejects.toThrow(/challenges_status_valid/);
  });

  it('rejects an end date before the start date', async () => {
    await expect(challenge({ starts: '2026-12-01', ends: '2026-11-30' })).rejects.toThrow(
      /challenges_dates_ordered/,
    );
    await expect(challenge({ starts: '2026-11-30', ends: '2026-11-30' })).resolves.toBeDefined();
  });

  it('allows a completion date only on a completed challenge', async () => {
    await expect(challenge({ status: 'active', completedOn: '2026-11-30' })).rejects.toThrow(
      /challenges_completed_on_matches_status/,
    );
    await expect(challenge({ status: 'completed', completedOn: null })).rejects.toThrow(
      /challenges_completed_on_matches_status/,
    );
    await expect(
      challenge({ status: 'completed', completedOn: '2026-11-30' }),
    ).resolves.toBeDefined();
  });

  it('rejects a bad badge kind, an out-of-range threshold and a repeated rule', async () => {
    await challenge();
    await expect(rule({ kind: 'gold' })).rejects.toThrow(/badge_rules_kind_valid/);
    await expect(rule({ threshold: 0 })).rejects.toThrow(/badge_rules_threshold_range/);
    await expect(rule({ threshold: 1001 })).rejects.toThrow(/badge_rules_threshold_range/);
    await rule();
    await expect(rule({ id: id(4) })).rejects.toThrow(/badge_rules_unique/);
    await expect(rule({ id: id(5), kind: 'streak' })).resolves.toBeDefined();
  });

  it('keeps one participation per person and refuses negative points', async () => {
    await challenge();
    const join = () =>
      db.query(
        `INSERT INTO participations (challenge_id, user_id, team_id, joined_on) VALUES ($1, $2, $3, '2026-11-20')`,
        [C, U, id(9)],
      );
    await join();
    await expect(join()).rejects.toThrow(/participations_pkey|duplicate key/);
    await expect(
      db.query('UPDATE participations SET points = -1 WHERE challenge_id = $1', [C]),
    ).rejects.toThrow(/participations_points_not_negative/);
  });

  it('scores an event once per challenge (the ledger key)', async () => {
    await challenge();
    const score = () =>
      db.query(
        `INSERT INTO progress_ledger (challenge_id, source_event_id, user_id, activity_date)
         VALUES ($1, $2, $3, '2026-11-20')`,
        [C, id(7), U],
      );
    await score();
    await expect(score()).rejects.toThrow(/progress_ledger_pkey|duplicate key/);
  });

  it('awards a badge once per person and rule, and only for a rule that exists', async () => {
    await challenge();
    await rule();
    const award = (ruleId = R) =>
      db.query(
        `INSERT INTO awarded_badges (challenge_id, user_id, badge_rule_id, awarded_on)
         VALUES ($1, $2, $3, '2026-11-21')`,
        [C, U, ruleId],
      );
    await award();
    await expect(award()).rejects.toThrow(/awarded_badges_pkey|duplicate key/);
    await expect(award(id(99))).rejects.toThrow(/foreign key|awarded_badges_badge_rule_id_fkey/);
  });

  it('removes a challenge together with everything that belongs to it', async () => {
    await challenge();
    await rule();
    await db.query(
      `INSERT INTO participations (challenge_id, user_id, team_id, joined_on) VALUES ($1, $2, $3, '2026-11-20')`,
      [C, U, id(9)],
    );
    await db.query(
      `INSERT INTO progress_ledger (challenge_id, source_event_id, user_id, activity_date) VALUES ($1, $2, $3, '2026-11-20')`,
      [C, id(7), U],
    );
    await db.query(
      `INSERT INTO awarded_badges (challenge_id, user_id, badge_rule_id, awarded_on) VALUES ($1, $2, $3, '2026-11-21')`,
      [C, U, R],
    );
    await db.query('DELETE FROM challenges WHERE id = $1', [C]);
    for (const table of ['badge_rules', 'participations', 'progress_ledger', 'awarded_badges']) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0]?.n, table).toBe(0);
    }
  });
});
