import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { EventConsumer, type Message, type MessageSource } from '@teampulse/inbox';
import { createLogger } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import { buildEventTrackingEventHandlers } from '../../src/adapters/events/handlers.js';
import { ALICE, BOB, HABIT, TODAY, buildHarness, principal } from '../support/harness.js';

/** The Event Tracking Service reacting to other services' events, through the real consumer. */
function setup() {
  const h = buildHarness();
  const queue: Message[] = [];
  const source: MessageSource = {
    receive: (max) => Promise.resolve(queue.splice(0, max)),
    remove: () => Promise.resolve(),
  };
  const consumer = new EventConsumer({
    source,
    handlers: buildEventTrackingEventHandlers(h.app),
    logger: createLogger({ service: 'et-consumer-test', level: 'silent', write: () => undefined }),
    waitSeconds: 0,
  });
  let counter = 0;
  const next = () =>
    `00000000-0000-4000-8000-${(0xe000 + ++counter).toString(16).padStart(12, '0')}`;
  const deliver = (event: TeamPulseEvent) => {
    queue.push({ id: next(), body: JSON.stringify(event) });
    return consumer.runOnce();
  };
  const at = (iso: string) => ({
    eventId: next(),
    occurredAt: new Date(iso),
    correlationId: next(),
  });
  return { h, deliver, at };
}

const created = (
  base: ReturnType<ReturnType<typeof setup>['at']>,
  activityType: 'walking' | 'yoga' | 'running' = 'walking',
) =>
  createEvent('HabitCreated', {
    ...base,
    payload: { habitId: HABIT, ownerUserId: ALICE, visibility: 'private', activityType },
  });
const updated = (
  base: ReturnType<ReturnType<typeof setup>['at']>,
  activityType: 'walking' | 'yoga' | 'running',
) =>
  createEvent('HabitUpdated', {
    ...base,
    payload: { habitId: HABIT, ownerUserId: ALICE, visibility: 'private', activityType },
  });
const archived = (base: ReturnType<ReturnType<typeof setup>['at']>) =>
  createEvent('HabitArchived', { ...base, payload: { habitId: HABIT, ownerUserId: ALICE } });

const alice = principal(ALICE);

describe('learning about habits from events', () => {
  it('HabitCreated makes the habit recordable', async () => {
    const { h, deliver, at } = setup();
    expect((await h.record(alice)).ok).toBe(false);
    await deliver(created(at('2026-11-01T08:00:00Z')));
    expect((await h.record(alice)).ok).toBe(true);
  });

  it('a redelivered event changes nothing', async () => {
    const { h, deliver, at } = setup();
    const event = created(at('2026-11-01T08:00:00Z'));
    await deliver(event);
    await deliver(event);
    expect(h.uow.store.habits.size).toBe(1);
  });

  it('the newest update wins, even when updates arrive out of order', async () => {
    const { h, deliver, at } = setup();
    await deliver(created(at('2026-11-01T08:00:00Z'), 'walking'));
    await deliver(updated(at('2026-11-03T08:00:00Z'), 'running')); // newer, arrives first
    await deliver(updated(at('2026-11-02T08:00:00Z'), 'yoga')); // older, arrives late
    expect(h.uow.store.habits.get(HABIT)?.activityType).toBe('running');
  });

  it('archiving is permanent: a late update never revives the habit', async () => {
    const { h, deliver, at } = setup();
    await deliver(created(at('2026-11-01T08:00:00Z')));
    await deliver(archived(at('2026-11-05T08:00:00Z')));
    await deliver(updated(at('2026-11-04T08:00:00Z'), 'yoga')); // older update arrives after archive
    expect(h.uow.store.habits.get(HABIT)?.archived).toBe(true);
    const result = await h.record(alice);
    expect(!result.ok && result.error.code).toBe('habit.archived');
  });

  it('handles the archive arriving before the creation', async () => {
    const { h, deliver, at } = setup();
    await deliver(archived(at('2026-11-05T08:00:00Z')));
    expect(h.uow.store.habits.get(HABIT)).toMatchObject({ archived: true, activityType: null });

    await deliver(created(at('2026-11-01T08:00:00Z'), 'yoga'));
    // The type is filled in, but the habit stays archived.
    expect(h.uow.store.habits.get(HABIT)).toMatchObject({ archived: true, activityType: 'yoga' });
  });

  it('a habit known only as archived (type unknown) cannot be recorded against', async () => {
    const { h, deliver, at } = setup();
    await deliver(archived(at('2026-11-05T08:00:00Z')));
    expect((await h.record(alice)).ok).toBe(false);
  });
});

describe('erasure', () => {
  it('UserDeleted removes the user’s activities and habit facts, and nobody else’s', async () => {
    const { h, deliver, at } = setup();
    await h.knowHabit(ALICE);
    await h.knowHabit(BOB, '00000000-0000-4000-8000-0000000000b2');
    await h.record(alice);
    await h.record(principal(BOB), TODAY, '00000000-0000-4000-8000-0000000000b2');

    await deliver(
      createEvent('UserDeleted', { ...at('2026-11-20T09:00:00Z'), payload: { userId: ALICE } }),
    );
    expect([...h.uow.store.activities.values()].map((a) => a.userId)).toEqual([BOB]);
    expect([...h.uow.store.habits.values()].map((x) => x.ownerUserId)).toEqual([BOB]);
  });
});
