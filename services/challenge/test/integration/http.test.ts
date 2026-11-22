import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChallengeListResponse,
  ChallengeProgressResponse,
  ChallengeResponse,
  LeaderboardResponse,
} from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import type { UnitOfWork } from '../../src/application/index.js';
import { createE2E, type E2E, type TokenSpec } from '../support/e2e.js';
import { ADMIN, ALICE, BOB, CAROL, MANAGER, OTHER_TEAM, TEAM, uuid } from '../support/harness.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const manager: TokenSpec = { userId: MANAGER, role: 'manager', teams: [TEAM], manages: [TEAM] };
const alice: TokenSpec = { userId: ALICE, teams: [TEAM] };
const bob: TokenSpec = { userId: BOB, teams: [TEAM] };
const outsider: TokenSpec = { userId: CAROL, teams: [OTHER_TEAM] };
const admin: TokenSpec = { userId: ADMIN, role: 'admin' };

async function call(
  spec: TokenSpec | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  return e2e.request({
    method,
    path,
    ...(spec === undefined ? {} : { token: await e2e.token(spec) }),
    ...(body === undefined ? {} : { body }),
  });
}

const newChallenge = (overrides: Record<string, unknown> = {}) => ({
  name: 'Walk the world',
  activityType: 'walking',
  teamId: TEAM,
  startsOn: '2026-11-20',
  endsOn: '2026-11-30',
  badgeRules: [{ kind: 'total', threshold: 2 }],
  ...overrides,
});

/** Creates and starts a challenge as the manager; returns its id. */
async function startedChallenge(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await call(manager, 'POST', '/challenges', newChallenge(overrides));
  expect(created.statusCode).toBe(201);
  const { id } = created.json<ChallengeResponse>();
  expect((await call(manager, 'POST', `/challenges/${id}/start`)).statusCode).toBe(200);
  return id;
}

const score = async (userId: string, eventNumber: number, date = '2026-11-20') =>
  unwrap(
    await e2e.useCases.recordProgress.execute({
      sourceEventId: uuid(0x9000 + eventNumber),
      userId,
      activityType: 'walking',
      activityDate: date,
    }),
  );

describe('authentication', () => {
  it('needs a valid bearer token on every endpoint', async () => {
    const id = uuid(1);
    for (const [method, path] of [
      ['POST', '/challenges'],
      ['GET', '/challenges'],
      ['GET', `/challenges/${id}`],
      ['POST', `/challenges/${id}/start`],
      ['POST', `/challenges/${id}/cancel`],
      ['POST', `/challenges/${id}/join`],
      ['GET', `/challenges/${id}/leaderboard`],
      ['GET', `/challenges/${id}/progress`],
    ] as const) {
      const response = await call(undefined, method, path, method === 'POST' ? {} : undefined);
      expect(response.statusCode, `${method} ${path}`).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('auth.missing_token');
    }
  });

  it('rejects an expired token', async () => {
    const response = await e2e.request({
      method: 'GET',
      path: '/challenges',
      token: await e2e.token({ ...alice, expiresInSeconds: -60 }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('serves health probes without a token', async () => {
    expect((await e2e.probe('/healthz')).statusCode).toBe(200);
    expect((await e2e.probe('/readyz')).statusCode).toBe(200);
  });
});

describe('creating a challenge', () => {
  it('lets the team’s manager create a draft, with its badge rules', async () => {
    const response = await call(manager, 'POST', '/challenges', newChallenge());
    expect(response.statusCode).toBe(201);
    const body = response.json<ChallengeResponse>();
    expect(body).toMatchObject({
      name: 'Walk the world',
      activityType: 'walking',
      teamId: TEAM,
      status: 'draft',
      participantCount: 0,
      joined: false,
    });
    expect(body.badgeRules).toEqual([
      { id: expect.any(String) as string, kind: 'total', threshold: 2 },
    ]);
    expect(Object.keys(body).sort()).toEqual([
      'activityType',
      'badgeRules',
      'createdAt',
      'endsOn',
      'id',
      'joined',
      'name',
      'participantCount',
      'startsOn',
      'status',
      'teamId',
    ]);
  });

  it('refuses employees, and managers of other teams (403), and lets administrators in', async () => {
    for (const spec of [alice, { ...manager, manages: [OTHER_TEAM] }]) {
      const response = await call(spec, 'POST', '/challenges', newChallenge());
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('challenge.team_not_managed');
    }
    expect((await call(admin, 'POST', '/challenges', newChallenge())).statusCode).toBe(201);
  });

  it.each([
    ['an empty name', { name: ' ' }],
    ['an unknown activity type', { activityType: 'flying' }],
    ['a malformed team id', { teamId: 'team' }],
    ['reversed dates', { startsOn: '2026-12-01', endsOn: '2026-11-30' }],
    ['a challenge over a year long', { startsOn: '2026-11-20', endsOn: '2028-01-01' }],
    [
      'a repeated badge rule',
      {
        badgeRules: [
          { kind: 'total', threshold: 1 },
          { kind: 'total', threshold: 1 },
        ],
      },
    ],
    ['a badge threshold of zero', { badgeRules: [{ kind: 'total', threshold: 0 }] }],
    ['an unknown field', { createdBy: ALICE }],
  ])('rejects %s', async (_name, override) => {
    const response = await call(manager, 'POST', '/challenges', newChallenge(override));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
  });

  it('refuses a challenge that would already be over (400)', async () => {
    const response = await call(
      manager,
      'POST',
      '/challenges',
      newChallenge({ startsOn: '2026-11-01', endsOn: '2026-11-19' }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('challenge.in_the_past');
  });

  it('rate limits creation (429 with Retry-After)', async () => {
    let last = 0;
    for (let i = 0; i < 35 && last !== 429; i += 1) {
      const response = await call(manager, 'POST', '/challenges', newChallenge());
      last = response.statusCode;
      if (last === 429) expect(response.headers['retry-after']).toBeDefined();
    }
    expect(last).toBe(429);
  });
});

describe('seeing challenges (404, never 403, for what is not yours)', () => {
  it('hides a draft from the team and shows it to the manager', async () => {
    const created = await call(manager, 'POST', '/challenges', newChallenge());
    const { id } = created.json<ChallengeResponse>();
    expect((await call(alice, 'GET', `/challenges/${id}`)).statusCode).toBe(404);
    expect((await call(manager, 'GET', `/challenges/${id}`)).statusCode).toBe(200);
    expect((await call(alice, 'GET', '/challenges')).json<ChallengeListResponse>().items).toEqual(
      [],
    );
  });

  it('answers a hidden challenge exactly as a missing one', async () => {
    const id = await startedChallenge();
    const hidden = await call(outsider, 'GET', `/challenges/${id}`);
    const missing = await call(outsider, 'GET', `/challenges/${uuid(0x404)}`);
    expect(hidden.statusCode).toBe(404);
    const strip = (b: Record<string, unknown>) => {
      const { correlationId: _c, instance: _i, ...rest } = b;
      return rest;
    };
    expect(strip(hidden.json())).toEqual(strip(missing.json()));
    for (const action of ['start', 'cancel', 'join'] as const) {
      expect((await call(outsider, 'POST', `/challenges/${id}/${action}`)).statusCode, action).toBe(
        404,
      );
    }
    expect((await call(outsider, 'GET', `/challenges/${id}/leaderboard`)).statusCode).toBe(404);
    expect(
      (await call(outsider, 'GET', '/challenges')).json<ChallengeListResponse>().items,
    ).toEqual([]);
  });

  it('lists with the member count and whether you joined, pages with a cursor and filters by status', async () => {
    const first = await startedChallenge({ name: 'First' });
    e2e.clock.advanceMs(1000);
    await startedChallenge({ name: 'Second' });
    e2e.clock.advanceMs(1000);
    await call(manager, 'POST', '/challenges', newChallenge({ name: 'Draft' }));
    await call(alice, 'POST', `/challenges/${first}/join`);

    const all = (await call(manager, 'GET', '/challenges')).json<ChallengeListResponse>();
    expect(all.items.map((c) => c.name)).toEqual(['Draft', 'Second', 'First']);
    const mine = (await call(alice, 'GET', '/challenges')).json<ChallengeListResponse>();
    expect(mine.items.map((c) => [c.name, c.joined, c.participantCount])).toEqual([
      ['Second', false, 0],
      ['First', true, 1],
    ]);

    const page1 = (await call(manager, 'GET', '/challenges?limit=2')).json<ChallengeListResponse>();
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await call(manager, 'GET', `/challenges?limit=2&cursor=${page1.nextCursor}`)
    ).json<ChallengeListResponse>();
    expect(page2.items.map((c) => c.name)).toEqual(['First']);
    expect(page2.nextCursor).toBeUndefined();

    const drafts = (
      await call(manager, 'GET', '/challenges?status=draft')
    ).json<ChallengeListResponse>();
    expect(drafts.items.map((c) => c.name)).toEqual(['Draft']);
  });

  it('rejects a bad status, a bad limit, a bad cursor and a malformed id', async () => {
    expect((await call(alice, 'GET', '/challenges?status=paused')).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/challenges?limit=0')).statusCode).toBe(400);
    expect(
      (await call(alice, 'GET', '/challenges?cursor=garbage')).json<{ code: string }>().code,
    ).toBe('cursor.invalid');
    expect((await call(alice, 'GET', '/challenges/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('managing and joining', () => {
  it('lets only managers start and cancel; members get 403, wrong states 409', async () => {
    const created = await call(manager, 'POST', '/challenges', newChallenge());
    const { id } = created.json<ChallengeResponse>();

    const started = await call(manager, 'POST', `/challenges/${id}/start`);
    expect(started.json<ChallengeResponse>().status).toBe('active');
    expect((await call(alice, 'POST', `/challenges/${id}/cancel`)).statusCode).toBe(403);
    const again = await call(manager, 'POST', `/challenges/${id}/start`);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('challenge.invalid_state');

    expect(
      (await call(admin, 'POST', `/challenges/${id}/cancel`)).json<ChallengeResponse>().status,
    ).toBe('cancelled');
    expect((await call(alice, 'POST', `/challenges/${id}/join`)).statusCode).toBe(409);
  });

  it('joins once, announces ChallengeJoined in the outbox once, and refuses a non-member', async () => {
    const id = await startedChallenge();
    const first = await call(alice, 'POST', `/challenges/${id}/join`);
    expect(first.statusCode).toBe(200);
    expect(first.json<ChallengeResponse>()).toMatchObject({ joined: true, participantCount: 1 });
    await call(alice, 'POST', `/challenges/${id}/join`);

    const joined = (await e2e.readOutbox()).filter((e) => e.eventType === 'ChallengeJoined');
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ payload: { challengeId: id, userId: ALICE, teamId: TEAM } });
  });
});

describe('scoring, leaderboard and progress', () => {
  it('shows standings to participants only, with your own place, and refuses other members', async () => {
    const id = await startedChallenge();
    await call(alice, 'POST', `/challenges/${id}/join`);
    await call(bob, 'POST', `/challenges/${id}/join`);
    await score(ALICE, 1);
    await score(ALICE, 2, '2026-11-21');
    await score(BOB, 3);

    const board = (
      await call(bob, 'GET', `/challenges/${id}/leaderboard`)
    ).json<LeaderboardResponse>();
    expect(board).toMatchObject({
      status: 'active',
      participantCount: 2,
      entries: [
        { rank: 1, userId: ALICE, points: 2, isYou: false },
        { rank: 2, userId: BOB, points: 1, isYou: true },
      ],
      you: { rank: 2, points: 1 },
    });

    const other: TokenSpec = { userId: CAROL, teams: [TEAM] };
    const refused = await call(other, 'GET', `/challenges/${id}/leaderboard`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('challenge.not_participant');
    expect((await call(manager, 'GET', `/challenges/${id}/leaderboard`)).statusCode).toBe(200);
    expect(
      (
        await call(admin, 'GET', `/challenges/${id}/leaderboard?limit=1`)
      ).json<LeaderboardResponse>().entries,
    ).toHaveLength(1);
  });

  it('shows your own points, streak and the badges you earned', async () => {
    const id = await startedChallenge({
      badgeRules: [
        { kind: 'total', threshold: 2 },
        { kind: 'streak', threshold: 5 },
      ],
    });
    await call(alice, 'POST', `/challenges/${id}/join`);
    await score(ALICE, 1);
    await score(ALICE, 2, '2026-11-21');

    const progress = (
      await call(alice, 'GET', `/challenges/${id}/progress`)
    ).json<ChallengeProgressResponse>();
    expect(progress).toMatchObject({
      challengeId: id,
      points: 2,
      activeDays: 2,
      longestStreak: 2,
      badges: [{ kind: 'total', threshold: 2, awardedOn: '2026-11-20' }],
    });
    expect((await call(bob, 'GET', `/challenges/${id}/progress`)).statusCode).toBe(403);
  });

  it('publishes progress and badge events with the score, in the same transaction', async () => {
    const id = await startedChallenge({ badgeRules: [{ kind: 'total', threshold: 1 }] });
    await call(alice, 'POST', `/challenges/${id}/join`);
    await score(ALICE, 1);
    await score(ALICE, 1); // redelivered

    const types = (await e2e.readOutbox()).map((e) => e.eventType);
    expect(types.filter((t) => t === 'ChallengeProgressUpdated')).toHaveLength(1);
    expect(types.filter((t) => t === 'BadgeAwarded')).toHaveLength(1);
  });

  it('completes on the calendar, announces ChallengeCompleted once and keeps the standings readable', async () => {
    const id = await startedChallenge({ startsOn: '2026-11-20', endsOn: '2026-11-21' });
    await call(alice, 'POST', `/challenges/${id}/join`);
    await score(ALICE, 1);

    e2e.clock.set('2026-11-23T00:00:30Z');
    expect(unwrap(await e2e.useCases.advanceChallenges.execute())).toEqual({
      started: 0,
      completed: 1,
    });
    expect(unwrap(await e2e.useCases.advanceChallenges.execute())).toEqual({
      started: 0,
      completed: 0,
    });

    const completed = (await e2e.readOutbox()).filter((e) => e.eventType === 'ChallengeCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ payload: { challengeId: id, completedOn: '2026-11-21' } });

    e2e.clock.set('2026-11-23T01:00:00Z');
    const board = (
      await call(alice, 'GET', `/challenges/${id}/leaderboard`)
    ).json<LeaderboardResponse>();
    expect(board).toMatchObject({ status: 'completed', entries: [{ userId: ALICE, points: 1 }] });
  });
});

describe('failure behaviour', () => {
  it('a database outage is a 503 with Retry-After, not a 500', async () => {
    const failing: UnitOfWork = {
      run: () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    };
    const down = await createE2E({ uow: failing });
    try {
      await down.start();
      const response = await down.request({
        method: 'GET',
        path: '/challenges',
        token: await down.token(alice),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.body).not.toContain('ECONNREFUSED');
    } finally {
      await down.stop();
    }
  });

  it('logs without raw user ids or tokens', async () => {
    const id = await startedChallenge();
    const token = await e2e.token(alice);
    await e2e.request({ method: 'POST', path: `/challenges/${id}/join`, token });
    const logs = e2e.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(ALICE);
    expect(logs).not.toContain(MANAGER);
    expect(logs).not.toContain(token);
  });
});
