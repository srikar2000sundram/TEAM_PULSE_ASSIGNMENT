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

const ID = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-0000000000a1';
const insert = (
  o: {
    title?: string;
    description?: string | null;
    type?: string;
    visibility?: string;
    team?: string | null;
  } = {},
) =>
  db.query(
    `INSERT INTO habits (id, owner_user_id, title, description, activity_type, visibility, team_id, created_at, updated_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, now(), now())`,
    [
      ID,
      o.title ?? 'Walk',
      o.description ?? null,
      o.type ?? 'walking',
      o.visibility ?? 'private',
      o.team ?? null,
    ],
  );

describe('the schema enforces its own invariants (defence in depth)', () => {
  it('creates the habits table and the outbox', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('habits', 'outbox') ORDER BY 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual(['habits', 'outbox']);
  });

  it('accepts a valid private and a valid team habit', async () => {
    await insert();
    await expect(
      db.query('DELETE FROM habits').then(() => insert({ visibility: 'team', team: TEAM })),
    ).resolves.toBeDefined();
  });

  it('rejects empty and over-long titles and descriptions', async () => {
    await expect(insert({ title: '' })).rejects.toThrow(/habits_title_length/);
    await expect(insert({ title: 'x'.repeat(81) })).rejects.toThrow(/habits_title_length/);
    await expect(insert({ description: 'x'.repeat(501) })).rejects.toThrow(
      /habits_description_length/,
    );
  });

  it('rejects unknown activity types and visibilities', async () => {
    await expect(insert({ type: 'skydiving' })).rejects.toThrow(/habits_activity_type_valid/);
    await expect(insert({ visibility: 'public' })).rejects.toThrow(/habits_visibility_valid/);
  });

  it('rejects half-shared habits: team without a team id, and private with one', async () => {
    await expect(insert({ visibility: 'team', team: null })).rejects.toThrow(
      /habits_team_matches_visibility/,
    );
    await expect(insert({ visibility: 'private', team: TEAM })).rejects.toThrow(
      /habits_team_matches_visibility/,
    );
  });

  it('rejects a duplicate id', async () => {
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|habits_pkey/);
  });
});
