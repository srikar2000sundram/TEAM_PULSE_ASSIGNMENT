import {
  createEvent,
  type EventPayload,
  type EventType,
  type TeamPulseEvent,
} from '@teampulse/contracts';
import type { Clock, IdGenerator } from '@teampulse/kernel';
import { getCorrelationId } from '@teampulse/observability';

/**
 * Builds validated domain events stamped with the current request's correlation id.
 * `createEvent` parses against the registry, so a payload carrying free text or any undeclared
 * field fails here, before it can reach the outbox.
 */
export class EventFactory {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  create<T extends EventType>(type: T, payload: EventPayload<T>): TeamPulseEvent<T> {
    return createEvent(type, {
      eventId: this.ids.next(),
      occurredAt: this.clock.now(),
      correlationId: getCorrelationId() ?? this.ids.next(),
      payload,
    });
  }
}
