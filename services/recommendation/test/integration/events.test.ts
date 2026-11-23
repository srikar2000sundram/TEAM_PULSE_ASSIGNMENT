import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { EventConsumer, type Message, type MessageSource } from '@teampulse/inbox';
import { createLogger } from '@teampulse/observability';
import { buildRecommendationEventHandlers } from '../../src/adapters/events/handlers.js';
import { ALICE, BOB, WALK, createE2E, uuid, type E2E } from '../support/e2e.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

/** The Recommendation Service reacting to other services' events, through the real consumer. */
function setup() {
  const queue: Message[] = [];
  const source: MessageSource = {
    receive: (max) => Promise.resolve(queue.splice(0, max)),
    remove: () => Promise.resolve(),
  };
  const consumer = new EventConsumer({
    source,
    handlers: buildRecommendationEventHandlers(e2e.useCases),
    logger: createLogger({ service: 'r-consumer-test', level: 'silent', write: () => undefined }),
    waitSeconds: 0,
  });
  let counter = 0;
  const next = () => uuid(0xf000 + ++counter);
  const deliver = (event: TeamPulseEvent) => {
    queue.push({ id: next(), body: JSON.stringify(event) });
    return consumer.runOnce();
  };
  const base = (iso: string) => ({
    eventId: next(),
    occurredAt: new Date(iso),
    correlationId: next(),
  });
  return { deliver, base };
}

const completed = (userId: string) => ({
  userId,
  habitId: WALK,
  teamIds: [],
  activityType: 'walking' as const,
  activityDate: '2026-11-20',
  totalCompleted: 1,
});
const count = async (userId: string) =>
  (await e2e.db.query('SELECT 1 FROM activity_times WHERE user_id = $1', [userId])).rows.length;

describe('turning events into history', () => {
  it('ActivityCompleted stores when the habit was done, once even if delivered twice', async () => {
    const { deliver, base } = setup();
    const event = createEvent('ActivityCompleted', {
      ...base('2026-11-20T06:10:00Z'),
      payload: completed(ALICE),
    });
    expect(await deliver(event)).toMatchObject({ handled: 1 });
    await deliver(event);
    expect(await count(ALICE)).toBe(1);
    const { rows } = await e2e.db.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM activity_times',
    );
    expect(new Date(rows[0]?.occurred_at ?? 0).toISOString()).toBe('2026-11-20T06:10:00.000Z');
  });

  it('stores the time from the event, never from the server clock', async () => {
    const { deliver, base } = setup();
    e2e.clock.set('2030-01-01T00:00:00Z');
    await deliver(
      createEvent('ActivityCompleted', {
        ...base('2026-11-20T06:10:00Z'),
        payload: completed(ALICE),
      }),
    );
    const { rows } = await e2e.db.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM activity_times',
    );
    expect(new Date(rows[0]?.occurred_at ?? 0).getUTCFullYear()).toBe(2026);
  });

  it('UserDeleted erases that person’s history and decisions, and nobody else’s', async () => {
    const { deliver, base } = setup();
    await deliver(
      createEvent('ActivityCompleted', {
        ...base('2026-11-20T06:10:00Z'),
        payload: completed(ALICE),
      }),
    );
    await deliver(
      createEvent('ActivityCompleted', {
        ...base('2026-11-20T06:20:00Z'),
        payload: completed(BOB),
      }),
    );
    await e2e.useCases.decideRecommendation.execute({
      actor: { userId: ALICE, role: 'employee', teamIds: [], managedTeamIds: [] },
      habitId: WALK,
      suggestedTime: '07:00',
      timeZone: 'UTC',
      decision: 'accepted',
    });

    await deliver(
      createEvent('UserDeleted', { ...base('2026-11-21T08:00:00Z'), payload: { userId: ALICE } }),
    );
    expect(await count(ALICE)).toBe(0);
    expect(await count(BOB)).toBe(1);
    expect((await e2e.db.query('SELECT 1 FROM decisions')).rows).toHaveLength(0);
  });
});
