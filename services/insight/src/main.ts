import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createRemoteJwksVerifier } from '@teampulse/auth/jwt';
import { runServer } from '@teampulse/http';
import { startEventConsumer } from '@teampulse/inbox/aws';
import { SystemClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { DynamoDbAnalyticsStore } from './adapters/dynamodb-store.js';
import { buildInsightEventHandlers } from './adapters/events/handlers.js';
import { buildInsightApp } from './adapters/http/app.js';
import { HmacPseudonymizer } from './adapters/hmac-pseudonymizer.js';
import { createUseCases } from './application/index.js';
import { loadInsightConfig } from './config/index.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server together with the
 * event consumer. AWS credentials come from the task role, never from configuration.
 */
async function main(): Promise<void> {
  const config = loadInsightConfig();

  const logger = createLogger({
    service: 'insight-service',
    level: config.LOG_LEVEL,
    pseudonymSalt: config.LOG_PSEUDONYM_SALT,
  });

  const store = new DynamoDbAnalyticsStore(
    DynamoDBDocumentClient.from(
      new DynamoDBClient(config.AWS_REGION === undefined ? {} : { region: config.AWS_REGION }),
    ),
    { aggregates: config.AGGREGATES_TABLE_NAME, personal: config.PERSONAL_TABLE_NAME },
  );

  const useCases = createUseCases({
    store,
    pseudonyms: new HmacPseudonymizer(config.INSIGHT_PSEUDONYM_KEY),
    clock: new SystemClock(),
    logger,
    minCohortSize: config.MIN_COHORT_SIZE,
    retentionDays: config.RETENTION_DAYS,
  });

  const app = await buildInsightApp({
    logger,
    useCases,
    verifier: createRemoteJwksVerifier(new URL(config.IDENTITY_JWKS_URL), {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    corsOrigins: config.CORS_ORIGINS,
    trustProxy: config.TRUST_PROXY,
    readiness: { database: () => store.ping() },
  });

  // Counts activities and erases a deleted person's contribution.
  const consumer = startEventConsumer({
    queueUrl: config.EVENTS_QUEUE_URL,
    region: config.AWS_REGION,
    handlers: buildInsightEventHandlers(useCases),
    logger,
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await consumer.stop();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `insight-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
