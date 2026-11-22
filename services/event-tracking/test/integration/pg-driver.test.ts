import { PgDatabase, migrate } from '@teampulse/db';
import { startPgWireServer } from '@teampulse/testing';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { repositoryContract, type RepositoryFixture } from '../support/repository-contract.js';

/**
 * The repositories through the class production uses, `PgDatabase`, over the real `pg` driver and
 * the PostgreSQL wire protocol. This is where array parameters (`= ANY($3::uuid[])`), jsonb and
 * timestamp handling meet the real driver.
 */
repositoryContract('PostgreSQL via the real pg driver', async () => {
  const server = await startPgWireServer('event_tracking');
  // The embedded engine serves one connection at a time, hence a pool of one.
  const db = new PgDatabase({
    connectionString: server.url,
    schema: 'event_tracking',
    maxConnections: 1,
    ssl: false,
  });
  await migrate(db, MIGRATIONS);
  const fixture: RepositoryFixture = {
    uow: new PostgresUnitOfWork(db),
    readOutbox: async () =>
      (await db.query<{ payload: unknown }>('SELECT payload FROM outbox')).rows.map(
        (row) => row.payload,
      ),
    reset: async () => {
      await db.exec('TRUNCATE activities, known_habits, outbox');
    },
    close: async () => {
      await db.close();
      await server.close();
    },
  };
  return fixture;
});
