import { PgDatabase, migrate } from '@teampulse/db';
import { startPgWireServer, type PgWireServer } from '@teampulse/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { repositoryContract, type RepositoryFixture } from '../support/repository-contract.js';

/**
 * Everything else in the suite talks to PGlite directly. This file runs the repositories through
 * the class production actually uses, `PgDatabase`, over the real `pg` driver and the PostgreSQL
 * wire protocol. (The class's own behaviour is tested in packages/db.)
 */

const SCHEMA = 'identity';

const connect = (server: PgWireServer) =>
  // The embedded engine serves one connection at a time, hence a pool of one.
  new PgDatabase({ connectionString: server.url, schema: SCHEMA, maxConnections: 1, ssl: false });

repositoryContract('PostgreSQL via the real pg driver', async () => {
  const server = await startPgWireServer(SCHEMA);
  const db = connect(server);
  await migrate(db, MIGRATIONS);
  const fixture: RepositoryFixture = {
    uow: new PostgresUnitOfWork(db),
    readOutbox: async () =>
      (await db.query<{ payload: unknown }>('SELECT payload FROM outbox')).rows.map(
        (row) => row.payload,
      ),
    reset: async () => {
      await db.exec('TRUNCATE users, teams, team_members, refresh_tokens, outbox CASCADE');
    },
    close: async () => {
      await db.close();
      await server.close();
    },
  };
  return fixture;
});

describe('identity schema through PgDatabase', () => {
  let server: PgWireServer;
  let db: PgDatabase;

  beforeAll(async () => {
    server = await startPgWireServer(SCHEMA);
    db = connect(server);
    await migrate(db, MIGRATIONS);
  });
  afterAll(async () => {
    await db.close();
    await server.close();
  });

  it('keeps every table inside the service schema', async () => {
    const { rows } = await db.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name IN ('users', 'teams', 'refresh_tokens', 'outbox', 'schema_migrations')`,
    );
    expect(rows.length).toBe(5);
    expect(new Set(rows.map((row) => row.table_schema))).toEqual(new Set([SCHEMA]));
  });
});
