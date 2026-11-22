import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import type { Transaction, UnitOfWork } from '../../src/application/ports.js';
import { Challenge, type BadgeRule, type Viewer } from '../../src/domain/challenge.js';
import {
  ADMIN,
  ALICE,
  BOB,
  CAROL,
  MANAGER,
  OTHER_MANAGER,
  OTHER_TEAM,
  TEAM,
  uuid,
} from './harness.js';

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

const viewer = (
  userId: string,
  options: Partial<Pick<Viewer, 'role' | 'teamIds' | 'managedTeamIds'>> = {},
): Viewer => ({ userId, role: 'employee', teamIds: [], managedTeamIds: [], ...options });

function make(
  overrides: {
    id?: string;
    teamId?: string;
    activityType?: Challenge['activityType'];
    startsOn?: string;
    endsOn?: string;
    createdAt?: Date;
    createdBy?: string;
    badgeRules?: BadgeRule[];
    status?: 'draft' | 'active' | 'completed' | 'cancelled';
  } = {},
): Challenge {
  // Persistence tests need challenges in any state, including ones that already ended, so the
  // state is set directly instead of walking the lifecycle (which the domain tests cover).
  const created = unwrap(
    Challenge.create({
      id: overrides.id ?? nextId(),
      name: 'Walk the world',
      activityType: overrides.activityType ?? 'walking',
      teamId: overrides.teamId ?? TEAM,
      startsOn: overrides.startsOn ?? '2026-11-20',
      endsOn: overrides.endsOn ?? '2026-11-30',
      badgeRules: overrides.badgeRules ?? [],
      createdByUserId: overrides.createdBy ?? MANAGER,
      now: new Date('2026-01-01T00:00:00Z'),
    }),
  );
  const status = overrides.status ?? 'draft';
  const createdAt = overrides.createdAt ?? T0;
  return Challenge.restore({
    ...created,
    status,
    createdAt,
    updatedAt: createdAt,
    completedOn: status === 'completed' ? created.endsOn : null,
  });
}

/**
 * One behavioural suite, run against every implementation (in-memory fake, PostgreSQL through
 * PGlite, PostgreSQL through the real driver). If a fake and the real database ever disagree, a
 * test here fails, so unit tests built on the fake can be trusted.
 */
export function repositoryContract(name: string, create: () => Promise<RepositoryFixture>): void {
  describe(`challenge repository contract: ${name}`, () => {
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

    const run = <T>(work: (tx: Transaction) => Promise<T>) => fixture.uow.run(work);
    const insert = (challenge: Challenge) => run((tx) => tx.challenges.insert(challenge));
    const find = (id: string, as: Viewer) =>
      run<Challenge | null>((tx) => tx.challenges.findVisible(id, as));
    const join = (challengeId: string, userId: string, joinedOn = '2026-11-20') =>
      run<boolean>((tx) => tx.participations.add({ challengeId, userId, teamId: TEAM, joinedOn }));

    describe('challenges', () => {
      it('stores and loads a challenge with its badge rules, dates as plain text', async () => {
        const rules: BadgeRule[] = [
          { id: nextId(), kind: 'total', threshold: 10 },
          { id: nextId(), kind: 'streak', threshold: 3 },
        ];
        const challenge = make({ badgeRules: rules, status: 'active' });
        await insert(challenge);

        const loaded = await find(challenge.id, viewer(MANAGER, { managedTeamIds: [TEAM] }));
        expect(loaded).toMatchObject({
          id: challenge.id,
          name: 'Walk the world',
          activityType: 'walking',
          teamId: TEAM,
          startsOn: '2026-11-20',
          endsOn: '2026-11-30',
          status: 'active',
          createdByUserId: MANAGER,
          completedOn: null,
        });
        expect(loaded?.createdAt.getTime()).toBe(T0.getTime());
        expect(
          [...(loaded?.badgeRules ?? [])].map((r) => `${r.kind}:${r.threshold}`).sort(),
        ).toEqual(['streak:3', 'total:10']);
        expect(new Set(loaded?.badgeRules.map((r) => r.id))).toEqual(
          new Set(rules.map((r) => r.id)),
        );
      });

      it('finds a challenge exactly when the domain says the viewer may see it', async () => {
        const viewers = {
          creator: viewer(MANAGER),
          teamManager: viewer(OTHER_MANAGER, { role: 'manager', managedTeamIds: [TEAM] }),
          otherManager: viewer(uuid(0xe8), { role: 'manager', managedTeamIds: [OTHER_TEAM] }),
          teamMember: viewer(ALICE, { teamIds: [TEAM] }),
          outsider: viewer(CAROL, { teamIds: [OTHER_TEAM] }),
          admin: viewer(ADMIN, { role: 'admin' }),
          nobody: viewer(uuid(0x99)),
        };
        for (const status of ['draft', 'active', 'completed', 'cancelled'] as const) {
          const challenge = make({ status });
          await insert(challenge);
          for (const [who, v] of Object.entries(viewers)) {
            const found = await find(challenge.id, v);
            expect(found !== null, `${status} / ${who}`).toBe(challenge.canBeSeenBy(v));
          }
        }
      });

      it('loads a challenge whose creator was removed', async () => {
        const challenge = make({ status: 'active' });
        await insert(challenge);
        expect(await run<number>((tx) => tx.challenges.detachCreator(MANAGER))).toBe(1);
        expect(await run<number>((tx) => tx.challenges.detachCreator(MANAGER))).toBe(0);
        const loaded = await find(challenge.id, viewer(ALICE, { teamIds: [TEAM] }));
        expect(loaded?.createdByUserId).toBeNull();
      });

      it('changes the status only if it is still what the caller read (conditional)', async () => {
        const draft = make();
        await insert(draft);
        const active = unwrap(draft.start(at(10)));
        expect(await run<boolean>((tx) => tx.challenges.transition(active, 'draft'))).toBe(true);
        // A second request that also read "draft" loses.
        const cancelled = unwrap(draft.cancel(at(11)));
        expect(await run<boolean>((tx) => tx.challenges.transition(cancelled, 'draft'))).toBe(
          false,
        );
        expect((await find(draft.id, viewer(ADMIN, { role: 'admin' })))?.status).toBe('active');
      });

      it('stores the completion date and the update time with a transition', async () => {
        const active = make({ status: 'active', endsOn: '2026-11-22' });
        await insert(active);
        const done = unwrap(active.complete(at(99)));
        expect(await run<boolean>((tx) => tx.challenges.transition(done, 'active'))).toBe(true);
        const loaded = await find(active.id, viewer(ADMIN, { role: 'admin' }));
        expect(loaded).toMatchObject({ status: 'completed', completedOn: '2026-11-22' });
        expect(loaded?.updatedAt.getTime()).toBe(at(99).getTime());
      });

      it('lists newest first, only what the viewer may see, and filters by status', async () => {
        const a = make({ createdAt: at(1), status: 'active' });
        const b = make({ createdAt: at(2), status: 'active' });
        const draft = make({ createdAt: at(3) });
        const elsewhere = make({
          createdAt: at(4),
          teamId: OTHER_TEAM,
          status: 'active',
          createdBy: OTHER_MANAGER,
        });
        for (const c of [a, b, draft, elsewhere]) await insert(c);

        const list = (v: Viewer, status?: Challenge['status']) =>
          run<readonly Challenge[]>((tx) =>
            tx.challenges.list({
              viewer: v,
              limit: 50,
              ...(status === undefined ? {} : { status }),
            }),
          ).then((rows) => rows.map((c) => c.id));

        const member = viewer(ALICE, { teamIds: [TEAM] });
        expect(await list(member)).toEqual([b.id, a.id]);
        expect(await list(member, 'draft')).toEqual([]);
        expect(
          await list(viewer(MANAGER, { role: 'manager', managedTeamIds: [TEAM], teamIds: [TEAM] })),
        ).toEqual([draft.id, b.id, a.id]);
        expect(await list(viewer(MANAGER), 'draft')).toEqual([draft.id]);
        expect(await list(viewer(ADMIN, { role: 'admin' }))).toEqual([
          elsewhere.id,
          draft.id,
          b.id,
          a.id,
        ]);
        expect(await list(viewer(uuid(0x99)))).toEqual([]);
      });

      it('pages through a long list without gaps or repeats', async () => {
        const all = Array.from({ length: 7 }, (_, i) =>
          make({ createdAt: at(i), status: 'active' }),
        );
        for (const c of all) await insert(c);
        const member = viewer(ALICE, { teamIds: [TEAM] });
        const seen: string[] = [];
        let after: { createdAt: Date; id: string } | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const rows = await run<readonly Challenge[]>((tx) =>
            tx.challenges.list({ viewer: member, limit: 3, ...(after ? { after } : {}) }),
          );
          seen.push(...rows.map((c) => c.id));
          const last = rows[rows.length - 1];
          if (rows.length < 3 || last === undefined) break;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(seen).toEqual(all.map((c) => c.id).reverse());
      });

      it('finds scoring challenges only for participants, on matching type and day, once joined', async () => {
        const scoring = make({ status: 'active', activityType: 'walking' });
        const yoga = make({ status: 'active', activityType: 'yoga' });
        const draft = make();
        const cancelled = make({ status: 'cancelled' });
        const notJoined = make({ status: 'active' });
        for (const c of [scoring, yoga, draft, cancelled, notJoined]) await insert(c);
        for (const c of [scoring, yoga, draft, cancelled]) await join(c.id, ALICE);

        const scoringFor = (date: string, type: Challenge['activityType'] = 'walking') =>
          run<readonly Challenge[]>((tx) => tx.challenges.findScoring(ALICE, type, date)).then(
            (rows) => rows.map((c) => c.id),
          );

        expect(await scoringFor('2026-11-20')).toEqual([scoring.id]);
        expect(await scoringFor('2026-11-20', 'yoga')).toEqual([yoga.id]);
        expect(await scoringFor('2026-11-19')).toEqual([]); // before the challenge
        expect(await scoringFor('2026-12-01')).toEqual([]); // after it
        expect(await scoringFor('2026-11-30')).toEqual([scoring.id]); // its last day
        expect(
          await run<readonly Challenge[]>((tx) =>
            tx.challenges.findScoring(BOB, 'walking', '2026-11-20'),
          ),
        ).toEqual([]);
      });

      it('does not score an activity from before the person joined', async () => {
        const challenge = make({ status: 'active', startsOn: '2026-11-10' });
        await insert(challenge);
        await join(challenge.id, ALICE, '2026-11-20');
        const scoringFor = (date: string) =>
          run<readonly Challenge[]>((tx) => tx.challenges.findScoring(ALICE, 'walking', date)).then(
            (r) => r.length,
          );
        expect(await scoringFor('2026-11-15')).toBe(0);
        expect(await scoringFor('2026-11-20')).toBe(1);
      });

      it('lists the drafts due to start and the active challenges that ended before a day', async () => {
        const due = make({ startsOn: '2026-11-20', endsOn: '2026-11-25' });
        const early = make({ startsOn: '2026-11-22', endsOn: '2026-11-25' });
        const over = make({ startsOn: '2026-11-01', endsOn: '2026-11-10' });
        const endedActive = make({
          status: 'active',
          startsOn: '2026-11-01',
          endsOn: '2026-11-19',
        });
        const lastDayToday = make({
          status: 'active',
          startsOn: '2026-11-01',
          endsOn: '2026-11-20',
        });
        // `over` ended already, so it is created through the repository directly.
        for (const c of [due, early, endedActive, lastDayToday]) await insert(c);
        await insert(over);

        const draftsDue = await run<readonly Challenge[]>((tx) =>
          tx.challenges.listDraftsDue('2026-11-20'),
        );
        expect(draftsDue.map((c) => c.id)).toEqual([due.id]);
        const ended = await run<readonly Challenge[]>((tx) =>
          tx.challenges.listActiveEndedBefore('2026-11-20'),
        );
        expect(ended.map((c) => c.id)).toEqual([endedActive.id]);
      });
    });

    describe('participations', () => {
      it('adds a person once, however often', async () => {
        const challenge = make({ status: 'active' });
        await insert(challenge);
        expect(await join(challenge.id, ALICE)).toBe(true);
        expect(await join(challenge.id, ALICE)).toBe(false);
        expect(await run((tx) => tx.participations.find(challenge.id, ALICE))).toEqual({
          challengeId: challenge.id,
          userId: ALICE,
          joinedOn: '2026-11-20',
          points: 0,
        });
        expect(await run((tx) => tx.participations.find(challenge.id, BOB))).toBeNull();
      });

      it('counts participants per challenge and tells which ones a person joined', async () => {
        const a = make({ status: 'active' });
        const b = make({ status: 'active' });
        const empty = make({ status: 'active' });
        for (const c of [a, b, empty]) await insert(c);
        await join(a.id, ALICE);
        await join(a.id, BOB);
        await join(b.id, ALICE);

        const counts = await run<ReadonlyMap<string, number>>((tx) =>
          tx.participations.countFor([a.id, b.id, empty.id]),
        );
        expect(counts.get(a.id)).toBe(2);
        expect(counts.get(b.id)).toBe(1);
        expect(counts.get(empty.id) ?? 0).toBe(0);
        expect(
          await run<ReadonlyMap<string, number>>((tx) => tx.participations.countFor([])),
        ).toEqual(new Map());

        const joined = await run<ReadonlySet<string>>((tx) =>
          tx.participations.joinedAmong(ALICE, [a.id, b.id, empty.id]),
        );
        expect(joined).toEqual(new Set([a.id, b.id]));
        expect(
          await run<ReadonlySet<string>>((tx) => tx.participations.joinedAmong(ALICE, [])),
        ).toEqual(new Set());
      });

      it('ranks with ties sharing a place (1, 2, 2, 4), highest first, ties by user id', async () => {
        const challenge = make({ status: 'active' });
        await insert(challenge);
        const people = [
          [uuid(0xa4), 1],
          [uuid(0xa2), 5],
          [uuid(0xa3), 5],
          [uuid(0xa1), 9],
        ] as const;
        for (const [userId, points] of people) {
          await join(challenge.id, userId);
          for (let i = 0; i < points; i += 1)
            await run((tx) => tx.participations.addPoint(challenge.id, userId));
        }
        const board = await run<readonly { userId: string; points: number; rank: number }[]>((tx) =>
          tx.participations.leaderboard(challenge.id, 10),
        );
        expect(board.map((s) => [s.userId, s.points, s.rank])).toEqual([
          [uuid(0xa1), 9, 1],
          [uuid(0xa2), 5, 2],
          [uuid(0xa3), 5, 2],
          [uuid(0xa4), 1, 4],
        ]);
      });

      it('keeps true ranks when the list is cut short, and finds a person’s own rank beyond it', async () => {
        const challenge = make({ status: 'active' });
        await insert(challenge);
        for (const [userId, points] of [
          [uuid(0xa1), 3],
          [uuid(0xa2), 2],
          [uuid(0xa3), 2],
          [uuid(0xa4), 0],
        ] as const) {
          await join(challenge.id, userId);
          for (let i = 0; i < points; i += 1)
            await run((tx) => tx.participations.addPoint(challenge.id, userId));
        }
        const top = await run<readonly { userId: string; rank: number }[]>((tx) =>
          tx.participations.leaderboard(challenge.id, 2),
        );
        expect(top.map((s) => s.rank)).toEqual([1, 2]);
        expect(await run((tx) => tx.participations.rankOf(challenge.id, uuid(0xa3)))).toMatchObject(
          { points: 2, rank: 2 },
        );
        expect(await run((tx) => tx.participations.rankOf(challenge.id, uuid(0xa4)))).toMatchObject(
          { points: 0, rank: 4 },
        );
        expect(await run((tx) => tx.participations.rankOf(challenge.id, CAROL))).toBeNull();
      });

      it('withdraws a person from the unfinished challenges of one team only', async () => {
        const draft = make();
        const active = make({ status: 'active' });
        const done = make({ status: 'completed' });
        const elsewhere = make({ status: 'active', teamId: OTHER_TEAM });
        for (const c of [draft, active, done, elsewhere]) {
          await insert(c);
          await join(c.id, ALICE);
        }
        await join(active.id, BOB);

        const left = await run<readonly string[]>((tx) =>
          tx.participations.withdrawFromTeam(ALICE, TEAM),
        );
        expect([...left].sort()).toEqual([draft.id, active.id].sort());
        expect(
          await run<readonly string[]>((tx) => tx.participations.withdrawFromTeam(ALICE, TEAM)),
        ).toEqual([]);
        expect(await run((tx) => tx.participations.find(done.id, ALICE))).not.toBeNull();
        expect(await run((tx) => tx.participations.find(elsewhere.id, ALICE))).not.toBeNull();
        expect(await run((tx) => tx.participations.find(active.id, BOB))).not.toBeNull();
      });

      it('erases everything about one person', async () => {
        const a = make({ status: 'active' });
        const b = make({ status: 'active' });
        for (const c of [a, b]) {
          await insert(c);
          await join(c.id, ALICE);
        }
        await join(a.id, BOB);
        expect(await run<number>((tx) => tx.participations.deleteAllForUser(ALICE))).toBe(2);
        expect(await run<number>((tx) => tx.participations.deleteAllForUser(ALICE))).toBe(0);
        expect(await run((tx) => tx.participations.find(a.id, BOB))).not.toBeNull();
      });
    });

    describe('scoring ledger', () => {
      const entry = (
        challengeId: string,
        sourceEventId: string,
        userId = ALICE,
        activityDate = '2026-11-20',
      ) => ({
        challengeId,
        sourceEventId,
        userId,
        activityDate,
      });

      it('records an event once per challenge', async () => {
        const a = make({ status: 'active' });
        const b = make({ status: 'active' });
        await insert(a);
        await insert(b);
        const event = uuid(0x5001);
        expect(await run<boolean>((tx) => tx.progress.record(entry(a.id, event)))).toBe(true);
        expect(await run<boolean>((tx) => tx.progress.record(entry(a.id, event)))).toBe(false);
        expect(await run<boolean>((tx) => tx.progress.record(entry(b.id, event)))).toBe(true); // another challenge
      });

      it('returns a person’s dates oldest first, with repeats, as plain text', async () => {
        const challenge = make({ status: 'active' });
        await insert(challenge);
        for (const [i, date] of [
          '2026-11-22',
          '2026-11-20',
          '2026-11-20',
          '2026-11-21',
        ].entries()) {
          await run((tx) => tx.progress.record(entry(challenge.id, uuid(0x6000 + i), ALICE, date)));
        }
        await run((tx) => tx.progress.record(entry(challenge.id, uuid(0x6100), BOB, '2026-11-25')));
        expect(await run((tx) => tx.progress.dates(challenge.id, ALICE))).toEqual([
          '2026-11-20',
          '2026-11-20',
          '2026-11-21',
          '2026-11-22',
        ]);
      });

      it('deletes a person’s entries in some challenges, or in all, and nobody else’s', async () => {
        const a = make({ status: 'active' });
        const b = make({ status: 'active' });
        await insert(a);
        await insert(b);
        await run((tx) => tx.progress.record(entry(a.id, uuid(0x7001))));
        await run((tx) => tx.progress.record(entry(b.id, uuid(0x7002))));
        await run((tx) => tx.progress.record(entry(a.id, uuid(0x7003), BOB)));

        expect(await run<number>((tx) => tx.progress.deleteForUserIn(ALICE, [a.id]))).toBe(1);
        expect(await run<number>((tx) => tx.progress.deleteForUserIn(ALICE, []))).toBe(0);
        expect(await run((tx) => tx.progress.dates(b.id, ALICE))).toHaveLength(1);
        expect(await run<number>((tx) => tx.progress.deleteAllForUser(ALICE))).toBe(1);
        expect(await run((tx) => tx.progress.dates(a.id, BOB))).toHaveLength(1);
      });
    });

    describe('badges', () => {
      it('awards a badge once per person and rule', async () => {
        const rule: BadgeRule = { id: nextId(), kind: 'total', threshold: 5 };
        const challenge = make({ status: 'active', badgeRules: [rule] });
        await insert(challenge);
        const badge = (userId: string) => ({
          challengeId: challenge.id,
          userId,
          badgeRuleId: rule.id,
          awardedOn: '2026-11-21',
        });
        expect(await run<boolean>((tx) => tx.badges.award(badge(ALICE)))).toBe(true);
        expect(await run<boolean>((tx) => tx.badges.award(badge(ALICE)))).toBe(false);
        expect(await run<boolean>((tx) => tx.badges.award(badge(BOB)))).toBe(true);

        expect(await run((tx) => tx.badges.listFor(challenge.id, ALICE))).toEqual([badge(ALICE)]);
        expect(await run<number>((tx) => tx.badges.deleteAllForUser(ALICE))).toBe(1);
        expect(await run((tx) => tx.badges.listFor(challenge.id, ALICE))).toEqual([]);
        expect(await run((tx) => tx.badges.listFor(challenge.id, BOB))).toHaveLength(1);
      });
    });

    describe('transactions and the outbox', () => {
      const event = () =>
        createEvent('ChallengeJoined', {
          eventId: nextId(),
          occurredAt: T0,
          correlationId: nextId(),
          payload: { challengeId: uuid(1), userId: ALICE, teamId: TEAM },
        });

      it('commits the change together with its event', async () => {
        const challenge = make({ status: 'active' });
        await run(async (tx) => {
          await tx.challenges.insert(challenge);
          await tx.outbox.append(event());
        });
        expect(await find(challenge.id, viewer(ADMIN, { role: 'admin' }))).not.toBeNull();
      });

      it('rolls everything back when the work fails', async () => {
        const challenge = make({ status: 'active' });
        await expect(
          run(async (tx) => {
            await tx.challenges.insert(challenge);
            await tx.participations.add({
              challengeId: challenge.id,
              userId: ALICE,
              teamId: TEAM,
              joinedOn: '2026-11-20',
            });
            await tx.outbox.append(event());
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await find(challenge.id, viewer(ADMIN, { role: 'admin' }))).toBeNull();
        expect(await run((tx) => tx.participations.find(challenge.id, ALICE))).toBeNull();
      });
    });
  });
}
