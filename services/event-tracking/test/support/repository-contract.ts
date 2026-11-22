import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent } from '@teampulse/contracts';
import type { ActivityListQuery, UnitOfWork } from '../../src/application/ports.js';
import { Activity } from '../../src/domain/activity.js';
import { ALICE, BOB, DATA, HABIT, OTHER_HABIT, PLATFORM, uuid } from './harness.js';

export interface RepositoryFixture {
  readonly uow: UnitOfWork;
  /** Events written to the outbox so far. */
  readOutbox(): Promise<unknown[]>;
  /** Empties everything so each test starts clean. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const T0 = new Date('2026-11-20T08:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
let counter = 0;
const nextId = () => uuid(0x1000 + ++counter);

function makeActivity(
  overrides: {
    userId?: string;
    habitId?: string;
    date?: string;
    teamIds?: string[];
    createdAt?: Date;
    type?: 'walking' | 'yoga';
  } = {},
): Activity {
  return Activity.record({
    id: nextId(),
    userId: overrides.userId ?? ALICE,
    habitId: overrides.habitId ?? HABIT,
    activityType: overrides.type ?? 'walking',
    activityDate: overrides.date ?? '2026-11-20',
    teamIds: overrides.teamIds ?? [],
    now: overrides.createdAt ?? T0,
  });
}

/**
 * One behavioural suite, run against every implementation (in-memory fake, PostgreSQL through
 * PGlite, PostgreSQL through the real driver). If a fake and the real database ever disagree, a
 * test here fails, so unit tests built on the fake can be trusted.
 */
export function repositoryContract(name: string, create: () => Promise<RepositoryFixture>): void {
  describe(`event tracking repository contract: ${name}`, () => {
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

    const insert = (activity: Activity) =>
      fixture.uow.run((tx) => tx.activities.insertIfAbsent(activity));
    const list = (query: Partial<ActivityListQuery> = {}) =>
      fixture.uow.run((tx) => tx.activities.list({ userId: ALICE, limit: 50, ...query }));
    const habit = (id = HABIT) => fixture.uow.run((tx) => tx.habits.find(id));

    describe('activities', () => {
      it('round-trips every field, including the day and the team snapshot', async () => {
        const activity = makeActivity({ teamIds: [PLATFORM, DATA], type: 'yoga' });
        const result = await insert(activity);
        expect(result.created).toBe(true);

        const [loaded] = await list({});
        expect(loaded).toMatchObject({
          id: activity.id,
          userId: ALICE,
          habitId: HABIT,
          activityType: 'yoga',
          activityDate: '2026-11-20', // exactly the day, whatever the server time zone
        });
        expect([...(loaded?.teamIds ?? [])]).toEqual([PLATFORM, DATA]);
        expect(loaded?.createdAt).toEqual(T0);
      });

      it('stores an empty team snapshot', async () => {
        await insert(makeActivity({ teamIds: [] }));
        expect([...((await list({}))[0]?.teamIds ?? [])]).toEqual([]);
      });

      it('is idempotent per user, habit and day: the second insert returns the first', async () => {
        const first = makeActivity();
        const second = makeActivity({ createdAt: at(60) });
        expect((await insert(first)).created).toBe(true);

        const again = await insert(second);
        expect(again.created).toBe(false);
        expect(again.activity.id).toBe(first.id);
        expect(await list({})).toHaveLength(1);
      });

      it('allows the same day for another habit, another day, or another user', async () => {
        await insert(makeActivity());
        for (const other of [
          makeActivity({ habitId: OTHER_HABIT }),
          makeActivity({ date: '2026-11-19' }),
          makeActivity({ userId: BOB }),
        ]) {
          expect((await insert(other)).created).toBe(true);
        }
      });

      it('two simultaneous inserts of the same day create exactly one', async () => {
        const results = await Promise.all([insert(makeActivity()), insert(makeActivity())]);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(await list({})).toHaveLength(1);
      });

      it('lists only the given user’s activities, newest recorded first', async () => {
        const old = makeActivity({ date: '2026-11-18', createdAt: at(0) });
        const recent = makeActivity({ date: '2026-11-19', createdAt: at(10) });
        await insert(old);
        await insert(recent);
        await insert(makeActivity({ userId: BOB, createdAt: at(5) }));
        expect((await list({})).map((a) => a.id)).toEqual([recent.id, old.id]);
      });

      it('filters by date range (inclusive) and habit', async () => {
        const a = makeActivity({ date: '2026-11-18' });
        const b = makeActivity({ date: '2026-11-19' });
        const c = makeActivity({ date: '2026-11-20', habitId: OTHER_HABIT });
        for (const x of [a, b, c]) await insert(x);

        const ids = async (q: Partial<ActivityListQuery>) =>
          (await list(q)).map((x) => x.id).sort();
        expect(await ids({ from: '2026-11-19' })).toEqual([b.id, c.id].sort());
        expect(await ids({ to: '2026-11-19' })).toEqual([a.id, b.id].sort());
        expect(await ids({ from: '2026-11-19', to: '2026-11-19' })).toEqual([b.id]);
        expect(await ids({ habitId: OTHER_HABIT })).toEqual([c.id]);
      });

      it('keyset pagination visits every row once, including rows with equal timestamps', async () => {
        const all: string[] = [];
        for (let i = 0; i < 7; i += 1) {
          const activity = makeActivity({
            date: `2026-11-${String(10 + i).padStart(2, '0')}`,
            createdAt: at(Math.floor(i / 2)),
          });
          all.push(activity.id);
          await insert(activity);
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

      it('counts one user’s activities, including ones stored earlier in the same transaction', async () => {
        expect(await fixture.uow.run((tx) => tx.activities.countForUser(ALICE))).toBe(0);
        await insert(makeActivity());
        await insert(makeActivity({ date: '2026-11-19' }));
        await insert(makeActivity({ userId: BOB }));
        expect(await fixture.uow.run((tx) => tx.activities.countForUser(ALICE))).toBe(2);
        expect(
          await fixture.uow.run(async (tx) => {
            await tx.activities.insertIfAbsent(makeActivity({ date: '2026-11-18' }));
            return tx.activities.countForUser(ALICE);
          }),
        ).toBe(3);
      });

      it('erases one user’s activities and nothing else', async () => {
        await insert(makeActivity());
        await insert(makeActivity({ date: '2026-11-19' }));
        await insert(makeActivity({ userId: BOB }));
        expect(await fixture.uow.run((tx) => tx.activities.deleteAllForUser(ALICE))).toBe(2);
        expect(await fixture.uow.run((tx) => tx.activities.deleteAllForUser(ALICE))).toBe(0);
        expect(await list({ userId: BOB })).toHaveLength(1);
      });
    });

    describe('habit directory', () => {
      const snapshot = (type: 'walking' | 'yoga' | 'running', at: Date, owner = ALICE) =>
        fixture.uow.run((tx) =>
          tx.habits.applySnapshot({ habitId: HABIT, ownerUserId: owner, activityType: type, at }),
        );
      const archive = (at: Date) =>
        fixture.uow.run((tx) =>
          tx.habits.applyArchived({ habitId: HABIT, ownerUserId: ALICE, at }),
        );

      it('knows nothing about an unseen habit', async () => {
        expect(await habit()).toBeNull();
      });

      it('stores a snapshot', async () => {
        await snapshot('walking', at(0));
        expect(await habit()).toEqual({
          habitId: HABIT,
          ownerUserId: ALICE,
          activityType: 'walking',
          archived: false,
        });
      });

      it('is idempotent: the same event twice leaves the same state', async () => {
        await snapshot('walking', at(0));
        await snapshot('walking', at(0));
        expect(await habit()).toMatchObject({ activityType: 'walking', archived: false });
      });

      it('takes the type from the newest event, whatever the arrival order', async () => {
        await snapshot('running', at(20));
        await snapshot('yoga', at(10)); // older, arrives late
        expect((await habit())?.activityType).toBe('running');
        await snapshot('walking', at(30));
        expect((await habit())?.activityType).toBe('walking');
      });

      it('keeps the first owner, which never changes', async () => {
        await snapshot('walking', at(0));
        await snapshot('walking', at(5), BOB);
        expect((await habit())?.ownerUserId).toBe(ALICE);
      });

      it('archiving is permanent, even if an update arrives afterwards', async () => {
        await snapshot('walking', at(0));
        await archive(at(10));
        await snapshot('yoga', at(5));
        await snapshot('running', at(20));
        expect(await habit()).toMatchObject({ archived: true });
      });

      it('an archive that arrives first leaves a placeholder the creation event completes', async () => {
        await archive(at(10));
        expect(await habit()).toMatchObject({ archived: true, activityType: null });
        await snapshot('yoga', at(0));
        expect(await habit()).toMatchObject({ archived: true, activityType: 'yoga' });
      });

      it('forgets all of one owner’s habits', async () => {
        await snapshot('walking', at(0));
        await fixture.uow.run((tx) =>
          tx.habits.applySnapshot({
            habitId: OTHER_HABIT,
            ownerUserId: BOB,
            activityType: 'yoga',
            at: at(0),
          }),
        );
        expect(await fixture.uow.run((tx) => tx.habits.deleteAllOwnedBy(ALICE))).toBe(1);
        expect(await habit()).toBeNull();
        expect(await habit(OTHER_HABIT)).not.toBeNull();
      });
    });

    describe('transactions and the outbox', () => {
      const event = () =>
        createEvent('ActivityCompleted', {
          eventId: nextId(),
          occurredAt: T0,
          correlationId: nextId(),
          payload: {
            userId: ALICE,
            habitId: HABIT,
            teamIds: [],
            activityType: 'walking',
            activityDate: '2026-11-20',
            totalCompleted: 1,
          },
        });

      it('commits the activity and its event together', async () => {
        await fixture.uow.run(async (tx) => {
          await tx.activities.insertIfAbsent(makeActivity());
          await tx.outbox.append(event());
        });
        expect(await list({})).toHaveLength(1);
        expect(await fixture.readOutbox()).toHaveLength(1);
      });

      it('rolls both back when the work throws', async () => {
        await expect(
          fixture.uow.run(async (tx) => {
            await tx.activities.insertIfAbsent(makeActivity());
            await tx.outbox.append(event());
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        expect(await list({})).toHaveLength(0);
        expect(await fixture.readOutbox()).toHaveLength(0);
      });
    });
  });
}
