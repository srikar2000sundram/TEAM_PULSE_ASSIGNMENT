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
const S = '00000000-0000-4000-8000-000000000002';

const notification = (o: { id?: string; kind?: string; source?: string } = {}) =>
  db.query(
    `INSERT INTO notifications (id, user_id, kind, source_id, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [o.id ?? '00000000-0000-4000-8000-0000000000f1', U, o.kind ?? 'reminder', o.source ?? S],
  );

const reminder = (o: { days?: string[] | null; at?: string | null; zone?: string | null } = {}) =>
  db.query(
    `INSERT INTO reminders (habit_id, user_id, days_of_week, remind_at, time_zone, last_event_at)
     VALUES ($1, $2, $3::text[], $4, $5, now())`,
    [
      S,
      U,
      o.days === undefined ? ['fri'] : o.days,
      o.at === undefined ? '09:00' : o.at,
      o.zone === undefined ? 'UTC' : o.zone,
    ],
  );

describe('the schema enforces its own invariants (defence in depth)', () => {
  it('creates every table', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('notifications', 'notification_preferences', 'reminders',
                             'reminder_occurrences', 'challenge_participants') ORDER BY 1`,
    );
    expect(rows).toHaveLength(5);
  });

  it('rejects an unknown notification kind', async () => {
    await expect(notification({ kind: 'spam' })).rejects.toThrow(/notifications_kind_valid/);
  });

  it('allows one notification per person and source, and rejects a duplicate', async () => {
    await notification();
    await expect(notification({ id: '00000000-0000-4000-8000-0000000000f2' })).rejects.toThrow(
      /notifications_once_per_source/,
    );
  });

  it('rejects a half-defined reminder schedule', async () => {
    await expect(reminder({ days: ['fri'], at: null, zone: null })).rejects.toThrow(
      /reminders_schedule_complete/,
    );
    await expect(reminder({ days: null, at: null, zone: null })).resolves.toBeDefined();
  });

  it('rejects a malformed reminder time', async () => {
    for (const at of ['9:00', '25:00', '09:60', 'noon']) {
      await db.exec('DELETE FROM reminders');
      await expect(reminder({ at }), at).rejects.toThrow(/reminders_time_format/);
    }
    await db.exec('DELETE FROM reminders');
    await expect(reminder({ at: '23:59' })).resolves.toBeDefined();
  });

  it('claims a reminder day only once (primary key)', async () => {
    const claim = () =>
      db.query(
        `INSERT INTO reminder_occurrences (habit_id, local_date, created_at) VALUES ($1, '2026-11-20', now())`,
        [S],
      );
    await claim();
    await expect(claim()).rejects.toThrow(/reminder_occurrences_pkey|duplicate key/);
  });
});
