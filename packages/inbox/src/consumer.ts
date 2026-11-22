import { parseEvent, type EventType, type TeamPulseEvent } from '@teampulse/contracts';
import { runWithCorrelationId, type Logger } from '@teampulse/observability';

/** A queue message. `id` identifies it for deletion (an SQS receipt handle). */
export interface Message {
  readonly id: string;
  readonly body: string;
}

/** Port: where messages come from. SQS in production, an in-memory list in tests. */
export interface MessageSource {
  /** Waits up to `waitSeconds` for messages (long polling) and returns at most `max`. */
  receive(max: number, waitSeconds: number): Promise<readonly Message[]>;
  /** Removes a message so it is not delivered again. */
  remove(message: Message): Promise<void>;
}

/**
 * Handlers by event type. They MUST be idempotent: delivery is at-least-once, so the same event can
 * arrive twice, and events can arrive out of order. A handler that throws leaves the message on the
 * queue to be retried.
 */
export type EventHandlers = {
  readonly [T in EventType]?: (event: TeamPulseEvent<T>) => Promise<void>;
};

export interface EventConsumerOptions {
  readonly source: MessageSource;
  readonly handlers: EventHandlers;
  readonly logger: Logger;
  /** Messages per receive call (SQS allows up to 10). */
  readonly batchSize?: number;
  /** Long polling time. Zero in tests. */
  readonly waitSeconds?: number;
}

export interface ConsumerCycleResult {
  /** Handled successfully and removed. */
  readonly handled: number;
  /** Valid events nobody here handles: removed, with a warning (a routing mistake, not an error). */
  readonly ignored: number;
  /** The handler threw: left on the queue for a retry. */
  readonly failed: number;
  /** Not a valid event: left on the queue, so the queue's redrive policy moves it to the DLQ. */
  readonly rejected: number;
}

/**
 * Accepts either a bare event or an EventBridge delivery, whose `detail` field holds our event.
 * Returns undefined when the body is not JSON.
 */
function unwrap(body: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value === 'object' && value !== null && !('eventType' in value) && 'detail' in value) {
    const detail = value.detail;
    // EventBridge normally delivers an object; tolerate a JSON string too.
    if (typeof detail === 'string') {
      try {
        return JSON.parse(detail);
      } catch {
        return undefined;
      }
    }
    return detail;
  }
  return value;
}

/**
 * Reads events from a queue and runs the matching handler for each.
 *
 * What happens to a message decides the retry behaviour, so each outcome is deliberate:
 * - handled or ignored: deleted;
 * - handler failed, or the body is not a valid event: NOT deleted. The queue makes it visible again
 *   after its visibility timeout and, after the configured number of receives, moves it to the
 *   dead-letter queue, where an alarm fires. The consumer needs no retry logic of its own.
 */
export class EventConsumer {
  private readonly batchSize: number;
  private readonly waitSeconds: number;

  constructor(private readonly options: EventConsumerOptions) {
    this.batchSize = options.batchSize ?? 10;
    this.waitSeconds = options.waitSeconds ?? 20;
  }

  async runOnce(): Promise<ConsumerCycleResult> {
    const messages = await this.options.source.receive(this.batchSize, this.waitSeconds);
    let handled = 0;
    let ignored = 0;
    let failed = 0;
    let rejected = 0;

    for (const message of messages) {
      const outcome = await this.process(message);
      if (outcome === 'handled') handled += 1;
      else if (outcome === 'ignored') ignored += 1;
      else if (outcome === 'failed') failed += 1;
      else rejected += 1;
    }
    return { handled, ignored, failed, rejected };
  }

  private async process(message: Message): Promise<'handled' | 'ignored' | 'failed' | 'rejected'> {
    const { logger, handlers } = this.options;

    const parsed = parseEvent(unwrap(message.body));
    if (!parsed.success) {
      // Field paths only: the message body might hold personal data and must not be logged.
      logger.error(
        {
          event: 'consumer.invalid_message',
          messageId: message.id.slice(0, 12),
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
        'message is not a valid event',
      );
      return 'rejected';
    }

    const event = parsed.data;
    const handler = handlers[event.eventType] as ((e: TeamPulseEvent) => Promise<void>) | undefined;

    return runWithCorrelationId(event.correlationId, async () => {
      if (handler === undefined) {
        logger.warn(
          { event: 'consumer.unhandled', eventType: event.eventType, eventId: event.eventId },
          'no handler for this event type, dropping it',
        );
        await this.remove(message);
        return 'ignored';
      }
      try {
        await handler(event);
      } catch (error) {
        logger.error(
          {
            event: 'consumer.handler_failed',
            eventType: event.eventType,
            eventId: event.eventId,
            err: error,
          },
          'handler failed, the message will be retried',
        );
        return 'failed';
      }
      await this.remove(message);
      return 'handled';
    });
  }

  /** A failed delete only means a redelivery, which idempotent handlers absorb. */
  private async remove(message: Message): Promise<void> {
    try {
      await this.options.source.remove(message);
    } catch (error) {
      this.options.logger.warn(
        { event: 'consumer.remove_failed', err: error },
        'could not remove the message, it will be delivered again',
      );
    }
  }

  /** Polls until `signal` aborts. Source errors back off and never end the loop. */
  async run({
    signal,
    errorBackoffMs = 5_000,
  }: {
    signal: AbortSignal;
    errorBackoffMs?: number;
  }): Promise<void> {
    const { logger } = this.options;
    logger.info({ event: 'consumer.started' }, 'event consumer started');
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        logger.error({ event: 'consumer.error', err: error }, 'event consumer cycle failed');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, errorBackoffMs);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
    logger.info({ event: 'consumer.stopped' }, 'event consumer stopped');
  }
}
