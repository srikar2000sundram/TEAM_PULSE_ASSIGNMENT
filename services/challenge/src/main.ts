import { createRemoteJwksVerifier } from '@teampulse/auth/jwt';
import { PgDatabase } from '@teampulse/db';
import { runServer } from '@teampulse/http';
import { startEventConsumer } from '@teampulse/inbox/aws';
import { SystemClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { startOutboxRelay } from '@teampulse/outbox/aws';
import { buildChallengeEventHandlers } from './adapters/events/handlers.js';
import { buildChallengeApp } from './adapters/http/app.js';
import { PostgresUnitOfWork } from './adapters/persistence/repositories.js';
import { startChallengeScheduler } from './adapters/scheduler.js';
import { createUseCases } from './application/index.js';
import { loadChallengeConfig } from './config/index.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server together with the
 * outbox relay, the event consumer and the challenge scheduler.
 */
async function main(): Promise<void> {
  const config = loadChallengeConfig();

  const logger = createLogger({
    service: 'challenge-service',
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
    graceDays: config.CHALLENGE_GRACE_DAYS,
  });

  const app = await buildChallengeApp({
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

  // Publishes ChallengeJoined, ChallengeCompleted, ChallengeProgressUpdated and BadgeAwarded.
  const relay = startOutboxRelay({
    db,
    logger,
    eventBusName: config.EVENT_BUS_NAME,
    region: config.AWS_REGION,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    retentionDays: config.OUTBOX_RETENTION_DAYS,
  });
  // Scores activities, withdraws people who left a team and erases deleted users.
  const consumer = startEventConsumer({
    queueUrl: config.EVENTS_QUEUE_URL,
    region: config.AWS_REGION,
    handlers: buildChallengeEventHandlers(useCases),
    logger,
  });
  const scheduler = startChallengeScheduler({
    useCases,
    logger,
    tickSeconds: config.CHALLENGE_TICK_SECONDS,
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await scheduler.stop();
      await consumer.stop();
      await relay.stop();
      await db.close();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `challenge-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
