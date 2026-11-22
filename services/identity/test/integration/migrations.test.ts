import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@teampulse/db';
import { PgliteDatabase } from '@teampulse/testing';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';

// Booting PostgreSQL-in-WebAssembly is slow (seconds), so one instance serves the whole file and
// each test starts from an empty schema.
const shared = new PgliteDatabase();
beforeEach(async () => {
  await shared.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
afterAll(() => shared.close());

const freshDb = () => shared;

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';

const insertUser = (
  db: PgliteDatabase,
  { id = U1, email = 'a@example.com', role = 'employee', status = 'active', attempts = 0 } = {},
) =>
  db.query(
    `INSERT INTO users (id, email, display_name, password_hash, role, status, failed_login_attempts, created_at, updated_at)
     VALUES ($1, $2, 'A', 'h', $3, $4, $5, now(), now())`,
    [id, email, role, status, attempts],
  );

describe('identity migrations', () => {
  it('apply to an empty database and are recorded', async () => {
    const db = freshDb();
    const applied = await migrate(db, MIGRATIONS);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('create the transactional outbox table', async () => {
    const db = freshDb();
    await migrate(db, MIGRATIONS);
    const { rows } = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox' ORDER BY column_name",
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      'attempts',
      'created_at',
      'event_type',
      'id',
      'payload',
      'published_at',
    ]);
  });
});

describe('the schema enforces its own invariants (defence in depth)', () => {
  async function migrated() {
    const db = freshDb();
    await migrate(db, MIGRATIONS);
    return db;
  }

  it('rejects an email that is not lower-case, so lookups can never miss a duplicate', async () => {
    const db = await migrated();
    await expect(insertUser(db, { email: 'Mixed@Example.com' })).rejects.toThrow(
      /users_email_lowercase/,
    );
  });

  it('rejects duplicate emails', async () => {
    const db = await migrated();
    await insertUser(db);
    await expect(insertUser(db, { id: U2 })).rejects.toThrow(/users_email_unique/);
  });

  it('rejects unknown roles and statuses and negative attempt counters', async () => {
    const db = await migrated();
    await expect(insertUser(db, { role: 'superuser' })).rejects.toThrow(/users_role_valid/);
    await expect(insertUser(db, { status: 'zombie' })).rejects.toThrow(/users_status_valid/);
    await expect(insertUser(db, { attempts: -1 })).rejects.toThrow(/users_failed_attempts_nonneg/);
  });

  it('enforces case-insensitive unique team names and a real, restricted manager', async () => {
    const db = await migrated();
    await insertUser(db, { role: 'manager' });
    const team = (id: string, name: string, manager = U1) =>
      db.query(
        'INSERT INTO teams (id, name, manager_user_id, created_at) VALUES ($1, $2, $3, now())',
        [id, name, manager],
      );

    await team(T1, 'Platform');
    await expect(team(T2, 'PLATFORM')).rejects.toThrow(/teams_name_unique/);
    await expect(team(T2, 'Other', U2)).rejects.toThrow(/foreign key/);
    await expect(db.query('DELETE FROM users WHERE id = $1', [U1])).rejects.toThrow(/foreign key/);
  });

  it('stores a refresh token hash only once', async () => {
    const db = await migrated();
    await insertUser(db);
    const token = (id: string) =>
      db.query(
        `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, family_started_at, issued_at, expires_at)
         VALUES ($1, $2, $3, 'same-hash', now(), now(), now())`,
        [id, U1, id],
      );
    await token(T1);
    await expect(token(T2)).rejects.toThrow(/refresh_tokens_hash_unique/);
  });
});
