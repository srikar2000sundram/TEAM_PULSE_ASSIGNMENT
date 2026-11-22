import { createRemoteJwksVerifier } from '@teampulse/auth/jwt';
import { PgDatabase } from '@teampulse/db';
import { runServer } from '@teampulse/http';
import { startEventConsumer } from '@teampulse/inbox/aws';
import { SystemClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { buildNotificationEventHandlers } from './adapters/events/handlers.js';
import { buildNotificationApp } from './adapters/http/app.js';
import { PostgresUnitOfWork } from './adapters/persistence/repositories.js';
import { startReminderScheduler } from './adapters/scheduler.js';
import { createUseCases } from './application/index.js';
import { loadNotificationConfig } from './config/index.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server together with the
 * event consumer and the reminder scheduler.
 */
async function main(): Promise<void> {
  const config = loadNotificationConfig();

  const logger = createLogger({
    service: 'notification-service',
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
    reminderWindowMinutes: config.REMINDER_WINDOW_MINUTES,
  });

  const app = await buildNotificationApp({
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

  // Turns milestones, badges, challenge results and habit changes into notifications.
  const consumer = startEventConsumer({
    queueUrl: config.EVENTS_QUEUE_URL,
    region: config.AWS_REGION,
    handlers: buildNotificationEventHandlers(useCases),
    logger,
  });
  const scheduler = startReminderScheduler({
    useCases,
    logger,
    tickSeconds: config.REMINDER_TICK_SECONDS,
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await scheduler.stop();
      await consumer.stop();
      await db.close();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `notification-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
