import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap, type Result } from '@teampulse/kernel';
import {
  ADMIN,
  ALICE,
  BOB,
  CAROL,
  OTHER_TEAM,
  TEAM,
  admin,
  buildHarness,
  manager,
  member,
  otherManager,
  principal,
  uuid,
} from '../support/harness.js';

const errorOf = (result: Result<unknown>) => (result.ok ? undefined : result.error);

describe('CreateChallenge', () => {
  it('lets a manager create a draft for a team they manage', async () => {
    const h = buildHarness();
    const view = await h.create({ badgeRules: [{ kind: 'streak', threshold: 3 }] });
    expect(view.challenge).toMatchObject({
      status: 'draft',
      teamId: TEAM,
      activityType: 'walking',
      createdByUserId: manager.userId,
    });
    expect(view.challenge.badgeRules).toHaveLength(1);
    expect(view).toMatchObject({ participantCount: 0, joined: false });
  });

  it('lets an administrator create for any team', async () => {
    const h = buildHarness();
    const view = await h.create({ teamId: OTHER_TEAM }, admin);
    expect(view.challenge.teamId).toBe(OTHER_TEAM);
  });

  it('refuses a manager for a team they do not manage, and refuses employees', async () => {
    const h = buildHarness();
    for (const actor of [
      otherManager,
      member(ALICE),
      principal(ALICE, { teams: [TEAM], manages: [TEAM] }),
    ]) {
      const result = await h.app.createChallenge.execute({
        actor,
        name: 'x',
        activityType: 'walking',
        teamId: TEAM,
        startsOn: '2026-11-20',
        endsOn: '2026-11-30',
        badgeRules: [],
      });
      expect(errorOf(result)?.code, actor.userId).toBe('challenge.team_not_managed');
    }
  });

  it('turns domain problems into validation errors', async () => {
    const h = buildHarness();
    const result = await h.app.createChallenge.execute({
      actor: manager,
      name: 'x',
      activityType: 'walking',
      teamId: TEAM,
      startsOn: '2026-12-01',
      endsOn: '2026-11-30',
      badgeRules: [],
    });
    expect(errorOf(result)?.kind).toBe('validation');
  });
});

describe('visibility (404 instead of 403, so challenges cannot be discovered)', () => {
  it('hides a draft from the team, and shows it to its managers and administrators', async () => {
    const h = buildHarness();
    const { challenge } = await h.create();
    const ask = (actor: ReturnType<typeof member>) =>
      h.app.getChallenge.execute({ actor, challengeId: challenge.id });

    expect(errorOf(await ask(member(ALICE)))?.code).toBe('challenge.not_found');
    expect((await ask(manager)).ok).toBe(true);
    expect((await ask(admin)).ok).toBe(true);
  });

  it('answers an outsider exactly as for a challenge that does not exist', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    const outsider = principal(CAROL, { teams: [OTHER_TEAM] });
    const real = errorOf(
      await h.app.getChallenge.execute({ actor: outsider, challengeId: challenge.id }),
    );
    const missing = errorOf(
      await h.app.getChallenge.execute({ actor: outsider, challengeId: uuid(0x404) }),
    );
    expect(real).toMatchObject({ kind: 'not_found', code: 'challenge.not_found' });
    expect(real?.message).toBe(missing?.message);
    for (const action of ['startChallenge', 'cancelChallenge', 'joinChallenge'] as const) {
      expect(
        errorOf(await h.app[action].execute({ actor: outsider, challengeId: challenge.id }))?.code,
        action,
      ).toBe('challenge.not_found');
    }
  });

  it('lists only what the caller may see, with the member count and whether they joined', async () => {
    const h = buildHarness();
    const active = await h.createActive({ name: 'Active' });
    await h.create({ name: 'Draft' });
    await h.create({ name: 'Elsewhere', teamId: OTHER_TEAM }, admin);
    await h.join(active.id, ALICE);
    await h.join(active.id, BOB);

    const list = async (actor: ReturnType<typeof member>) =>
      unwrap(await h.app.listChallenges.execute({ actor, limit: 50 })).items;

    const alice = await list(member(ALICE));
    expect(alice.map((v) => v.challenge.name)).toEqual(['Active']);
    expect(alice[0]).toMatchObject({ participantCount: 2, joined: true });
    expect((await list(member(CAROL)))[0]).toMatchObject({ participantCount: 2, joined: false });
    expect((await list(manager)).map((v) => v.challenge.name).sort()).toEqual(['Active', 'Draft']);
    expect((await list(admin)).map((v) => v.challenge.name).sort()).toEqual([
      'Active',
      'Draft',
      'Elsewhere',
    ]);
    expect(await list(principal(CAROL, { teams: [OTHER_TEAM] }))).toEqual([]);
  });

  it('filters by status and pages with an opaque cursor', async () => {
    const h = buildHarness();
    for (let i = 1; i <= 5; i += 1) {
      await h.createActive({ name: `Challenge ${i}` });
      h.clock.advanceMs(1000);
    }
    await h.create({ name: 'A draft' });

    const first = unwrap(
      await h.app.listChallenges.execute({ actor: manager, limit: 4, status: 'active' }),
    );
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toBeDefined();
    const second = unwrap(
      await h.app.listChallenges.execute({
        actor: manager,
        limit: 4,
        status: 'active',
        cursor: first.nextCursor,
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const seen = new Set([...first.items, ...second.items].map((v) => v.challenge.id));
    expect(seen.size).toBe(5);
  });

  it('rejects a malformed cursor', async () => {
    const h = buildHarness();
    const result = await h.app.listChallenges.execute({
      actor: manager,
      limit: 5,
      cursor: 'garbage',
    });
    expect(errorOf(result)?.kind).toBe('validation');
  });
});

describe('starting and cancelling', () => {
  it('lets managers of the team and administrators start a draft', async () => {
    const h = buildHarness();
    const first = await h.create();
    const started = unwrap(
      await h.app.startChallenge.execute({ actor: manager, challengeId: first.challenge.id }),
    );
    expect(started.challenge.status).toBe('active');

    const second = await h.create();
    expect(
      unwrap(await h.app.startChallenge.execute({ actor: admin, challengeId: second.challenge.id }))
        .challenge.status,
    ).toBe('active');
  });

  it('refuses people who can see the challenge but do not manage it (403)', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    for (const action of ['startChallenge', 'cancelChallenge'] as const) {
      const result = await h.app[action].execute({
        actor: member(ALICE),
        challengeId: challenge.id,
      });
      expect(errorOf(result)?.code, action).toBe('challenge.not_manager');
    }
  });

  it('reports a wrong state as a conflict', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    const again = await h.app.startChallenge.execute({ actor: manager, challengeId: challenge.id });
    expect(errorOf(again)).toMatchObject({ kind: 'conflict', code: 'challenge.invalid_state' });
    unwrap(await h.app.cancelChallenge.execute({ actor: manager, challengeId: challenge.id }));
    const cancelled = await h.app.cancelChallenge.execute({
      actor: manager,
      challengeId: challenge.id,
    });
    expect(errorOf(cancelled)?.code).toBe('challenge.invalid_state');
  });

  it('detects a change made by someone else in between (conditional update)', async () => {
    const h = buildHarness();
    const { challenge } = await h.create();
    // Between the read and the write another request starts it: simulate by moving it first.
    const original = h.uow.store.challenges.get(challenge.id)!;
    const real = h.uow.store.challenges;
    const result = await h.uow.run(async (tx) => {
      const moved = unwrap(original.start(h.clock.now()));
      await tx.challenges.transition(moved, 'draft');
      return tx.challenges.transition(unwrap(original.cancel(h.clock.now())), 'draft');
    });
    expect(result).toBe(false);
    expect(real.get(challenge.id)?.status).toBe('active');
  });
});

describe('JoinChallenge', () => {
  it('joins a team member, announces ChallengeJoined once and is safe to repeat', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    const first = await h.join(challenge.id, ALICE);
    expect(first).toMatchObject({ joined: true, participantCount: 1 });
    await h.join(challenge.id, ALICE);
    await h.join(challenge.id, ALICE);

    const joined = h.eventsOf('ChallengeJoined');
    expect(joined).toHaveLength(1);
    expect(parseEvent(joined[0]).success).toBe(true);
    expect(joined[0]).toMatchObject({
      producer: 'challenge',
      payload: { challengeId: challenge.id, userId: ALICE, teamId: TEAM },
    });
  });

  it('refuses a manager of the team who is not a member of it (403) but lets a member manager join', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    const outsideManager = principal(uuid(0xe9), { role: 'manager', manages: [TEAM], teams: [] });
    expect(
      errorOf(
        await h.app.joinChallenge.execute({ actor: outsideManager, challengeId: challenge.id }),
      )?.code,
    ).toBe('challenge.team_not_member');
    expect(
      (await h.app.joinChallenge.execute({ actor: manager, challengeId: challenge.id })).ok,
    ).toBe(true);
  });

  it('refuses a draft (the team cannot even see it), a cancelled and a finished challenge', async () => {
    const h = buildHarness();
    const draft = await h.create();
    expect(
      errorOf(
        await h.app.joinChallenge.execute({
          actor: member(ALICE),
          challengeId: draft.challenge.id,
        }),
      )?.code,
    ).toBe('challenge.not_found');

    const cancelled = await h.createActive();
    unwrap(await h.app.cancelChallenge.execute({ actor: manager, challengeId: cancelled.id }));
    expect(
      errorOf(
        await h.app.joinChallenge.execute({ actor: member(ALICE), challengeId: cancelled.id }),
      ),
    ).toMatchObject({
      kind: 'conflict',
      code: 'challenge.not_joinable',
    });

    const ending = await h.createActive({ startsOn: '2026-11-18', endsOn: '2026-11-20' });
    h.clock.set('2026-11-21T09:00:00Z'); // last day passed, grace period not yet
    expect(
      errorOf(await h.app.joinChallenge.execute({ actor: member(BOB), challengeId: ending.id }))
        ?.code,
    ).toBe('challenge.not_joinable');
  });

  it('does not announce anything when joining fails', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.app.joinChallenge.execute({
      actor: principal(CAROL, { teams: [OTHER_TEAM] }),
      challengeId: challenge.id,
    });
    expect(h.eventsOf('ChallengeJoined')).toEqual([]);
  });
});

describe('leaderboard and progress access', () => {
  it('shows the standings to participants, managers of the team and administrators', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    for (const actor of [member(ALICE), manager, admin]) {
      const board = await h.app.getLeaderboard.execute({
        actor,
        challengeId: challenge.id,
        limit: 10,
      });
      expect(board.ok, actor.userId).toBe(true);
    }
  });

  it('tells another member that the challenge exists but not who is winning (403)', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    const board = await h.app.getLeaderboard.execute({
      actor: member(BOB),
      challengeId: challenge.id,
      limit: 10,
    });
    expect(errorOf(board)?.code).toBe('challenge.not_participant');
    const progress = await h.app.getMyProgress.execute({
      actor: member(BOB),
      challengeId: challenge.id,
    });
    expect(errorOf(progress)?.code).toBe('challenge.not_participant');
  });

  it('ranks participants, puts you in the list and tells you your own place beyond the page', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    for (const [i, userId] of [ALICE, BOB, CAROL].entries()) {
      await h.join(challenge.id, userId);
      for (let n = 0; n <= i; n += 1) await h.score(userId, { eventId: uuid(0x100 * (i + 1) + n) });
    }
    // Carol 3 points, Bob 2, Alice 1.
    const board = unwrap(
      await h.app.getLeaderboard.execute({
        actor: member(ALICE),
        challengeId: challenge.id,
        limit: 2,
      }),
    );
    expect(board.entries.map((e) => [e.userId, e.points, e.rank])).toEqual([
      [CAROL, 3, 1],
      [BOB, 2, 2],
    ]);
    expect(board.participantCount).toBe(3);
    expect(board.you).toMatchObject({ userId: ALICE, points: 1, rank: 3 });
  });

  it('a manager who does not take part sees the standings and has no place in them', async () => {
    const h = buildHarness();
    const challenge = await h.createActive();
    await h.join(challenge.id, ALICE);
    const board = unwrap(
      await h.app.getLeaderboard.execute({ actor: admin, challengeId: challenge.id, limit: 10 }),
    );
    expect(board.you).toBeNull();
    expect(board.entries).toHaveLength(1);
    expect(JSON.stringify(board)).not.toContain(ADMIN);
  });
});
