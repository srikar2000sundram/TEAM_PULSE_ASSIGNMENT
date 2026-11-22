import { PgliteDatabase } from '@teampulse/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, migrateSchema, type Migration } from '../../src/index.js';

// Booting PostgreSQL-in-WebAssembly takes seconds, so one instance serves the file and each test
// starts from an empty database.
const db = new PgliteDatabase();
beforeEach(async () => {
  await db.exec('DROP SCHEMA IF EXISTS extra CASCADE');
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
afterAll(() => db.close());

const create = (id: string, table: string): Migration => ({
  id,
  sql: `CREATE TABLE ${table} (id int);`,
});
const FIRST: readonly Migration[] = [create('0001_a', 'a')];

describe('migration runner', () => {
  it('applies every migration to an empty database and records them', async () => {
    const migrations = [create('0001_a', 'a'), create('0002_b', 'b')];
    expect(await migrate(db, migrations)).toEqual(['0001_a', '0002_b']);

    const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['0001_a', '0002_b']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await migrate(db, FIRST);
    expect(await migrate(db, FIRST)).toEqual([]);
  });

  it('applies only the new migration when one is added later', async () => {
    await migrate(db, FIRST);
    const next = { id: '0002_add_note', sql: 'ALTER TABLE a ADD COLUMN note text;' };
    expect(await migrate(db, [...FIRST, next])).toEqual(['0002_add_note']);
    await expect(db.query('SELECT note FROM a')).resolves.toBeDefined();
  });

  it('refuses to run when an already-applied migration was edited', async () => {
    await migrate(db, FIRST);
    const tampered = [{ ...FIRST[0]!, sql: `${FIRST[0]!.sql}\n-- sneaky edit` }];
    await expect(migrate(db, tampered)).rejects.toThrow(/modified after it was applied/);
  });

  it('is all-or-nothing: a failing migration leaves no partial schema behind', async () => {
    const broken = [
      create('0001_ok', 'a'),
      { id: '0002_bad', sql: 'CREATE TABLE b (id int); SELECT * FROM does_not_exist;' },
    ];
    await expect(migrate(db, broken)).rejects.toThrow();
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('a', 'b', 'schema_migrations')`,
    );
    expect(rows).toEqual([]);
  });

  it('rejects duplicate or out-of-order migration ids', async () => {
    const m = (id: string) => ({ id, sql: 'SELECT 1' });
    await expect(migrate(db, [m('0002'), m('0001')])).rejects.toThrow(/ascending/);
    await expect(migrate(db, [m('0001'), m('0001')])).rejects.toThrow(/unique/);
  });
});

describe('migrateSchema', () => {
  it('creates the schema first, then migrates', async () => {
    expect(await migrateSchema(db, 'extra', [])).toEqual([]);
    const { rows } = await db.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'extra'",
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a schema name that could inject SQL', async () => {
    await expect(migrateSchema(db, 'x; DROP TABLE a', [])).rejects.toThrow(/Invalid schema name/);
  });
});
