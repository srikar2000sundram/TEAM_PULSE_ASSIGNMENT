import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { EventConsumer, type Message, type MessageSource } from '@teampulse/inbox';
import { createLogger } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import { buildHabitEventHandlers } from '../../src/adapters/events/handlers.js';
import { ALICE, BOB, DATA, PLATFORM, buildHarness, principal } from '../support/harness.js';

/** The Habit Service reacting to Identity events, through the real consumer and handlers. */
function setup() {
  const h = buildHarness();
  const queue: Message[] = [];
  const removed: string[] = [];
  const source: MessageSource = {
    receive: (max) => Promise.resolve(queue.splice(0, max)),
    remove: (message) => {
      removed.push(message.id);
      return Promise.resolve();
    },
  };
  const consumer = new EventConsumer({
    source,
    handlers: buildHabitEventHandlers(h.app),
    logger: createLogger({
      service: 'habit-consumer-test',
      level: 'silent',
      write: () => undefined,
    }),
    waitSeconds: 0,
  });
  let counter = 0;
  const deliver = async (event: TeamPulseEvent, wrapInEventBridge = false) => {
    counter += 1;
    queue.push({
      id: `m${counter}`,
      body: JSON.stringify(
        wrapInEventBridge ? { 'detail-type': event.eventType, detail: event } : event,
      ),
    });
    return consumer.runOnce();
  };
  const eventId = () =>
    `00000000-0000-4000-8000-${(0xe000 + ++counter).toString(16).padStart(12, '0')}`;
  const base = () => ({
    eventId: eventId(),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: eventId(),
  });
  return { h, deliver, removed, base };
}

const alice = principal(ALICE, { teams: [PLATFORM, DATA] });

describe('Habit Service event handlers', () => {
  it('UserDeleted erases the user’s habits, and a redelivery changes nothing more', async () => {
    const { h, deliver, base } = setup();
    await h.createHabit(alice);
    const bobs = await h.createHabit(principal(BOB));

    const event = createEvent('UserDeleted', { ...base(), payload: { userId: ALICE } });
    expect(await deliver(event)).toMatchObject({ handled: 1 });
    expect([...h.uow.store.habits.keys()]).toEqual([bobs.id]);

    // At-least-once delivery: the same event again is harmless.
    expect(await deliver(event, true)).toMatchObject({ handled: 1 });
    expect([...h.uow.store.habits.keys()]).toEqual([bobs.id]);
  });

  it('TeamMembershipChanged "removed" withdraws that person’s habits from the team', async () => {
    const { h, deliver, base } = setup();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const other = await h.createHabit(alice, { visibility: 'team', teamId: DATA });

    await deliver(
      createEvent('TeamMembershipChanged', {
        ...base(),
        payload: { userId: ALICE, teamId: PLATFORM, change: 'removed' },
      }),
    );
    expect(h.uow.store.habits.get(shared.id)?.visibility).toBe('private');
    expect(h.uow.store.habits.get(other.id)?.teamId).toBe(DATA);
  });

  it('TeamMembershipChanged "added" changes nothing and is still acknowledged', async () => {
    const { h, deliver, removed, base } = setup();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const result = await deliver(
      createEvent('TeamMembershipChanged', {
        ...base(),
        payload: { userId: ALICE, teamId: PLATFORM, change: 'added' },
      }),
    );
    expect(result).toMatchObject({ handled: 1 });
    expect(removed).toHaveLength(1);
    expect(h.uow.store.habits.get(shared.id)?.visibility).toBe('team');
  });

  it('acknowledges and ignores events this service does not care about', async () => {
    const { deliver, base } = setup();
    const result = await deliver(
      createEvent('UserRegistered', { ...base(), payload: { userId: ALICE, role: 'employee' } }),
    );
    expect(result).toMatchObject({ handled: 0, ignored: 1 });
  });
});
