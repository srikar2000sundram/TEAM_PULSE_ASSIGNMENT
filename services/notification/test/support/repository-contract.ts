import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationPreferences } from '@teampulse/contracts';
import type { NotificationListQuery, UnitOfWork } from '../../src/application/ports.js';
import { Notification, type NotificationContent } from '../../src/domain/notification.js';
import { ALICE, BOB, CHALLENGE, FRIDAY_NINE_BERLIN, HABIT, OTHER_HABIT, uuid } from './harness.js';

export interface RepositoryFixture {
  readonly uow: UnitOfWork;
  /** Empties everything so each test starts clean. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const T0 = new Date('2026-11-20T08:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
let counter = 0;
const nextId = () => uuid(0x1000 + ++counter);

function make(
  overrides: {
    userId?: string;
    content?: NotificationContent;
    sourceId?: string;
    createdAt?: Date;
  } = {},
): Notification {
  return Notification.create({
    id: nextId(),
    userId: overrides.userId ?? ALICE,
    content: overrides.content ?? { kind: 'reminder' },
    sourceId: overrides.sourceId ?? nextId(),
    now: overrides.createdAt ?? T0,
  });
}

const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  milestones: true,
  badges: true,
  challenges: true,
  reminders: true,
  ...over,
});

/**
 * One behavioural suite, run against every implementation (in-memory fake, PostgreSQL through
 * PGlite, PostgreSQL through the real driver). If a fake and the real database ever disagree, a
 * test here fails, so unit tests built on the fake can be trusted.
 */
export function repositoryContract(name: string, create: () => Promise<RepositoryFixture>): void {
  describe(`notification repository contract: ${name}`, () => {
    let fixture: RepositoryFixture;
    const ready = create().then((f) => (fixture = f));
    beforeEach(async () => {
      await ready;
      await fixture.reset();
    });
    afterAll(async () => {
      await ready;
      await fixture.close();
    });

    const insert = (...n: Notification[]) =>
      fixture.uow.run((tx) => tx.notifications.insertMany(n));
    const list = (query: Partial<NotificationListQuery> = {}) =>
      fixture.uow.run((tx) =>
        tx.notifications.list({ userId: ALICE, unreadOnly: false, limit: 50, ...query }),
      );

    describe('notifications', () => {
      it('round-trips every kind with its numbers', async () => {
        const contents: NotificationContent[] = [
          { kind: 'milestone', milestoneKind: 'streak', threshold: 30 },
          { kind: 'milestone', milestoneKind: 'total', threshold: 100 },
          { kind: 'badge', badgeKind: 'milestone' },
          { kind: 'challenge_completed' },
          { kind: 'reminder' },
        ];
        for (const content of contents) await insert(make({ content }));
        const loaded = (await list()).map((n) => n.content);
        expect(loaded).toHaveLength(5);
        for (const content of contents) expect(loaded).toContainEqual(content);
      });

      it('stores the times and starts unread', async () => {
        const n = make({ createdAt: at(5) });
        await insert(n);
        const [loaded] = await list();
        expect(loaded).toMatchObject({
          id: n.id,
          userId: ALICE,
          sourceId: n.sourceId,
          readAt: null,
        });
        expect(loaded?.createdAt).toEqual(at(5));
      });

      it('stores one notification per person and source, and reports how many were new', async () => {
        const source = nextId();
        expect(await insert(make({ sourceId: source }))).toBe(1);
        expect(await insert(make({ sourceId: source }))).toBe(0);
        expect(await insert(make({ sourceId: source, userId: BOB }))).toBe(1); // another person: fine
        expect(await insert(make({ sourceId: nextId() }), make({ sourceId: source }))).toBe(1);
        expect(await list()).toHaveLength(2);
      });

      it('lists only the user’s own, newest first, and can limit to unread', async () => {
        const old = make({ createdAt: at(0) });
        const recent = make({ createdAt: at(10) });
        await insert(old, recent, make({ userId: BOB, createdAt: at(5) }));
        expect((await list()).map((n) => n.id)).toEqual([recent.id, old.id]);

        await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, recent.id, at(20)));
        expect((await list({ unreadOnly: true })).map((n) => n.id)).toEqual([old.id]);
      });

      it('counts unread per user', async () => {
        const a = make();
        await insert(a, make(), make({ userId: BOB }));
        await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, a.id, at(1)));
        expect(await fixture.uow.run((tx) => tx.notifications.unreadCount(ALICE))).toBe(1);
        expect(await fixture.uow.run((tx) => tx.notifications.unreadCount(BOB))).toBe(1);
      });

      it('marks as read once, keeping the first time', async () => {
        const n = make();
        await insert(n);
        const first = await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, n.id, at(10)));
        const again = await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, n.id, at(99)));
        expect(first?.readAt).toEqual(at(10));
        expect(again?.readAt).toEqual(at(10));
      });

      it('cannot mark someone else’s notification, or a missing one', async () => {
        const bobs = make({ userId: BOB });
        await insert(bobs);
        expect(
          await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, bobs.id, at(1))),
        ).toBeNull();
        expect(
          await fixture.uow.run((tx) => tx.notifications.markRead(ALICE, uuid(0x999), at(1))),
        ).toBeNull();
        expect(await fixture.uow.run((tx) => tx.notifications.unreadCount(BOB))).toBe(1);
      });

      it('keyset pagination visits every row once, including rows with equal timestamps', async () => {
        const all: string[] = [];
        for (let i = 0; i < 7; i += 1) {
          const n = make({ createdAt: at(Math.floor(i / 2)) });
          all.push(n.id);
          await insert(n);
        }
        const seen: string[] = [];
        let after: { createdAt: Date; id: string } | undefined;
        for (let page = 0; page < 10; page += 1) {
          const rows = await list({ limit: 3, ...(after ? { after } : {}) });
          if (rows.length === 0) break;
          seen.push(...rows.map((r) => r.id));
          const last = rows.at(-1)!;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen)).toEqual(new Set(all));
      });

      it('erases one user’s notifications only', async () => {
        await insert(make(), make(), make({ userId: BOB }));
        expect(await fixture.uow.run((tx) => tx.notifications.deleteAllForUser(ALICE))).toBe(2);
        expect(await list({ userId: BOB })).toHaveLength(1);
      });
    });

    describe('preferences', () => {
      it('finds nothing for a person who never saved any', async () => {
        expect(await fixture.uow.run((tx) => tx.preferences.find(ALICE))).toBeNull();
      });

      it('saves, overwrites and reads back', async () => {
        await fixture.uow.run((tx) => tx.preferences.save(ALICE, prefs({ badges: false }), at(0)));
        await fixture.uow.run((tx) =>
          tx.preferences.save(ALICE, prefs({ reminders: false }), at(1)),
        );
        expect(await fixture.uow.run((tx) => tx.preferences.find(ALICE))).toEqual(
          prefs({ reminders: false }),
        );
      });

      it('finds many at once, leaving out people without preferences', async () => {
        await fixture.uow.run((tx) => tx.preferences.save(ALICE, prefs({ badges: false }), at(0)));
        const found = await fixture.uow.run((tx) => tx.preferences.findMany([ALICE, BOB]));
        expect([...found.keys()]).toEqual([ALICE]);
        expect(await fixture.uow.run((tx) => tx.preferences.findMany([]))).toEqual(new Map());
      });

      it('erases one person’s preferences', async () => {
        await fixture.uow.run((tx) => tx.preferences.save(ALICE, prefs(), at(0)));
        expect(await fixture.uow.run((tx) => tx.preferences.deleteForUser(ALICE))).toBe(1);
        expect(await fixture.uow.run((tx) => tx.preferences.deleteForUser(ALICE))).toBe(0);
      });
    });

    describe('reminders', () => {
      const snapshot = (
        habitId: string,
        schedule: typeof FRIDAY_NINE_BERLIN | null,
        when: Date,
        user = ALICE,
      ) =>
        fixture.uow.run((tx) =>
          tx.reminders.applySnapshot({ habitId, userId: user, schedule, at: when }),
        );
      const archive = (habitId: string, when: Date) =>
        fixture.uow.run((tx) => tx.reminders.applyArchived({ habitId, userId: ALICE, at: when }));
      const active = () => fixture.uow.run((tx) => tx.reminders.listActive());

      it('stores a schedule and lists it as active', async () => {
        await snapshot(
          HABIT,
          { daysOfWeek: ['mon', 'fri'], remindAt: '07:30', timeZone: 'Europe/Berlin' },
          at(0),
        );
        expect(await active()).toEqual([
          {
            habitId: HABIT,
            userId: ALICE,
            schedule: { daysOfWeek: ['mon', 'fri'], remindAt: '07:30', timeZone: 'Europe/Berlin' },
          },
        ]);
      });

      it('a snapshot without a schedule means no reminder', async () => {
        await snapshot(HABIT, null, at(0));
        expect(await active()).toEqual([]);
      });

      it('is idempotent', async () => {
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        expect(await active()).toHaveLength(1);
      });

      it('the newest event decides, including clearing, whatever the arrival order', async () => {
        const later = { ...FRIDAY_NINE_BERLIN, remindAt: '10:00' };
        await snapshot(HABIT, later, at(20));
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(10)); // older, arrives late
        expect((await active())[0]?.schedule.remindAt).toBe('10:00');

        await snapshot(HABIT, null, at(30)); // newest: reminder removed
        expect(await active()).toEqual([]);
        await snapshot(HABIT, later, at(25)); // older again: must not bring it back
        expect(await active()).toEqual([]);
      });

      it('archiving is permanent', async () => {
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        await archive(HABIT, at(10));
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(20));
        expect(await active()).toEqual([]);
      });

      it('an archive that arrives first leaves a placeholder that stays archived', async () => {
        await archive(HABIT, at(10));
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        expect(await active()).toEqual([]);
      });

      it('lists reminders of several habits', async () => {
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        await snapshot(OTHER_HABIT, FRIDAY_NINE_BERLIN, at(0), BOB);
        expect((await active()).map((r) => r.habitId).sort()).toEqual([HABIT, OTHER_HABIT].sort());
      });

      it('claims each habit and day once', async () => {
        const claim = (habit: string, date: string) =>
          fixture.uow.run((tx) => tx.reminders.claimOccurrence(habit, date, at(0)));
        expect(await claim(HABIT, '2026-11-20')).toBe(true);
        expect(await claim(HABIT, '2026-11-20')).toBe(false);
        expect(await claim(HABIT, '2026-11-27')).toBe(true);
        expect(await claim(OTHER_HABIT, '2026-11-20')).toBe(true);
      });

      it('purges only old occurrences', async () => {
        await fixture.uow.run((tx) => tx.reminders.claimOccurrence(HABIT, '2026-11-01', at(0)));
        await fixture.uow.run((tx) =>
          tx.reminders.claimOccurrence(HABIT, '2026-11-20', at(100_000)),
        );
        expect(await fixture.uow.run((tx) => tx.reminders.purgeOccurrences(at(50_000)))).toBe(1);
        // The recent one is still claimed; the old one can be claimed again.
        expect(
          await fixture.uow.run((tx) => tx.reminders.claimOccurrence(HABIT, '2026-11-20', at(0))),
        ).toBe(false);
        expect(
          await fixture.uow.run((tx) => tx.reminders.claimOccurrence(HABIT, '2026-11-01', at(0))),
        ).toBe(true);
      });

      it('erases one person’s reminders', async () => {
        await snapshot(HABIT, FRIDAY_NINE_BERLIN, at(0));
        await snapshot(OTHER_HABIT, FRIDAY_NINE_BERLIN, at(0), BOB);
        expect(await fixture.uow.run((tx) => tx.reminders.deleteAllForUser(ALICE))).toBe(1);
        expect((await active()).map((r) => r.userId)).toEqual([BOB]);
      });
    });

    describe('participants', () => {
      it('records who joined, once, and lists them', async () => {
        await fixture.uow.run((tx) => tx.participants.add(CHALLENGE, ALICE));
        await fixture.uow.run((tx) => tx.participants.add(CHALLENGE, ALICE));
        await fixture.uow.run((tx) => tx.participants.add(CHALLENGE, BOB));
        await fixture.uow.run((tx) => tx.participants.add(uuid(0xc9), BOB));
        expect(await fixture.uow.run((tx) => tx.participants.usersOf(CHALLENGE))).toEqual(
          [ALICE, BOB].sort(),
        );
        expect(await fixture.uow.run((tx) => tx.participants.usersOf(uuid(0xc8)))).toEqual([]);
      });

      it('erases one person from every challenge', async () => {
        await fixture.uow.run((tx) => tx.participants.add(CHALLENGE, ALICE));
        await fixture.uow.run((tx) => tx.participants.add(uuid(0xc9), ALICE));
        await fixture.uow.run((tx) => tx.participants.add(CHALLENGE, BOB));
        expect(await fixture.uow.run((tx) => tx.participants.deleteAllForUser(ALICE))).toBe(2);
        expect(await fixture.uow.run((tx) => tx.participants.usersOf(CHALLENGE))).toEqual([BOB]);
      });
    });

    describe('transactions', () => {
      it('commits everything the work wrote', async () => {
        await fixture.uow.run(async (tx) => {
          await tx.notifications.insertMany([make()]);
          await tx.preferences.save(ALICE, prefs(), at(0));
        });
        expect(await list()).toHaveLength(1);
        expect(await fixture.uow.run((tx) => tx.preferences.find(ALICE))).not.toBeNull();
      });

      it('rolls everything back when the work throws', async () => {
        await expect(
          fixture.uow.run(async (tx) => {
            await tx.notifications.insertMany([make()]);
            await tx.reminders.claimOccurrence(HABIT, '2026-11-20', at(0));
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        expect(await list()).toHaveLength(0);
        // The claim was rolled back too, so the day can still be claimed.
        expect(
          await fixture.uow.run((tx) => tx.reminders.claimOccurrence(HABIT, '2026-11-20', at(0))),
        ).toBe(true);
      });
    });
  });
}
