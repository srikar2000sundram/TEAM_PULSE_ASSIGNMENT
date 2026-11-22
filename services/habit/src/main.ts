import { createRemoteJwksVerifier } from '@teampulse/auth/jwt';
import { startEventConsumer } from '@teampulse/inbox/aws';
import { PgDatabase } from '@teampulse/db';
import { startOutboxRelay } from '@teampulse/outbox/aws';
import { runServer } from '@teampulse/http';
import { SystemClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { buildHabitEventHandlers } from './adapters/events/handlers.js';
import { buildHabitApp } from './adapters/http/app.js';
import { PostgresUnitOfWork } from './adapters/persistence/repositories.js';
import { createUseCases } from './application/index.js';
import { loadHabitConfig } from './config/index.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server.
 */
async function main(): Promise<void> {
  const config = loadHabitConfig();

  const logger = createLogger({
    service: 'habit-service',
    level: config.LOG_LEVEL,
    pseudonymSalt: config.LOG_PSEUDONYM_SALT,
  });

  const db = new PgDatabase({
    connectionString: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    maxConnections: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  });

  const useCases = createUseCases({
    uow: new PostgresUnitOfWork(db),
    clock: new SystemClock(),
    ids: new UuidGenerator(),
    logger,
    maxActiveHabits: config.MAX_ACTIVE_HABITS_PER_USER,
  });

  const app = await buildHabitApp({
    logger,
    useCases,
    verifier: createRemoteJwksVerifier(new URL(config.IDENTITY_JWKS_URL), {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    corsOrigins: config.CORS_ORIGINS,
    trustProxy: config.TRUST_PROXY,
    readiness: { database: async () => void (await db.query('SELECT 1')) },
  });

  // Publishes HabitCreated, HabitUpdated and HabitArchived from the outbox.
  const relay = startOutboxRelay({
    db,
    logger,
    eventBusName: config.EVENT_BUS_NAME,
    region: config.AWS_REGION,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    retentionDays: config.OUTBOX_RETENTION_DAYS,
  });
  // Listens for UserDeleted (erasure) and TeamMembershipChanged (stop sharing with a team left).
  const consumer = startEventConsumer({
    queueUrl: config.EVENTS_QUEUE_URL,
    region: config.AWS_REGION,
    handlers: buildHabitEventHandlers(useCases),
    logger,
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await consumer.stop();
      await relay.stop();
      await db.close();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `habit-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
