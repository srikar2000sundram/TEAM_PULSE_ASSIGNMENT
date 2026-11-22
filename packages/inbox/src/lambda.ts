import { parseEvent, type EventType, type TeamPulseEvent } from '@teampulse/contracts';

/** Thrown for a delivery that is not the expected event. Carries field names, never content. */
export class InvalidDeliveryError extends Error {
  constructor(
    message: string,
    readonly fields: readonly string[] = [],
  ) {
    super(message);
    this.name = 'InvalidDeliveryError';
  }
}

/**
 * Decodes what EventBridge hands a Lambda target: its envelope, with our event in `detail`.
 *
 * Anything else throws, so Lambda's retry and on-failure destination (a dead-letter queue with an
 * alarm) take over instead of the event silently disappearing. The error and the fields it names
 * never include the event's content, which might be personal data.
 */
export function decodeLambdaEvent<T extends EventType>(
  envelope: unknown,
  expected: T,
): TeamPulseEvent<T> {
  const detail =
    typeof envelope === 'object' && envelope !== null && 'detail' in envelope
      ? envelope.detail
      : undefined;

  const parsed = parseEvent(detail);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.'));
    throw new InvalidDeliveryError(`invalid event (fields: ${fields.join(', ')})`, fields);
  }
  if (parsed.data.eventType !== expected) {
    throw new InvalidDeliveryError(
      `unexpected event type ${parsed.data.eventType}, expected ${expected}`,
    );
  }
  return parsed.data as TeamPulseEvent<T>;
}
