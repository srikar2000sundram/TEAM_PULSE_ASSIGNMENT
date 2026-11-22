import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type ActivityType } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import type { HabitListQuery, UnitOfWork } from '../../src/application/ports.js';
import { Habit, type Sharing, type Viewer } from '../../src/domain/habit.js';
import { ALICE, BOB, CAROL, DATA, PLATFORM, REMINDER, uuid } from './harness.js';

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

function makeHabit(
  overrides: {
    owner?: string;
    title?: string;
    sharing?: Sharing;
    activityType?: ActivityType;
    createdAt?: Date;
    id?: string;
    reminder?: typeof REMINDER;
    description?: string;
  } = {},
): Habit {
  return unwrap(
    Habit.create({
      id: overrides.id ?? nextId(),
      ownerUserId: overrides.owner ?? ALICE,
      title: overrides.title ?? 'Morning walk',
      description: overrides.description,
      activityType: overrides.activityType ?? 'walking',
      sharing: overrides.sharing ?? { visibility: 'private' },
      reminder: overrides.reminder,
      now: overrides.createdAt ?? T0,
    }),
  );
}

const shared = (teamId: string): Sharing => ({ visibility: 'team', teamId });
const viewer = (userId: string, ...teamIds: string[]): Viewer => ({ userId, teamIds });

/**
 * One behavioural suite, run against every HabitRepository implementation (in-memory fake,
 * PostgreSQL through PGlite, PostgreSQL through the real driver). If a fake and the real database
 * ever disagree, a test here fails, so unit tests built on the fake can be trusted.
 */
export function repositoryContract(name: string, create: () => Promise<RepositoryFixture>): void {
  describe(`habit repository contract: ${name}`, () => {
    let fixture: RepositoryFixture;
    const insert = (habit: Habit) => fixture.uow.run((tx) => tx.habits.insert(habit));
    const find = (id: string, v: Viewer, lock = false) =>
      fixture.uow.run((tx) => tx.habits.findVisible(id, v, { lock }));
    const list = (query: Partial<HabitListQuery> & { viewer: Viewer }) =>
      fixture.uow.run((tx) =>
        tx.habits.list({ scope: 'mine', status: 'active', limit: 50, ...query }),
      );
    const ids = (habits: readonly Habit[]) => habits.map((h) => h.id);

    const ready = create().then((f) => (fixture = f));
    beforeEach(async () => {
      await ready;
      await fixture.reset();
    });
    afterAll(async () => {
      await ready;
      await fixture.close();
    });

    describe('storing habits', () => {
      it('round-trips every field', async () => {
        const habit = makeHabit({
          sharing: shared(PLATFORM),
          description: 'after lunch',
          reminder: REMINDER,
          activityType: 'yoga',
        });
        await insert(habit);
        const loaded = await find(habit.id, viewer(ALICE));
        expect(loaded).toMatchObject({
          id: habit.id,
          ownerUserId: ALICE,
          title: 'Morning walk',
          description: 'after lunch',
          activityType: 'yoga',
          visibility: 'team',
          teamId: PLATFORM,
          archivedAt: null,
        });
        expect(loaded?.createdAt).toEqual(T0);
        expect(loaded?.reminder).toEqual({
          daysOfWeek: ['mon', 'wed'],
          remindAt: '07:30',
          timeZone: 'Europe/Berlin',
        });
      });

      it('a reloaded habit does not look changed to subscribers (jsonb reorders keys)', async () => {
        const habit = makeHabit({ reminder: REMINDER });
        await insert(habit);
        const loaded = await find(habit.id, viewer(ALICE));
        expect(loaded?.differsForSubscribers(habit)).toBe(false);
      });

      it('stores no description and no reminder as nothing', async () => {
        const habit = makeHabit();
        await insert(habit);
        const loaded = await find(habit.id, viewer(ALICE));
        expect(loaded).toMatchObject({ description: null, reminder: null, teamId: null });
      });

      it('persists updates, including clearing optional fields and archiving', async () => {
        const habit = makeHabit({
          description: 'x',
          reminder: REMINDER,
          sharing: shared(PLATFORM),
        });
        await insert(habit);
        const changed = unwrap(
          habit.apply(
            {
              title: 'Renamed',
              description: null,
              reminder: null,
              sharing: { visibility: 'private' },
            },
            at(60),
          ),
        ).archive(at(120));
        await fixture.uow.run((tx) => tx.habits.update(changed));

        const loaded = await find(habit.id, viewer(ALICE));
        expect(loaded).toMatchObject({
          title: 'Renamed',
          description: null,
          reminder: null,
          visibility: 'private',
          teamId: null,
        });
        expect(loaded?.archivedAt).toEqual(at(120));
        expect(loaded?.updatedAt).toEqual(at(120));
      });
    });

    describe('visibility is enforced by the query', () => {
      it('applies the same rule as Habit.isVisibleTo for every combination', async () => {
        const habits = [
          makeHabit({ title: 'private' }),
          makeHabit({ title: 'platform', sharing: shared(PLATFORM) }),
          makeHabit({ title: 'data', sharing: shared(DATA) }),
          makeHabit({ title: 'platform archived', sharing: shared(PLATFORM) }).archive(T0),
          makeHabit({ title: 'private archived' }).archive(T0),
        ];
        for (const habit of habits) await insert(habit);

        const viewers = [
          viewer(ALICE),
          viewer(ALICE, PLATFORM),
          viewer(BOB),
          viewer(BOB, PLATFORM),
          viewer(BOB, DATA),
          viewer(BOB, PLATFORM, DATA),
          viewer(CAROL, DATA),
        ];
        for (const v of viewers) {
          for (const habit of habits) {
            const found = await find(habit.id, v);
            expect(found !== null, `${habit.title} as ${v.userId} [${v.teamIds.join(',')}]`).toBe(
              habit.isVisibleTo(v),
            );
          }
        }
      });

      it('a hidden habit cannot be locked either', async () => {
        const habit = makeHabit();
        await insert(habit);
        expect(await find(habit.id, viewer(BOB, PLATFORM), true)).toBeNull();
        expect((await find(habit.id, viewer(ALICE), true))?.id).toBe(habit.id);
      });

      it('an unknown id finds nothing', async () => {
        expect(await find(uuid(0xdead), viewer(ALICE))).toBeNull();
      });
    });

    describe('counting', () => {
      it('counts only the owner’s active habits', async () => {
        await insert(makeHabit());
        await insert(makeHabit({ sharing: shared(PLATFORM) }));
        await insert(makeHabit().archive(T0));
        await insert(makeHabit({ owner: BOB }));
        expect(await fixture.uow.run((tx) => tx.habits.countActiveOwnedBy(ALICE))).toBe(2);
        expect(await fixture.uow.run((tx) => tx.habits.countActiveOwnedBy(CAROL))).toBe(0);
      });
    });

    describe('listing', () => {
      it('mine: only the owner’s, active or archived as asked, newest first', async () => {
        const old = makeHabit({ title: 'old', createdAt: at(0) });
        const recent = makeHabit({ title: 'recent', createdAt: at(10) });
        const archived = makeHabit({ title: 'archived', createdAt: at(5) }).archive(at(6));
        const bobs = makeHabit({ owner: BOB, createdAt: at(7) });
        for (const habit of [old, recent, archived, bobs]) await insert(habit);

        expect(ids(await list({ viewer: viewer(ALICE) }))).toEqual([recent.id, old.id]);
        expect(ids(await list({ viewer: viewer(ALICE), status: 'archived' }))).toEqual([
          archived.id,
        ]);
      });

      it('team: only others’ active habits shared with the viewer’s teams', async () => {
        const visible = makeHabit({ sharing: shared(PLATFORM), createdAt: at(1) });
        const visibleToo = makeHabit({ owner: CAROL, sharing: shared(PLATFORM), createdAt: at(2) });
        await insert(visible);
        await insert(visibleToo);
        await insert(makeHabit({ title: 'private' }));
        await insert(makeHabit({ sharing: shared(PLATFORM) }).archive(T0));
        await insert(makeHabit({ sharing: shared(DATA) }));
        await insert(makeHabit({ owner: BOB, sharing: shared(PLATFORM) })); // Bob's own

        const seen = await list({ viewer: viewer(BOB, PLATFORM), scope: 'team' });
        expect(ids(seen)).toEqual([visibleToo.id, visible.id]);
      });

      it('team: a viewer in no team sees nothing, and a foreign team filter yields nothing', async () => {
        await insert(makeHabit({ sharing: shared(PLATFORM) }));
        expect(await list({ viewer: viewer(BOB), scope: 'team' })).toEqual([]);
        expect(await list({ viewer: viewer(BOB, DATA), scope: 'team', teamId: PLATFORM })).toEqual(
          [],
        );
      });

      it('team: narrows to one of the viewer’s teams', async () => {
        const p = makeHabit({ sharing: shared(PLATFORM) });
        const d = makeHabit({ sharing: shared(DATA) });
        await insert(p);
        await insert(d);
        const v = viewer(BOB, PLATFORM, DATA);
        expect(ids(await list({ viewer: v, scope: 'team' }))).toHaveLength(2);
        expect(ids(await list({ viewer: v, scope: 'team', teamId: DATA }))).toEqual([d.id]);
      });

      it('filters by activity type', async () => {
        const yoga = makeHabit({ activityType: 'yoga' });
        await insert(yoga);
        await insert(makeHabit({ activityType: 'running' }));
        expect(ids(await list({ viewer: viewer(ALICE), activityType: 'yoga' }))).toEqual([yoga.id]);
      });

      it('keyset pagination visits every row once, including rows with equal timestamps', async () => {
        const all: string[] = [];
        for (let i = 0; i < 7; i += 1) {
          // Pairs share a timestamp, so the id tie-breaker decides their order.
          const habit = makeHabit({ createdAt: at(Math.floor(i / 2)) });
          all.push(habit.id);
          await insert(habit);
        }

        const seen: string[] = [];
        let after: HabitListQuery['after'];
        for (let page = 0; page < 10; page += 1) {
          const rows = await list({ viewer: viewer(ALICE), limit: 3, ...(after ? { after } : {}) });
          if (rows.length === 0) break;
          seen.push(...ids(rows));
          const last = rows.at(-1)!;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen)).toEqual(new Set(all));
      });

      it('honours the limit', async () => {
        for (let i = 0; i < 5; i += 1) await insert(makeHabit());
        expect(await list({ viewer: viewer(ALICE), limit: 2 })).toHaveLength(2);
      });
    });

    describe('withdrawing from a team', () => {
      it('makes only that owner’s habits of that team private, and returns them', async () => {
        const target = makeHabit({ sharing: shared(PLATFORM) });
        const archived = makeHabit({ sharing: shared(PLATFORM) }).archive(T0);
        const otherTeam = makeHabit({ sharing: shared(DATA) });
        const bobs = makeHabit({ owner: BOB, sharing: shared(PLATFORM) });
        for (const habit of [target, archived, otherTeam, bobs]) await insert(habit);

        const changed = await fixture.uow.run((tx) =>
          tx.habits.withdrawFromTeam(ALICE, PLATFORM, at(60)),
        );
        expect(ids(changed).sort()).toEqual([target.id, archived.id].sort());
        expect(changed.every((h) => h.visibility === 'private' && h.teamId === null)).toBe(true);

        expect((await find(target.id, viewer(ALICE)))?.visibility).toBe('private');
        expect((await find(target.id, viewer(BOB, PLATFORM))) === null).toBe(true);
        expect((await find(otherTeam.id, viewer(ALICE)))?.teamId).toBe(DATA);
        expect((await find(bobs.id, viewer(BOB)))?.teamId).toBe(PLATFORM);
      });
    });

    describe('erasure', () => {
      it('removes all of one owner’s habits and nothing else', async () => {
        await insert(makeHabit());
        await insert(makeHabit({ sharing: shared(PLATFORM) }));
        await insert(makeHabit().archive(T0));
        const keep = makeHabit({ owner: BOB });
        await insert(keep);

        expect(await fixture.uow.run((tx) => tx.habits.deleteAllOwnedBy(ALICE))).toBe(3);
        expect(await fixture.uow.run((tx) => tx.habits.deleteAllOwnedBy(ALICE))).toBe(0);
        expect(ids(await list({ viewer: viewer(BOB) }))).toEqual([keep.id]);
      });
    });

    describe('transactions and the outbox', () => {
      const event = () =>
        createEvent('HabitArchived', {
          eventId: nextId(),
          occurredAt: T0,
          correlationId: nextId(),
          payload: { habitId: nextId(), ownerUserId: ALICE },
        });

      it('commits the habit and its event together', async () => {
        const habit = makeHabit();
        await fixture.uow.run(async (tx) => {
          await tx.habits.insert(habit);
          await tx.outbox.append(event());
        });
        expect(await find(habit.id, viewer(ALICE))).not.toBeNull();
        expect(await fixture.readOutbox()).toHaveLength(1);
      });

      it('rolls both back when the work throws', async () => {
        const habit = makeHabit();
        await expect(
          fixture.uow.run(async (tx) => {
            await tx.habits.insert(habit);
            await tx.outbox.append(event());
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        expect(await find(habit.id, viewer(ALICE))).toBeNull();
        expect(await fixture.readOutbox()).toHaveLength(0);
      });
    });
  });
}
