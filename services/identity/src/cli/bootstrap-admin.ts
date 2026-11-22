import { loadServiceConfig, z } from '@teampulse/config';
import { SystemClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { PgDatabase } from '@teampulse/db';
import { EventFactory } from '@teampulse/outbox';
import { PostgresUnitOfWork } from '../adapters/persistence/repositories.js';
import { Argon2PasswordHasher } from '../adapters/security/argon2-password-hasher.js';
import { BootstrapAdmin } from '../application/index.js';
import { databaseOnlySchema } from '../config/index.js';

const schema = databaseOnlySchema.extend({
  ADMIN_EMAIL: z.string().min(1),
  ADMIN_DISPLAY_NAME: z.string().min(1).default('Administrator'),
  ADMIN_PASSWORD: z.string().min(1),
});

/**
 * `npm run bootstrap-admin`: creates the very first administrator. It refuses to run once an
 * administrator exists, so it cannot be abused as a back door. Run it once, as a one-off task, with
 * the password injected from Secrets Manager, and rotate that password on first sign-in.
 */
async function main(): Promise<void> {
  const config = loadServiceConfig(schema);
  const logger = createLogger({
    service: 'identity-bootstrap',
    level: config.LOG_LEVEL,
    pseudonymSalt: config.LOG_PSEUDONYM_SALT,
  });
  const db = new PgDatabase({
    connectionString: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    maxConnections: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  });
  try {
    const clock = new SystemClock();
    const ids = new UuidGenerator();
    const bootstrap = new BootstrapAdmin({
      uow: new PostgresUnitOfWork(db),
      hasher: new Argon2PasswordHasher(),
      clock,
      ids,
      events: new EventFactory(clock, ids),
      logger,
    });
    const result = await bootstrap.execute({
      email: config.ADMIN_EMAIL,
      displayName: config.ADMIN_DISPLAY_NAME,
      password: config.ADMIN_PASSWORD,
    });
    if (!result.ok) {
      process.stderr.write(`bootstrap failed: ${result.error.code}: ${result.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`administrator created: ${result.value.id}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
