import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from '../common.js';

export const EVENT_SCHEMA_VERSION = 1;

/** Every deployable unit that is allowed to appear as an event producer or log source. */
export const producers = [
  'identity',
  'habit',
  'challenge',
  'event-tracking',
  'insight',
  'notification',
  'streak-lambda',
  'badge-lambda',
  'analytics-lambda',
] as const;
export const producerSchema = z.enum(producers);
export type Producer = z.infer<typeof producerSchema>;

/**
 * Builds the schema of one event type.
 *
 * Both the envelope and the payload are strict: unknown fields are rejected. This is a privacy
 * control, not just tidiness. A producer that tries to attach a habit title or other free text
 * fails validation instead of leaking it into the event bus.
 *
 * Each event is pinned to its one legitimate producer, so a service cannot publish an event it
 * does not own.
 */
export function defineEvent<
  const Type extends string,
  const Source extends Producer,
  Payload extends z.ZodType,
>(type: Type, producer: Source, payload: Payload) {
  return z.strictObject({
    eventId: idSchema,
    eventType: z.literal(type),
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    occurredAt: isoDateTimeSchema,
    correlationId: idSchema,
    producer: z.literal(producer),
    payload,
  });
}
