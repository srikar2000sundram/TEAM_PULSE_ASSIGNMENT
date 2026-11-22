import { createEvent, parseEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import type { EventPublisher, PublishOutcome } from '@teampulse/outbox';
import { describe, expect, it } from 'vitest';
import { AwardMilestones } from '../../src/application/award-milestones.js';
import { DEFAULT_STREAK_MILESTONES, milestoneReached } from '../../src/domain/milestones.js';
import { createHandler } from '../../src/handler.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const USER = id(0xa1);
const HABIT = id(0x51);

let counter = 0;
const streakUpdated = (currentStreak: number, eventId?: string): TeamPulseEvent<'StreakUpdated'> =>
  createEvent('StreakUpdated', {
    eventId: eventId ?? id(0x1000 + ++counter),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: id(0x2000 + counter),
    payload: {
      userId: USER,
      habitId: HABIT,
      currentStreak,
      longestStreak: currentStreak,
      activityDate: '2026-11-20',
    },
  });

function setup(milestones?: readonly number[]) {
  const published: TeamPulseEvent[] = [];
  let rejectWith: string | undefined;
  const publisher: EventPublisher = {
    publish: (events): Promise<readonly PublishOutcome[]> => {
      if (rejectWith !== undefined) {
        const error = rejectWith;
        return Promise.resolve(events.map((e) => ({ eventId: e.eventId, error })));
      }
      published.push(...events);
      return Promise.resolve(events.map((e) => ({ eventId: e.eventId })));
    },
  };
  const logs: string[] = [];
  const logger = createLogger({
    service: 'badge-test',
    level: 'debug',
    write: (l) => logs.push(l),
  });
  const award = new AwardMilestones({
    publisher,
    clock: new FixedClock('2026-11-20T09:00:00Z'),
    logger,
    ...(milestones === undefined ? {} : { milestones }),
  });
  return {
    award,
    published,
    logs,
    logger,
    reject: (reason: string) => (rejectWith = reason),
  };
}

describe('milestoneReached', () => {
  it('matches only the exact milestone lengths', () => {
    for (const length of DEFAULT_STREAK_MILESTONES) expect(milestoneReached(length)).toBe(length);
    for (const length of [1, 6, 8, 29, 31, 99, 101]) expect(milestoneReached(length)).toBeNull();
  });

  it('accepts custom milestones', () => {
    expect(milestoneReached(3, [3, 5])).toBe(3);
    expect(milestoneReached(7, [3, 5])).toBeNull();
  });
});

describe('AwardMilestones', () => {
  it('announces MilestoneReached when a streak hits a milestone', async () => {
    const { award, published } = setup();
    const source = streakUpdated(7);
    await award.execute(source);

    expect(published).toHaveLength(1);
    expect(parseEvent(published[0]).success).toBe(true);
    expect(published[0]).toMatchObject({
      eventType: 'MilestoneReached',
      producer: 'badge-lambda',
      correlationId: source.correlationId,
      payload: { userId: USER, kind: 'streak', threshold: 7, habitId: HABIT },
    });
  });

  it('publishes nothing between milestones', async () => {
    const { award, published } = setup();
    for (const length of [1, 2, 6, 8, 29]) await award.execute(streakUpdated(length));
    expect(published).toEqual([]);
  });

  it('is safe to run twice: the same source event gives the same MilestoneReached id', async () => {
    const { award, published } = setup();
    const source = streakUpdated(30);
    await award.execute(source);
    await award.execute(source);
    expect(published).toHaveLength(2);
    expect(published[1]?.eventId).toBe(published[0]?.eventId);
  });

  it('a streak that rebuilds to the milestone is a new achievement with a new id', async () => {
    const { award, published } = setup();
    await award.execute(streakUpdated(7));
    await award.execute(streakUpdated(7));
    expect(new Set(published.map((e) => e.eventId)).size).toBe(2);
  });

  it('fails the invocation when the bus rejects the event, so Lambda retries', async () => {
    const { award, reject } = setup();
    reject('ThrottlingException');
    await expect(award.execute(streakUpdated(7))).rejects.toThrow(/ThrottlingException/);
  });

  it('does not log user ids', async () => {
    const { award, logs } = setup();
    await award.execute(streakUpdated(7));
    expect(logs.join('\n')).toContain('badge.milestone');
    expect(logs.join('\n')).not.toContain(USER);
  });
});

describe('badge Lambda handler', () => {
  const envelope = (detail: unknown) => ({ version: '0', 'detail-type': 'StreakUpdated', detail });

  it('processes an EventBridge delivery of StreakUpdated', async () => {
    const { award, published, logger } = setup();
    await createHandler({ awardMilestones: award, logger })(envelope(streakUpdated(14)));
    expect(published).toHaveLength(1);
  });

  it.each([
    ['no detail', { version: '0' }],
    ['null', null],
    ['an invalid detail', envelope({ eventType: 'StreakUpdated', payload: {} })],
  ])('throws for %s, so Lambda retries and then dead-letters', async (_name, input) => {
    const { award, published, logger } = setup();
    await expect(createHandler({ awardMilestones: award, logger })(input)).rejects.toThrow();
    expect(published).toEqual([]);
  });

  it('rejects a valid event of another type', async () => {
    const { award, logger } = setup();
    const other = createEvent('UserDeleted', {
      eventId: id(1),
      occurredAt: new Date('2026-11-20T08:00:00Z'),
      correlationId: id(2),
      payload: { userId: USER },
    });
    await expect(
      createHandler({ awardMilestones: award, logger })(envelope(other)),
    ).rejects.toThrow(/unexpected event type/);
  });
});
