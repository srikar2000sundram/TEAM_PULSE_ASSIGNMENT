import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { Database } from '@teampulse/db';
import { SystemClock, type Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { EventBridgePublisher, type EventBridgeClientPort } from './eventbridge.js';
import { OutboxRelay } from './relay.js';

/**
 * Real EventBridge client for production. Credentials come from the ECS task role (default
 * provider chain), never from configuration. Kept out of the package root so importing
 * `EventFactory` does not load the AWS SDK.
 */
export function createEventBridgeClient(options: { region?: string } = {}): EventBridgeClientPort {
  const client = new EventBridgeClient({
    ...(options.region === undefined ? {} : { region: options.region }),
    maxAttempts: 3,
  });
  return {
    async putEvents(entries) {
      const output = await client.send(new PutEventsCommand({ Entries: [...entries] }));
      return {
        FailedEntryCount: output.FailedEntryCount,
        Entries: output.Entries?.map((entry) => ({
          EventId: entry.EventId,
          ErrorCode: entry.ErrorCode,
          ErrorMessage: entry.ErrorMessage,
        })),
      };
    },
  };
}

/** A loop running in the background that can be stopped during graceful shutdown. */
export interface BackgroundTask {
  stop(): Promise<void>;
}

export interface RelaySettings {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Unset means "no bus": the relay does not start and events wait safely in the outbox. */
  readonly eventBusName: string | undefined;
  readonly region?: string | undefined;
  readonly pollIntervalMs: number;
  readonly retentionDays: number;
}

const HOUR_MS = 3_600_000;

/**
 * Starts the outbox relay (and an hourly purge of old published rows) for a service.
 * Returns a handle whose `stop()` ends the loop and waits for the current cycle to finish.
 */
export function startOutboxRelay(settings: RelaySettings): BackgroundTask {
  const { logger } = settings;
  if (settings.eventBusName === undefined) {
    logger.warn(
      { event: 'outbox.relay_disabled' },
      'EVENT_BUS_NAME is not set: events stay in the outbox and are not published',
    );
    return { stop: () => Promise.resolve() };
  }

  const clock = settings.clock ?? new SystemClock();
  const relay = new OutboxRelay({
    db: settings.db,
    clock,
    logger,
    publisher: new EventBridgePublisher(
      createEventBridgeClient(settings.region === undefined ? {} : { region: settings.region }),
      settings.eventBusName,
    ),
  });

  const controller = new AbortController();
  const running = relay.run({ signal: controller.signal, pollIntervalMs: settings.pollIntervalMs });

  const purge = setInterval(() => {
    const cutoff = new Date(clock.now().getTime() - settings.retentionDays * 24 * HOUR_MS);
    relay.purgePublished(cutoff).then(
      (removed) => {
        if (removed > 0)
          logger.info({ event: 'outbox.purged', removed }, 'old outbox rows removed');
      },
      (error: unknown) =>
        logger.error({ event: 'outbox.purge_failed', err: error }, 'outbox purge failed'),
    );
  }, HOUR_MS);
  purge.unref();

  return {
    stop: async () => {
      clearInterval(purge);
      controller.abort();
      await running;
    },
  };
}
