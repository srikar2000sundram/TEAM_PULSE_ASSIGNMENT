import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { baseConfigSchema, loadServiceConfig, z } from '@teampulse/config';
import { InvalidDeliveryError, decodeLambdaEvent } from '@teampulse/inbox';
import { SystemClock } from '@teampulse/kernel';
import { createLogger, runWithCorrelationId, type Logger } from '@teampulse/observability';
import { EventBridgePublisher } from '@teampulse/outbox';
import { createEventBridgeClient } from '@teampulse/outbox/aws';
import { DynamoDbStreakStore } from './adapters/dynamodb-streak-store.js';
import { UpdateStreak } from './application/update-streak.js';

/**
 * Lambda entry point for the rule "ActivityCompleted -> streak Lambda".
 *
 * EventBridge invokes the function with its envelope; our own event is in `detail`. Anything that
 * is not a valid ActivityCompleted throws, so Lambda's retry and on-failure destination (a dead
 * letter queue with an alarm) take over instead of the event silently disappearing.
 */
export function createHandler(deps: { updateStreak: UpdateStreak; logger: Logger }) {
  return async (envelope: unknown): Promise<void> => {
    let event;
    try {
      event = decodeLambdaEvent(envelope, 'ActivityCompleted');
    } catch (error) {
      if (error instanceof InvalidDeliveryError) {
        deps.logger.error({ event: 'streak.invalid_event', fields: error.fields }, error.message);
      }
      throw error;
    }
    await runWithCorrelationId(event.correlationId, () => deps.updateStreak.execute(event));
  };
}

const lambdaConfigSchema = baseConfigSchema.extend({
  STREAK_TABLE_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1),
  AWS_REGION: z.string().min(1).optional(),
});

/** Built on the first invocation and reused while the execution environment stays warm. */
let cached: ReturnType<typeof createHandler> | undefined;

/** The function AWS Lambda calls. Credentials come from the function's execution role. */
export const handler = (envelope: unknown): Promise<void> => {
  if (cached === undefined) {
    const config = loadServiceConfig(lambdaConfigSchema);
    const logger = createLogger({
      service: 'streak-lambda',
      level: config.LOG_LEVEL,
      pseudonymSalt: config.LOG_PSEUDONYM_SALT,
    });
    const region = config.AWS_REGION === undefined ? {} : { region: config.AWS_REGION };
    cached = createHandler({
      logger,
      updateStreak: new UpdateStreak({
        store: new DynamoDbStreakStore(
          DynamoDBDocumentClient.from(new DynamoDBClient(region)),
          config.STREAK_TABLE_NAME,
        ),
        publisher: new EventBridgePublisher(createEventBridgeClient(region), config.EVENT_BUS_NAME),
        clock: new SystemClock(),
        logger,
      }),
    });
  }
  return cached(envelope);
};
