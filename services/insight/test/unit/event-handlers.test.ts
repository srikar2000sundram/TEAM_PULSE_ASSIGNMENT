import { describe, expect, it } from 'vitest';
import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import { buildInsightEventHandlers } from '../../src/adapters/events/handlers.js';
import { InMemoryAnalyticsStore } from '../support/in-memory.js';
import { TEAM, admin, buildHarness, person, principalOf, uuid } from '../support/harness.js';

const period = { from: '2026-11-01', to: '2026-11-30' };

const activity = (n: number, eventId = uuid(0x5000 + n)): TeamPulseEvent<'ActivityCompleted'> =>
  createEvent('ActivityCompleted', {
    eventId,
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: uuid(0x6000 + n),
    payload: {
      userId: person(n),
      habitId: uuid(0x51),
      teamIds: [TEAM],
      activityType: 'walking',
      activityDate: '2026-11-20',
      totalCompleted: 1,
    },
  });

const userDeleted = (n: number) =>
  createEvent('UserDeleted', {
    eventId: uuid(0x7000 + n),
    occurredAt: new Date('2026-11-21T08:00:00Z'),
    correlationId: uuid(0x8000 + n),
    payload: { userId: person(n) },
  });

describe('Insight event handlers', () => {
  it('ActivityCompleted is counted, and a redelivery is not counted again', async () => {
    const h = buildHarness();
    const handlers = buildInsightEventHandlers(h.app);
    const event = activity(1);
    await handlers.ActivityCompleted?.(event);
    await handlers.ActivityCompleted?.(event);
    const mine = unwrap(
      await h.app.getMyActivity.execute({ actor: principalOf(person(1)), period }),
    );
    expect(mine.total).toBe(1);
  });

  it('UserDeleted takes the person out, and can be delivered twice', async () => {
    const h = buildHarness();
    const handlers = buildInsightEventHandlers(h.app);
    for (let n = 1; n <= 6; n += 1) await handlers.ActivityCompleted?.(activity(n));
    await handlers.UserDeleted?.(userDeleted(1));
    await handlers.UserDeleted?.(userDeleted(1));
    const { report } = unwrap(
      await h.app.getTeamActivity.execute({ actor: admin, teamId: TEAM, period }),
    );
    expect(report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
  });

  it('lets a store failure escape, so the message stays on the queue and is retried', async () => {
    const store = new InMemoryAnalyticsStore();
    const h = buildHarness({ store });
    store.failWith = new Error('ProvisionedThroughputExceededException');
    await expect(buildInsightEventHandlers(h.app).ActivityCompleted?.(activity(1))).rejects.toThrow(
      /Throughput/,
    );
    store.failWith = undefined;
    await buildInsightEventHandlers(h.app).ActivityCompleted?.(activity(1));
    expect(
      unwrap(await h.app.getMyActivity.execute({ actor: principalOf(person(1)), period })).total,
    ).toBe(1);
  });

  it('handles only the events it needs', () => {
    const handlers = buildInsightEventHandlers(buildHarness().app);
    expect(Object.keys(handlers).sort()).toEqual(['ActivityCompleted', 'UserDeleted']);
  });
});
