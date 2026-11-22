import type { TeamPulseEvent } from '@teampulse/contracts';
import type { EventPublisher } from '@teampulse/outbox';

/**
 * Publishes one event or throws. Failing the invocation makes Lambda retry it, which is the retry
 * we want: the derived event id is stable, so the retry sends the same event.
 */
export async function publishOrThrow(
  publisher: EventPublisher,
  event: TeamPulseEvent,
): Promise<void> {
  const [outcome] = await publisher.publish([event]);
  if (outcome?.error !== undefined) {
    throw new Error(`${event.eventType} was not published: ${outcome.error}`);
  }
}
