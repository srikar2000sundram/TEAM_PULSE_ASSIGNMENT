import { createEvent, parseEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import type { EventPublisher, PublishOutcome } from '@teampulse/outbox';
import { describe, expect, it } from 'vitest';
import { AwardTotalMilestones } from '../../src/application/award-milestones.js';
import { DEFAULT_TOTAL_MILESTONES } from '../../src/domain/milestones.js';
import { createTotalsHandler } from '../../src/handler.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const USER = id(0xa1);
const OTHER = id(0xb1);

let counter = 0;
const activity = (totalCompleted: number, userId = USER): TeamPulseEvent<'ActivityCompleted'> =>
  createEvent('ActivityCompleted', {
    eventId: id(0x1000 + ++counter),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: id(0x2000 + counter),
    payload: {
      userId,
      habitId: id(0x51),
      teamIds: [],
      activityType: 'walking',
      activityDate: '2026-11-20',
      totalCompleted,
    },
  });

function setup() {
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
  const award = new AwardTotalMilestones({
    publisher,
    clock: new FixedClock('2026-11-20T09:00:00Z'),
    logger,
  });
  return { award, published, logs, logger, reject: (reason: string) => (rejectWith = reason) };
}

describe('AwardTotalMilestones', () => {
  it('announces a total milestone when the running total hits one', async () => {
    const { award, published } = setup();
    const source = activity(10);
    await award.execute(source);

    expect(published).toHaveLength(1);
    expect(parseEvent(published[0]).success).toBe(true);
    expect(published[0]).toMatchObject({
      eventType: 'MilestoneReached',
      producer: 'badge-lambda',
      correlationId: source.correlationId,
      payload: { userId: USER, kind: 'total', threshold: 10 },
    });
    // A total belongs to the person, not to a habit.
    expect(published[0]?.payload).not.toHaveProperty('habitId');
  });

  it('announces every default threshold and nothing in between', async () => {
    const { award, published } = setup();
    for (let total = 1; total <= 1001; total += 1) await award.execute(activity(total));
    expect(published.map((e) => (e.payload as { threshold: number }).threshold)).toEqual([
      ...DEFAULT_TOTAL_MILESTONES,
    ]);
  });

  it('is safe to run twice, and two activities that saw the same total collapse into one event', async () => {
    const { award, published } = setup();
    await award.execute(activity(50));
    await award.execute(activity(50)); // a different source event, the same total
    expect(published).toHaveLength(2);
    expect(published[1]?.eventId).toBe(published[0]?.eventId);
  });

  it('gives different people and different thresholds different ids', async () => {
    const { award, published } = setup();
    await award.execute(activity(10));
    await award.execute(activity(10, OTHER));
    await award.execute(activity(25));
    expect(new Set(published.map((e) => e.eventId)).size).toBe(3);
  });

  it('fails the invocation when the bus rejects the event, so Lambda retries', async () => {
    const { award, reject } = setup();
    reject('ThrottlingException');
    await expect(award.execute(activity(10))).rejects.toThrow(/ThrottlingException/);
  });

  it('does not log user ids', async () => {
    const { award, logs } = setup();
    await award.execute(activity(10));
    expect(logs.join('\n')).toContain('badge.total_milestone');
    expect(logs.join('\n')).not.toContain(USER);
  });
});

describe('totals Lambda handler', () => {
  const envelope = (detail: unknown) => ({
    version: '0',
    'detail-type': 'ActivityCompleted',
    detail,
  });

  it('processes an EventBridge delivery of ActivityCompleted', async () => {
    const { award, published, logger } = setup();
    await createTotalsHandler({ awardTotalMilestones: award, logger })(envelope(activity(100)));
    expect(published).toHaveLength(1);
  });

  it('throws for an invalid delivery, so Lambda retries and then dead-letters', async () => {
    const { award, published, logger } = setup();
    const handler = createTotalsHandler({ awardTotalMilestones: award, logger });
    await expect(handler(null)).rejects.toThrow();
    await expect(
      handler(envelope({ eventType: 'ActivityCompleted', payload: {} })),
    ).rejects.toThrow();
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
      createTotalsHandler({ awardTotalMilestones: award, logger })(envelope(other)),
    ).rejects.toThrow(/unexpected event type/);
  });
});
