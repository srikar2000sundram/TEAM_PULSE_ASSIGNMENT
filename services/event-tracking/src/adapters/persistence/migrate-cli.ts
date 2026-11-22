import { loadServiceConfig } from '@teampulse/config';
import { PgDatabase, migrateSchema } from '@teampulse/db';
import { createLogger } from '@teampulse/observability';
import { databaseOnlySchema } from '../../config/index.js';
import { MIGRATIONS } from './migrations.js';

/**
 * `npm run migrate`: applies pending migrations. Run it as a one-off task before deploying a new
 * version (not at service start-up, where several tasks would race), with a database user that
 * owns the schema; the running service's user only needs read/write on the tables.
 */
async function main(): Promise<void> {
  const config = loadServiceConfig(databaseOnlySchema);
  const logger = createLogger({ service: 'event-tracking-migrate', level: config.LOG_LEVEL });
  const db = new PgDatabase({
    connectionString: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    maxConnections: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  });
  try {
    const applied = await migrateSchema(db, config.DATABASE_SCHEMA, MIGRATIONS, logger);
    logger.info(
      { applied },
      applied.length === 0 ? 'database is up to date' : 'migrations applied',
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
