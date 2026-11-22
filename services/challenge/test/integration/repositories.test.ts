import { migrate } from '@teampulse/db';
import { PgliteDatabase } from '@teampulse/testing';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { InMemoryStore, InMemoryUnitOfWork } from '../support/in-memory.js';
import { repositoryContract, type RepositoryFixture } from '../support/repository-contract.js';

const TABLES =
  'TRUNCATE challenges, badge_rules, participations, progress_ledger, awarded_badges, outbox CASCADE';

// The same behavioural suite, run against the in-memory fakes used by unit tests...
repositoryContract('in-memory', () => {
  let uow = new InMemoryUnitOfWork();
  const fixture: RepositoryFixture = {
    get uow() {
      return uow;
    },
    reset: () => {
      uow = new InMemoryUnitOfWork(new InMemoryStore());
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return Promise.resolve(fixture);
});

// ...and against real PostgreSQL, so the fakes can be trusted.
repositoryContract('PostgreSQL (PGlite)', async () => {
  const db = new PgliteDatabase();
  await migrate(db, MIGRATIONS);
  const fixture: RepositoryFixture = {
    uow: new PostgresUnitOfWork(db),
    reset: async () => {
      await db.exec(TABLES);
    },
    close: () => db.close(),
  };
  return fixture;
});
