import { describe, expect, it } from 'vitest';
import {
  EVENT_SCHEMA_VERSION,
  createEvent,
  eventSchemas,
  parseEvent,
  problemDetailsSchema,
  producerFor,
  type EventType,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const USER = id(1);
const TEAM = id(2);
const HABIT = id(3);
const CHALLENGE = id(4);

/** One valid payload per event type. `satisfies` makes the compiler enforce completeness. */
const payloads = {
  ActivityCompleted: {
    userId: USER,
    habitId: HABIT,
    teamIds: [TEAM],
    activityType: 'walking',
    activityDate: '2026-11-20',
    totalCompleted: 12,
  },
  StreakUpdated: {
    userId: USER,
    habitId: HABIT,
    currentStreak: 4,
    longestStreak: 9,
    activityDate: '2026-11-20',
  },
  BadgeAwarded: {
    userId: USER,
    challengeId: CHALLENGE,
    badgeRuleId: id(5),
    kind: 'streak',
    awardedOn: '2026-11-20',
  },
  ChallengeProgressUpdated: {
    challengeId: CHALLENGE,
    userId: USER,
    pointsDelta: 10,
    sourceEventId: id(6),
  },
  MilestoneReached: { userId: USER, kind: 'streak', threshold: 7, habitId: HABIT },
  ChallengeJoined: { challengeId: CHALLENGE, userId: USER, teamId: TEAM },
  ChallengeCompleted: { challengeId: CHALLENGE, completedOn: '2026-12-01' },
  HabitCreated: {
    habitId: HABIT,
    ownerUserId: USER,
    visibility: 'private',
    activityType: 'yoga',
    reminder: { daysOfWeek: ['mon', 'wed'], remindAt: '07:30', timeZone: 'Europe/Berlin' },
  },
  HabitUpdated: {
    habitId: HABIT,
    ownerUserId: USER,
    visibility: 'team',
    activityType: 'yoga',
  },
  HabitArchived: { habitId: HABIT, ownerUserId: USER },
  UserRegistered: { userId: USER, role: 'employee' },
  TeamMembershipChanged: { userId: USER, teamId: TEAM, change: 'added' },
  UserDeleted: { userId: USER },
} satisfies { [T in EventType]: unknown };

const eventTypes = Object.keys(eventSchemas) as EventType[];

function envelope(type: EventType, overrides: Record<string, unknown> = {}) {
  return {
    eventId: id(100),
    eventType: type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: '2026-11-20T08:15:00Z',
    correlationId: id(101),
    producer: producerFor(type),
    payload: payloads[type],
    ...overrides,
  };
}

describe('event registry', () => {
  it('has a fixture for every registered event type', () => {
    expect(Object.keys(payloads).sort()).toEqual([...eventTypes].sort());
  });

  it.each(eventTypes)('%s: a valid event parses and round-trips unchanged', (type) => {
    const raw = envelope(type);
    const parsed = parseEvent(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(raw);
  });

  it.each(eventTypes)('%s: createEvent builds a valid, parseable envelope', (type) => {
    const event = createEvent(type, {
      eventId: id(100),
      occurredAt: new Date('2026-11-20T08:15:00Z'),
      correlationId: id(101),
      payload: payloads[type],
    });
    expect(event.eventType).toBe(type);
    expect(event.producer).toBe(producerFor(type));
    expect(parseEvent(event).success).toBe(true);
  });
});

describe('event privacy and integrity guards', () => {
  it('rejects free text smuggled into a payload (no habit titles on the bus)', () => {
    const raw = envelope('ActivityCompleted', {
      payload: { ...payloads.ActivityCompleted, habitTitle: 'Therapy session' },
    });
    expect(parseEvent(raw).success).toBe(false);
  });

  it('rejects unknown envelope fields', () => {
    expect(parseEvent(envelope('UserDeleted', { extra: 1 })).success).toBe(false);
  });

  it('rejects an event published by a producer that does not own it', () => {
    expect(parseEvent(envelope('ActivityCompleted', { producer: 'habit' })).success).toBe(false);
  });

  it('rejects an unsupported schema version', () => {
    expect(parseEvent(envelope('UserDeleted', { schemaVersion: 2 })).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(parseEvent(envelope('UserDeleted', { eventType: 'Mystery' })).success).toBe(false);
  });

  it('rejects non-UUID identifiers', () => {
    const raw = envelope('ChallengeJoined', {
      payload: { ...payloads.ChallengeJoined, userId: 'alice@example.com' },
    });
    expect(parseEvent(raw).success).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '20-11-2026', '2026-11-20T00:00:00Z'])(
    'rejects invalid activity date %s',
    (activityDate) => {
      const raw = envelope('ActivityCompleted', {
        payload: { ...payloads.ActivityCompleted, activityDate },
      });
      expect(parseEvent(raw).success).toBe(false);
    },
  );

  it('rejects a timestamp without a time zone', () => {
    expect(parseEvent(envelope('UserDeleted', { occurredAt: '2026-11-20T08:15:00' })).success).toBe(
      false,
    );
  });

  it('rejects negative streaks and non-positive point deltas', () => {
    expect(
      parseEvent(
        envelope('StreakUpdated', { payload: { ...payloads.StreakUpdated, currentStreak: -1 } }),
      ).success,
    ).toBe(false);
    expect(
      parseEvent(
        envelope('ChallengeProgressUpdated', {
          payload: { ...payloads.ChallengeProgressUpdated, pointsDelta: 0 },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects an invalid reminder time', () => {
    const raw = envelope('HabitCreated', {
      payload: {
        ...payloads.HabitCreated,
        reminder: { daysOfWeek: ['mon'], remindAt: '25:00' },
      },
    });
    expect(parseEvent(raw).success).toBe(false);
  });

  it('createEvent refuses to build an invalid event at the producer', () => {
    expect(() =>
      createEvent('UserRegistered', {
        eventId: id(100),
        occurredAt: new Date('2026-11-20T08:15:00Z'),
        correlationId: id(101),
        payload: { userId: 'not-a-uuid', role: 'employee' },
      }),
    ).toThrow();
  });
});

describe('problem details', () => {
  it('accepts a well-formed RFC 9457 body', () => {
    const body = {
      type: 'https://teampulse.internal/problems/habit-not-found',
      title: 'Habit not found',
      status: 404,
      code: 'habit.not_found',
      correlationId: id(101),
    };
    expect(problemDetailsSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a non-error status', () => {
    expect(problemDetailsSchema.safeParse({ type: 'x', title: 'y', status: 200 }).success).toBe(
      false,
    );
  });
});
