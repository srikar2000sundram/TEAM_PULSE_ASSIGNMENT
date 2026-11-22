import { baseConfigSchema, loadServiceConfig, z } from '@teampulse/config';
import type { EventType, TeamPulseEvent } from '@teampulse/contracts';
import { InvalidDeliveryError, decodeLambdaEvent } from '@teampulse/inbox';
import { SystemClock } from '@teampulse/kernel';
import { createLogger, runWithCorrelationId, type Logger } from '@teampulse/observability';
import { EventBridgePublisher } from '@teampulse/outbox';
import { createEventBridgeClient } from '@teampulse/outbox/aws';
import {
  AwardMilestones,
  AwardTotalMilestones,
  type AwardMilestonesDeps,
} from './application/award-milestones.js';

/**
 * Wraps a use case as a Lambda handler for the rule "<EventType> -> this function".
 *
 * Anything that is not a valid event of that type throws, so Lambda's retry and on-failure
 * destination (a dead-letter queue with an alarm) take over instead of the event silently
 * disappearing.
 */
function lambdaFor<T extends EventType>(
  type: T,
  deps: { logger: Logger; run: (event: TeamPulseEvent<T>) => Promise<void> },
) {
  return async (envelope: unknown): Promise<void> => {
    let event: TeamPulseEvent<T>;
    try {
      event = decodeLambdaEvent(envelope, type);
    } catch (error) {
      if (error instanceof InvalidDeliveryError) {
        deps.logger.error({ event: 'badge.invalid_event', fields: error.fields }, error.message);
      }
      throw error;
    }
    await runWithCorrelationId(event.correlationId, () => deps.run(event));
  };
}

/** `StreakUpdated` -> streak milestones. */
export function createHandler(deps: { awardMilestones: AwardMilestones; logger: Logger }) {
  return lambdaFor('StreakUpdated', {
    logger: deps.logger,
    run: (event) => deps.awardMilestones.execute(event),
  });
}

/** `ActivityCompleted` -> total-activity milestones. */
export function createTotalsHandler(deps: {
  awardTotalMilestones: AwardTotalMilestones;
  logger: Logger;
}) {
  return lambdaFor('ActivityCompleted', {
    logger: deps.logger,
    run: (event) => deps.awardTotalMilestones.execute(event),
  });
}

const lambdaConfigSchema = baseConfigSchema.extend({
  EVENT_BUS_NAME: z.string().min(1),
  AWS_REGION: z.string().min(1).optional(),
});

/** Built on the first invocation and reused while the execution environment stays warm. */
let cached: AwardMilestonesDeps | undefined;

function sharedDeps(): AwardMilestonesDeps {
  if (cached === undefined) {
    const config = loadServiceConfig(lambdaConfigSchema);
    const logger = createLogger({
      service: 'badge-lambda',
      level: config.LOG_LEVEL,
      pseudonymSalt: config.LOG_PSEUDONYM_SALT,
    });
    const region = config.AWS_REGION === undefined ? {} : { region: config.AWS_REGION };
    cached = {
      logger,
      clock: new SystemClock(),
      publisher: new EventBridgePublisher(createEventBridgeClient(region), config.EVENT_BUS_NAME),
    };
  }
  return cached;
}

/** Entry point of the function wired to `StreakUpdated`. Credentials come from the execution role. */
export const handler = (envelope: unknown): Promise<void> => {
  const deps = sharedDeps();
  return createHandler({ logger: deps.logger, awardMilestones: new AwardMilestones(deps) })(
    envelope,
  );
};

/** Entry point of the function wired to `ActivityCompleted`. */
export const totalsHandler = (envelope: unknown): Promise<void> => {
  const deps = sharedDeps();
  return createTotalsHandler({
    logger: deps.logger,
    awardTotalMilestones: new AwardTotalMilestones(deps),
  })(envelope);
};
