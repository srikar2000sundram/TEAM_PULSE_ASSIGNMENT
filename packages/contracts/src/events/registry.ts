import { z } from 'zod';
import { EVENT_SCHEMA_VERSION, defineEvent, type Producer } from './envelope.js';
import {
  activityCompletedPayload,
  badgeAwardedPayload,
  challengeCompletedPayload,
  challengeJoinedPayload,
  challengeProgressUpdatedPayload,
  habitArchivedPayload,
  habitCreatedPayload,
  habitUpdatedPayload,
  milestoneReachedPayload,
  streakUpdatedPayload,
  teamMembershipChangedPayload,
  userDeletedPayload,
  userRegisteredPayload,
} from './payloads.js';

const activityCompleted = defineEvent(
  'ActivityCompleted',
  'event-tracking',
  activityCompletedPayload,
);
const streakUpdated = defineEvent('StreakUpdated', 'streak-lambda', streakUpdatedPayload);
// Challenge scoring and challenge badges belong to the Challenge Service (ADR-0018), so it publishes them.
const badgeAwarded = defineEvent('BadgeAwarded', 'challenge', badgeAwardedPayload);
const challengeProgressUpdated = defineEvent(
  'ChallengeProgressUpdated',
  'challenge',
  challengeProgressUpdatedPayload,
);
const milestoneReached = defineEvent('MilestoneReached', 'badge-lambda', milestoneReachedPayload);
const challengeJoined = defineEvent('ChallengeJoined', 'challenge', challengeJoinedPayload);
const challengeCompleted = defineEvent(
  'ChallengeCompleted',
  'challenge',
  challengeCompletedPayload,
);
const habitCreated = defineEvent('HabitCreated', 'habit', habitCreatedPayload);
const habitUpdated = defineEvent('HabitUpdated', 'habit', habitUpdatedPayload);
const habitArchived = defineEvent('HabitArchived', 'habit', habitArchivedPayload);
const userRegistered = defineEvent('UserRegistered', 'identity', userRegisteredPayload);
const teamMembershipChanged = defineEvent(
  'TeamMembershipChanged',
  'identity',
  teamMembershipChangedPayload,
);
const userDeleted = defineEvent('UserDeleted', 'identity', userDeletedPayload);

/** The single source of truth for what may travel on the bus. Matches the event catalogue in docs. */
export const eventSchemas = {
  ActivityCompleted: activityCompleted,
  StreakUpdated: streakUpdated,
  BadgeAwarded: badgeAwarded,
  ChallengeProgressUpdated: challengeProgressUpdated,
  MilestoneReached: milestoneReached,
  ChallengeJoined: challengeJoined,
  ChallengeCompleted: challengeCompleted,
  HabitCreated: habitCreated,
  HabitUpdated: habitUpdated,
  HabitArchived: habitArchived,
  UserRegistered: userRegistered,
  TeamMembershipChanged: teamMembershipChanged,
  UserDeleted: userDeleted,
} as const;

export type EventType = keyof typeof eventSchemas;
export type TeamPulseEvent<T extends EventType = EventType> = z.infer<(typeof eventSchemas)[T]>;
export type EventPayload<T extends EventType> = TeamPulseEvent<T>['payload'];

/** Validates an unknown value (for example an SQS message body) as any known event. */
export const anyEventSchema = z.discriminatedUnion(
  'eventType',
  // Derived from the registry, so a newly registered event can never be missing from the union.
  Object.values(eventSchemas) as unknown as [
    (typeof eventSchemas)[EventType],
    ...(typeof eventSchemas)[EventType][],
  ],
);

export function parseEvent(raw: unknown) {
  return anyEventSchema.safeParse(raw);
}

export interface CreateEventInput<T extends EventType> {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly payload: EventPayload<T>;
}

/**
 * Producer-side helper: assembles the envelope and validates the result, so a malformed event
 * fails at the producer with a clear error instead of poisoning every consumer.
 * Time and ids are passed in (not generated) to keep callers deterministic and testable.
 */
export function createEvent<T extends EventType>(
  type: T,
  input: CreateEventInput<T>,
): TeamPulseEvent<T> {
  // The runtime parse is what guarantees the shape; the assertion only tells the compiler which
  // member of the union `type` selected, which TypeScript cannot infer through a generic index.
  const schema: z.ZodType = eventSchemas[type];
  return schema.parse({
    eventId: input.eventId,
    eventType: type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: input.occurredAt.toISOString(),
    correlationId: input.correlationId,
    producer: producerFor(type),
    payload: input.payload,
  }) as TeamPulseEvent<T>;
}

/** Which producer owns each event type. Derived from the schemas so it cannot drift. */
export function producerFor(type: EventType): Producer {
  return eventSchemas[type].shape.producer.value;
}
