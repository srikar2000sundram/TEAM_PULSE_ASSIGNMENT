import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { EventConsumer, type Message, type MessageSource } from '@teampulse/inbox';
import { createLogger } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import { buildNotificationEventHandlers } from '../../src/adapters/events/handlers.js';
import {
  ALICE,
  BOB,
  CHALLENGE,
  FRIDAY_NINE_BERLIN,
  HABIT,
  buildHarness,
} from '../support/harness.js';

/** The Notification Service reacting to other services' events, through the real consumer. */
function setup() {
  const h = buildHarness();
  const queue: Message[] = [];
  const source: MessageSource = {
    receive: (max) => Promise.resolve(queue.splice(0, max)),
    remove: () => Promise.resolve(),
  };
  const consumer = new EventConsumer({
    source,
    handlers: buildNotificationEventHandlers(h.app),
    logger: createLogger({ service: 'n-consumer-test', level: 'silent', write: () => undefined }),
    waitSeconds: 0,
  });
  let counter = 0;
  const next = () =>
    `00000000-0000-4000-8000-${(0xe000 + ++counter).toString(16).padStart(12, '0')}`;
  const deliver = (event: TeamPulseEvent) => {
    queue.push({ id: next(), body: JSON.stringify(event) });
    return consumer.runOnce();
  };
  const base = (iso = '2026-11-01T08:00:00Z') => ({
    eventId: next(),
    occurredAt: new Date(iso),
    correlationId: next(),
  });
  return { h, deliver, base };
}

const reminder = { ...FRIDAY_NINE_BERLIN, daysOfWeek: [...FRIDAY_NINE_BERLIN.daysOfWeek] };

describe('turning events into notifications', () => {
  it('MilestoneReached notifies the person, once even if delivered twice', async () => {
    const { h, deliver, base } = setup();
    const event = createEvent('MilestoneReached', {
      ...base(),
      payload: { userId: ALICE, kind: 'streak', threshold: 30, habitId: HABIT },
    });
    expect(await deliver(event)).toMatchObject({ handled: 1 });
    await deliver(event);

    const { items } = await h.list(ALICE);
    expect(items).toHaveLength(1);
    expect(items[0]?.content).toEqual({
      kind: 'milestone',
      milestoneKind: 'streak',
      threshold: 30,
    });
  });

  it('BadgeAwarded notifies the person', async () => {
    const { h, deliver, base } = setup();
    await deliver(
      createEvent('BadgeAwarded', {
        ...base(),
        payload: {
          userId: ALICE,
          challengeId: CHALLENGE,
          badgeRuleId: '00000000-0000-4000-8000-0000000000b9',
          kind: 'total',
          awardedOn: '2026-11-20',
        },
      }),
    );
    expect((await h.list(ALICE)).items[0]?.content).toEqual({ kind: 'badge', badgeKind: 'total' });
  });

  it('ChallengeJoined then ChallengeCompleted notifies the participants', async () => {
    const { h, deliver, base } = setup();
    for (const userId of [ALICE, BOB]) {
      await deliver(
        createEvent('ChallengeJoined', {
          ...base(),
          payload: {
            challengeId: CHALLENGE,
            userId,
            teamId: '00000000-0000-4000-8000-000000000071',
          },
        }),
      );
    }
    await deliver(
      createEvent('ChallengeCompleted', {
        ...base(),
        payload: { challengeId: CHALLENGE, completedOn: '2026-11-20' },
      }),
    );
    expect((await h.list(ALICE)).items).toHaveLength(1);
    expect((await h.list(BOB)).items).toHaveLength(1);
  });

  it('acknowledges and ignores events this service does not care about', async () => {
    const { deliver, base } = setup();
    const result = await deliver(
      createEvent('UserRegistered', { ...base(), payload: { userId: ALICE, role: 'employee' } }),
    );
    expect(result).toMatchObject({ handled: 0, ignored: 1 });
  });
});

describe('learning reminder schedules from habit events', () => {
  const habitEvent = (
    type: 'HabitCreated' | 'HabitUpdated',
    iso: string,
    withReminder: boolean,
    base: ReturnType<ReturnType<typeof setup>['base']>,
  ) =>
    createEvent(type, {
      ...base,
      occurredAt: new Date(iso),
      payload: {
        habitId: HABIT,
        ownerUserId: ALICE,
        visibility: 'private',
        activityType: 'walking',
        ...(withReminder ? { reminder } : {}),
      },
    });

  it('HabitCreated with a reminder makes it due at the right time', async () => {
    const { h, deliver, base } = setup();
    await deliver(habitEvent('HabitCreated', '2026-11-01T08:00:00Z', true, base()));
    expect(h.uow.store.reminders.get(HABIT)?.schedule).toMatchObject({
      remindAt: '09:00',
      timeZone: 'Europe/Berlin',
    });
    const sent = await h.app.sendDueReminders.execute();
    expect(sent.ok && sent.value.sent).toBe(1);
  });

  it('HabitUpdated without a reminder clears it, and a late older update does not bring it back', async () => {
    const { h, deliver, base } = setup();
    await deliver(habitEvent('HabitCreated', '2026-11-01T08:00:00Z', true, base()));
    await deliver(habitEvent('HabitUpdated', '2026-11-10T08:00:00Z', false, base()));
    await deliver(habitEvent('HabitUpdated', '2026-11-05T08:00:00Z', true, base())); // older, arrives late
    expect(h.uow.store.reminders.get(HABIT)?.schedule).toBeNull();
  });

  it('HabitArchived stops the reminder for good', async () => {
    const { h, deliver, base } = setup();
    await deliver(habitEvent('HabitCreated', '2026-11-01T08:00:00Z', true, base()));
    await deliver(
      createEvent('HabitArchived', {
        ...base('2026-11-12T08:00:00Z'),
        payload: { habitId: HABIT, ownerUserId: ALICE },
      }),
    );
    await deliver(habitEvent('HabitUpdated', '2026-11-11T08:00:00Z', true, base()));
    expect(h.uow.store.reminders.get(HABIT)?.archived).toBe(true);
    const sent = await h.app.sendDueReminders.execute();
    expect(sent.ok && sent.value.sent).toBe(0);
  });
});

describe('erasure', () => {
  it('UserDeleted removes the person’s data', async () => {
    const { h, deliver, base } = setup();
    await deliver(
      createEvent('MilestoneReached', {
        ...base(),
        payload: { userId: ALICE, kind: 'streak', threshold: 7 },
      }),
    );
    await deliver(createEvent('UserDeleted', { ...base(), payload: { userId: ALICE } }));
    expect((await h.list(ALICE)).items).toHaveLength(0);
  });
});
