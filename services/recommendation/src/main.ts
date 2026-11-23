import { createRemoteJwksVerifier } from '@teampulse/auth/jwt';
import { PgDatabase } from '@teampulse/db';
import { runServer } from '@teampulse/http';
import { startEventConsumer } from '@teampulse/inbox/aws';
import { SystemClock, startPeriodicTask } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { buildRecommendationEventHandlers } from './adapters/events/handlers.js';
import { buildRecommendationApp } from './adapters/http/app.js';
import { PostgresUnitOfWork } from './adapters/persistence/repositories.js';
import { createUseCases } from './application/index.js';
import { loadRecommendationConfig } from './config/index.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server together with the
 * event consumer and the housekeeping timer.
 */
async function main(): Promise<void> {
  const config = loadRecommendationConfig();

  const logger = createLogger({
    service: 'recommendation-service',
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
    logger,
  });

  const app = await buildRecommendationApp({
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

  // Remembers when people do their habits, and forgets people who are deleted.
  const consumer = startEventConsumer({
    queueUrl: config.EVENTS_QUEUE_URL,
    region: config.AWS_REGION,
    handlers: buildRecommendationEventHandlers(useCases),
    logger,
  });
  const purge = startPeriodicTask({
    intervalMs: config.PURGE_INTERVAL_MINUTES * 60_000,
    run: async () => void (await useCases.purgeOldActivityTimes.execute()),
    onError: (error) =>
      logger.error({ event: 'recommendation.purge_failed', err: error }, 'purge failed'),
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await purge.stop();
      await consumer.stop();
      await db.close();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `recommendation-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
