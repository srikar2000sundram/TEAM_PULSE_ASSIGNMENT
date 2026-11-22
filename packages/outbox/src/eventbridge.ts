import type { TeamPulseEvent } from '@teampulse/contracts';
import type { EventPublisher, PublishOutcome } from './relay.js';

/** The slice of `PutEvents` we use, so tests need no AWS SDK and no network. */
export interface PutEventsEntry {
  readonly Source: string;
  readonly DetailType: string;
  readonly Detail: string;
  readonly EventBusName: string;
  readonly Time: Date;
}

export interface PutEventsResult {
  readonly FailedEntryCount?: number | undefined;
  /** One per request entry, in the same order. */
  readonly Entries?:
    | readonly {
        EventId?: string | undefined;
        ErrorCode?: string | undefined;
        ErrorMessage?: string | undefined;
      }[]
    | undefined;
}

export interface EventBridgeClientPort {
  putEvents(entries: readonly PutEventsEntry[]): Promise<PutEventsResult>;
}

/** EventBridge accepts at most 10 entries per PutEvents call. */
const MAX_ENTRIES_PER_CALL = 10;

/**
 * Publishes TeamPulse events to an EventBridge bus.
 *
 * - `Source` is `teampulse.<producer>` and `DetailType` is the event type, which is what the rules
 *   that route events to consumer queues match on.
 * - `Detail` is the whole validated envelope, so a consumer can `parseEvent` it unchanged.
 * - EventBridge reports success or failure per entry, so one bad entry does not fail the batch.
 */
export class EventBridgePublisher implements EventPublisher {
  constructor(
    private readonly client: EventBridgeClientPort,
    private readonly eventBusName: string,
  ) {}

  async publish(events: readonly TeamPulseEvent[]): Promise<readonly PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    for (let start = 0; start < events.length; start += MAX_ENTRIES_PER_CALL) {
      const chunk = events.slice(start, start + MAX_ENTRIES_PER_CALL);
      outcomes.push(...(await this.publishChunk(chunk)));
    }
    return outcomes;
  }

  private async publishChunk(chunk: readonly TeamPulseEvent[]): Promise<PublishOutcome[]> {
    let result: PutEventsResult;
    try {
      result = await this.client.putEvents(
        chunk.map((event) => ({
          Source: `teampulse.${event.producer}`,
          DetailType: event.eventType,
          Detail: JSON.stringify(event),
          EventBusName: this.eventBusName,
          Time: new Date(event.occurredAt),
        })),
      );
    } catch (error) {
      // The whole call failed (network, throttling, credentials): every event in it is retried.
      const reason = error instanceof Error ? error.message : 'PutEvents failed';
      return chunk.map((event) => ({ eventId: event.eventId, error: reason }));
    }

    return chunk.map((event, index) => {
      const entry = result.Entries?.[index];
      // A missing entry is treated as failure: never mark an event published on a guess.
      if (entry === undefined || entry.ErrorCode !== undefined) {
        return {
          eventId: event.eventId,
          error: entry?.ErrorCode ?? 'no result returned for this entry',
        };
      }
      return { eventId: event.eventId };
    });
  }
}
