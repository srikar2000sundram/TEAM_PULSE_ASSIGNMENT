import { createHash } from 'node:crypto';
import type { Logger } from '@teampulse/observability';
import { assertSchemaName, type Database } from './database.js';

export interface Migration {
  /** Sortable, never reused, never edited after release. Add a new migration instead. */
  readonly id: string;
  readonly sql: string;
}

/** Arbitrary constant: concurrent runners queue on this lock instead of racing. */
const MIGRATION_LOCK_ID = 7_274_001;

const checksum = (migration: Migration): string =>
  createHash('sha256').update(migration.sql).digest('hex');

interface AppliedRow {
  id: string;
  checksum: string;
}

/**
 * Applies pending migrations in order, each exactly once.
 * - One transaction: either every pending migration applies or none does.
 * - An advisory lock stops two deploying tasks from migrating at the same time.
 * - Checksums catch the classic mistake of editing a migration that already ran.
 * Returns the ids it applied.
 */
export async function migrate(
  db: Database,
  migrations: readonly Migration[],
  logger?: Logger,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map(
      (await tx.query<AppliedRow>('SELECT id, checksum FROM schema_migrations')).rows.map(
        (row) => [row.id, row.checksum] as const,
      ),
    );

    const ids = migrations.map((m) => m.id);
    if (new Set(ids).size !== ids.length || [...ids].sort().join() !== ids.join()) {
      throw new Error('Migration ids must be unique and listed in ascending order');
    }

    const done: string[] = [];
    for (const migration of migrations) {
      const recorded = applied.get(migration.id);
      if (recorded !== undefined) {
        if (recorded !== checksum(migration)) {
          throw new Error(
            `Migration ${migration.id} was modified after it was applied. Add a new migration instead.`,
          );
        }
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        migration.id,
        checksum(migration),
      ]);
      logger?.info({ migration: migration.id }, 'migration applied');
      done.push(migration.id);
    }
    return done;
  });
}

/**
 * Creates the service's schema when missing, then applies its pending migrations. This is what a
 * service's `npm run migrate` command calls. The connecting database user must own the schema.
 */
export async function migrateSchema(
  db: Database,
  schema: string,
  migrations: readonly Migration[],
  logger?: Logger,
): Promise<string[]> {
  // CREATE SCHEMA cannot take a bind parameter, so the name is validated first.
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${assertSchemaName(schema)}`);
  return migrate(db, migrations, logger);
}
