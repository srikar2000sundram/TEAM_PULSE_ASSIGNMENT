import { describe, expect, it } from 'vitest';
import { unwrap, type Result } from '@teampulse/kernel';
import {
  ALICE,
  BOB,
  CHALLENGE,
  FRIDAY_NINE_BERLIN,
  HABIT,
  OTHER_HABIT,
  START,
  buildHarness,
  principal,
  uuid,
} from '../support/harness.js';

const errorOf = (result: Result<unknown>) => (result.ok ? undefined : result.error);
const milestone = { kind: 'milestone', milestoneKind: 'streak', threshold: 7 } as const;

describe('NotifyUser', () => {
  it('creates an unread notification', async () => {
    const h = buildHarness();
    expect(
      unwrap(
        await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(1) }),
      ),
    ).toEqual({ created: true });
    const { items, unreadCount } = await h.list(ALICE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'milestone', isRead: false });
    expect(unreadCount).toBe(1);
  });

  it('is idempotent: the same event notifies the same person once', async () => {
    const h = buildHarness();
    const input = { userId: ALICE, content: milestone, sourceId: uuid(1) };
    await h.app.notifyUser.execute(input);
    expect(unwrap(await h.app.notifyUser.execute(input))).toEqual({ created: false });
    expect((await h.list(ALICE)).items).toHaveLength(1);
  });

  it('a different event, or a different person, is a separate notification', async () => {
    const h = buildHarness();
    await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(1) });
    await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(2) });
    await h.app.notifyUser.execute({ userId: BOB, content: milestone, sourceId: uuid(1) });
    expect((await h.list(ALICE)).items).toHaveLength(2);
    expect((await h.list(BOB)).items).toHaveLength(1);
  });

  it('respects a switched-off category, but only that category', async () => {
    const h = buildHarness();
    unwrap(
      await h.app.updatePreferences.execute({
        actor: principal(ALICE),
        changes: { milestones: false },
      }),
    );

    expect(
      unwrap(
        await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(1) }),
      ),
    ).toEqual({ created: false });
    expect(
      unwrap(
        await h.app.notifyUser.execute({
          userId: ALICE,
          content: { kind: 'badge', badgeKind: 'streak' },
          sourceId: uuid(2),
        }),
      ),
    ).toEqual({ created: true });
  });
});

describe('preferences', () => {
  it('start with everything on', async () => {
    const h = buildHarness();
    expect(unwrap(await h.app.getPreferences.execute({ actor: principal(ALICE) }))).toEqual({
      milestones: true,
      badges: true,
      challenges: true,
      reminders: true,
    });
  });

  it('change only what is given, and are remembered per person', async () => {
    const h = buildHarness();
    const updated = unwrap(
      await h.app.updatePreferences.execute({
        actor: principal(ALICE),
        changes: { reminders: false },
      }),
    );
    expect(updated).toMatchObject({ reminders: false, milestones: true });
    expect(unwrap(await h.app.getPreferences.execute({ actor: principal(ALICE) }))).toMatchObject({
      reminders: false,
    });
    expect(unwrap(await h.app.getPreferences.execute({ actor: principal(BOB) }))).toMatchObject({
      reminders: true,
    });

    const again = unwrap(
      await h.app.updatePreferences.execute({
        actor: principal(ALICE),
        changes: { badges: false },
      }),
    );
    expect(again).toMatchObject({ reminders: false, badges: false });
  });
});

describe('listing and reading', () => {
  async function seed() {
    const h = buildHarness();
    for (let i = 1; i <= 5; i += 1) {
      await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(i) });
      h.clock.advanceMs(1000);
    }
    await h.app.notifyUser.execute({ userId: BOB, content: milestone, sourceId: uuid(1) });
    return h;
  }

  it('lists only the caller’s own, newest first', async () => {
    const h = await seed();
    const { items } = await h.list(ALICE);
    expect(items).toHaveLength(5);
    expect(items.every((n) => n.userId === ALICE)).toBe(true);
    expect(items[0]!.createdAt.getTime()).toBeGreaterThan(items[4]!.createdAt.getTime());
  });

  it('marks as read, which lowers the unread count and filters the unread list', async () => {
    const h = await seed();
    const [first] = (await h.list(ALICE)).items;
    const read = unwrap(
      await h.app.markNotificationRead.execute({
        actor: principal(ALICE),
        notificationId: first!.id,
      }),
    );
    expect(read.isRead).toBe(true);

    const unread = await h.list(ALICE, { unreadOnly: true });
    expect(unread.items).toHaveLength(4);
    expect(unread.unreadCount).toBe(4);
  });

  it('reading twice keeps the first read time', async () => {
    const h = await seed();
    const [first] = (await h.list(ALICE)).items;
    const a = unwrap(
      await h.app.markNotificationRead.execute({
        actor: principal(ALICE),
        notificationId: first!.id,
      }),
    );
    h.clock.advanceMs(60_000);
    const b = unwrap(
      await h.app.markNotificationRead.execute({
        actor: principal(ALICE),
        notificationId: first!.id,
      }),
    );
    expect(b.readAt).toEqual(a.readAt);
  });

  it('someone else’s notification looks exactly like a missing one, and stays unread', async () => {
    const h = await seed();
    const [bobs] = (await h.list(BOB)).items;
    const theirs = await h.app.markNotificationRead.execute({
      actor: principal(ALICE),
      notificationId: bobs!.id,
    });
    const missing = await h.app.markNotificationRead.execute({
      actor: principal(ALICE),
      notificationId: uuid(0x999),
    });
    expect(errorOf(theirs)).toEqual(errorOf(missing));
    expect(errorOf(theirs)).toMatchObject({ kind: 'not_found', code: 'notification.not_found' });
    expect((await h.list(BOB)).unreadCount).toBe(1);
  });

  it('pages without skipping or repeating, and reports the total unread count on every page', async () => {
    const h = await seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await h.app.listNotifications.execute({
          actor: principal(ALICE),
          unreadOnly: false,
          limit: 2,
          cursor,
        }),
      );
      expect(page.unreadCount).toBe(5);
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed cursor', async () => {
    const h = buildHarness();
    const result = await h.app.listNotifications.execute({
      actor: principal(ALICE),
      unreadOnly: false,
      limit: 10,
      cursor: 'junk',
    });
    expect(errorOf(result)).toMatchObject({ kind: 'validation', code: 'cursor.invalid' });
  });
});

describe('challenge participation', () => {
  it('ChallengeCompleted notifies everyone who joined, once, and nobody else', async () => {
    const h = buildHarness();
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: ALICE });
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: ALICE }); // joined event redelivered
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: BOB });
    await h.app.recordParticipant.execute({ challengeId: uuid(0xc9), userId: uuid(0xd1) });

    const event = { challengeId: CHALLENGE, sourceId: uuid(77) };
    expect(unwrap(await h.app.notifyChallengeCompleted.execute(event))).toEqual({ notified: 2 });
    expect(unwrap(await h.app.notifyChallengeCompleted.execute(event))).toEqual({ notified: 0 });
    expect((await h.list(uuid(0xd1))).items).toHaveLength(0);
    expect((await h.list(ALICE)).items[0]).toMatchObject({ kind: 'challenge_completed' });
  });

  it('skips people who switched challenge notifications off', async () => {
    const h = buildHarness();
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: ALICE });
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: BOB });
    await h.app.updatePreferences.execute({
      actor: principal(BOB),
      changes: { challenges: false },
    });
    expect(
      unwrap(
        await h.app.notifyChallengeCompleted.execute({
          challengeId: CHALLENGE,
          sourceId: uuid(77),
        }),
      ),
    ).toEqual({ notified: 1 });
  });

  it('a challenge nobody joined notifies nobody', async () => {
    const h = buildHarness();
    expect(
      unwrap(
        await h.app.notifyChallengeCompleted.execute({
          challengeId: CHALLENGE,
          sourceId: uuid(77),
        }),
      ),
    ).toEqual({ notified: 0 });
  });
});

describe('reminders', () => {
  it('sends a reminder when it is due, and only once for the day', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE); // Fridays 09:00 Berlin = 08:00 UTC; START is exactly that
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 1 });
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    h.clock.advanceMs(5 * 60_000); // a later tick, still inside the window
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    expect((await h.list(ALICE)).items).toHaveLength(1);
    expect((await h.list(ALICE)).items[0]).toMatchObject({ kind: 'reminder' });
  });

  it('sends nothing before the time, after the window, or on another day', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE);
    h.clock.set('2026-11-20T07:59:00Z');
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    h.clock.set('2026-11-20T08:20:00Z');
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    h.clock.set('2026-11-21T08:00:00Z'); // Saturday
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
  });

  it('sends again the next time the schedule matches (next Friday)', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE);
    await h.app.sendDueReminders.execute();
    h.clock.set('2026-11-27T08:00:00Z');
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 1 });
    expect((await h.list(ALICE)).items).toHaveLength(2);
  });

  it('covers several people and habits in different time zones at one tick', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE, HABIT, FRIDAY_NINE_BERLIN);
    await h.scheduleReminder(BOB, OTHER_HABIT, {
      daysOfWeek: ['fri'],
      remindAt: '17:00',
      timeZone: 'Asia/Tokyo',
    });
    await h.scheduleReminder(uuid(0xd1), uuid(0x53), {
      daysOfWeek: ['fri'],
      remindAt: '12:00',
      timeZone: 'Asia/Tokyo',
    });
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 2 });
  });

  it('claims the occurrence but sends nothing when the person switched reminders off', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE);
    await h.app.updatePreferences.execute({
      actor: principal(ALICE),
      changes: { reminders: false },
    });
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    // Turning it back on within the window does not make a late reminder appear.
    await h.app.updatePreferences.execute({
      actor: principal(ALICE),
      changes: { reminders: true },
    });
    expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    expect((await h.list(ALICE)).items).toHaveLength(0);
  });

  it('forgets old occurrences', async () => {
    const h = buildHarness();
    await h.scheduleReminder(ALICE);
    await h.app.sendDueReminders.execute();
    expect(unwrap(await h.app.purgeReminderOccurrences.execute())).toEqual({ removed: 0 });
    h.clock.set('2026-12-10T08:00:00Z'); // more than 14 days later
    expect(unwrap(await h.app.purgeReminderOccurrences.execute())).toEqual({ removed: 1 });
  });

  describe('following the habit', () => {
    it('stops after the habit is archived, and an archive is permanent', async () => {
      const h = buildHarness();
      await h.scheduleReminder(ALICE);
      await h.app.applyHabitArchived.execute({
        habitId: HABIT,
        ownerUserId: ALICE,
        occurredAt: new Date('2026-11-10T08:00:00Z'),
      });
      // A late "created" event cannot revive it.
      await h.scheduleReminder(ALICE, HABIT, FRIDAY_NINE_BERLIN, '2026-11-05T08:00:00Z');
      expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    });

    it('clearing the reminder in an update stops it', async () => {
      const h = buildHarness();
      await h.scheduleReminder(ALICE);
      await h.app.applyHabitReminder.execute({
        habitId: HABIT,
        ownerUserId: ALICE,
        reminder: undefined,
        occurredAt: new Date('2026-11-10T08:00:00Z'),
      });
      expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    });

    it('the newest schedule wins, whatever the arrival order', async () => {
      const h = buildHarness();
      const later = { ...FRIDAY_NINE_BERLIN, remindAt: '09:30' };
      await h.scheduleReminder(ALICE, HABIT, later, '2026-11-10T08:00:00Z');
      await h.scheduleReminder(ALICE, HABIT, FRIDAY_NINE_BERLIN, '2026-11-05T08:00:00Z'); // older, arrives late
      expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 }); // 09:00 is no longer the time
      h.clock.set('2026-11-20T08:30:00Z');
      expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 1 });
    });

    it('handles an archive that arrives before the creation', async () => {
      const h = buildHarness();
      await h.app.applyHabitArchived.execute({
        habitId: HABIT,
        ownerUserId: ALICE,
        occurredAt: new Date('2026-11-10T08:00:00Z'),
      });
      await h.scheduleReminder(ALICE, HABIT, FRIDAY_NINE_BERLIN, '2026-11-01T08:00:00Z');
      expect(unwrap(await h.app.sendDueReminders.execute())).toEqual({ sent: 0 });
    });
  });
});

describe('erasure', () => {
  it('UserDeleted removes everything held about the person and nothing about others', async () => {
    const h = buildHarness();
    await h.app.notifyUser.execute({ userId: ALICE, content: milestone, sourceId: uuid(1) });
    await h.app.notifyUser.execute({ userId: BOB, content: milestone, sourceId: uuid(1) });
    await h.app.updatePreferences.execute({ actor: principal(ALICE), changes: { badges: false } });
    await h.scheduleReminder(ALICE);
    await h.app.recordParticipant.execute({ challengeId: CHALLENGE, userId: ALICE });

    unwrap(await h.app.eraseUserNotifications.execute({ userId: ALICE }));
    expect((await h.list(ALICE)).items).toHaveLength(0);
    expect(h.uow.store.preferences.has(ALICE)).toBe(false);
    expect(h.uow.store.reminders.size).toBe(0);
    expect(h.uow.store.participants.size).toBe(0);
    expect((await h.list(BOB)).items).toHaveLength(1);
    expect(START).toBeDefined();
  });

  it('is idempotent', async () => {
    const h = buildHarness();
    unwrap(await h.app.eraseUserNotifications.execute({ userId: ALICE }));
    unwrap(await h.app.eraseUserNotifications.execute({ userId: ALICE }));
  });
});
