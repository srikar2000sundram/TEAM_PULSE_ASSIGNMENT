import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap } from '@teampulse/kernel';
import type { UnitOfWork } from '../../src/application/index.js';
import { createE2E, type E2E, type TokenSpec } from '../support/e2e.js';
import { ALICE, BOB, DATA, HABIT, OTHER_HABIT, PLATFORM, TODAY, uuid } from '../support/harness.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const alice: TokenSpec = { userId: ALICE, teams: [PLATFORM, DATA] };
const bob: TokenSpec = { userId: BOB, teams: [PLATFORM] };

interface ActivityBody {
  id: string;
  habitId: string;
  activityType: string;
  activityDate: string;
  createdAt: string;
  alreadyRecorded: boolean;
}

/** Tells the service about a habit, as the Habit Service's event would. */
async function knowHabit(owner: string, habitId = HABIT, type: 'walking' | 'yoga' = 'walking') {
  unwrap(
    await e2e.useCases.applyHabitSnapshot.execute({
      habitId,
      ownerUserId: owner,
      activityType: type,
      occurredAt: new Date('2026-11-01T08:00:00Z'),
    }),
  );
}

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

const record = (spec: TokenSpec, body: Record<string, unknown> = {}) =>
  call(spec, 'POST', '/activities', { habitId: HABIT, activityDate: TODAY, ...body });

describe('authentication', () => {
  it('needs a valid bearer token', async () => {
    const missing = await call(undefined, 'POST', '/activities', {
      habitId: HABIT,
      activityDate: TODAY,
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json<{ code: string }>().code).toBe('auth.missing_token');
    const expired = await e2e.request({
      method: 'GET',
      path: '/activities',
      token: await e2e.token({ ...alice, expiresInSeconds: -60 }),
    });
    expect(expired.statusCode).toBe(401);
  });

  it('serves health probes without a token', async () => {
    expect((await e2e.probe('/healthz')).statusCode).toBe(200);
    expect((await e2e.probe('/readyz')).statusCode).toBe(200);
  });
});

describe('recording an activity', () => {
  it('records it and returns 201 with the activity', async () => {
    await knowHabit(ALICE, HABIT, 'yoga');
    const response = await record(alice);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ActivityBody>()).toMatchObject({
      habitId: HABIT,
      activityType: 'yoga',
      activityDate: TODAY,
      alreadyRecorded: false,
    });
  });

  it('never exposes the user id or the team snapshot in the response', async () => {
    await knowHabit(ALICE);
    const response = await record(alice);
    expect(response.body).not.toContain(ALICE);
    expect(response.body).not.toContain(PLATFORM);
    expect(Object.keys(response.json<object>()).sort()).toEqual([
      'activityDate',
      'activityType',
      'alreadyRecorded',
      'createdAt',
      'habitId',
      'id',
    ]);
  });

  it('publishes ActivityCompleted to the outbox in the same transaction', async () => {
    await knowHabit(ALICE);
    await record(alice);
    const events = await e2e.readOutbox();
    expect(events).toHaveLength(1);
    expect(parseEvent(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({
      eventType: 'ActivityCompleted',
      payload: {
        userId: ALICE,
        habitId: HABIT,
        teamIds: [PLATFORM, DATA],
        activityType: 'walking',
        activityDate: TODAY,
      },
    });
  });

  it('is safe to retry: the same request returns the same activity, flagged, with no second event', async () => {
    await knowHabit(ALICE);
    const first = (await record(alice)).json<ActivityBody>();
    const retry = await record(alice);
    expect(retry.statusCode).toBe(201);
    expect(retry.json<ActivityBody>()).toMatchObject({ id: first.id, alreadyRecorded: true });
    expect(await e2e.readOutbox()).toHaveLength(1);
  });

  it('handles simultaneous duplicate requests: exactly one activity and one event', async () => {
    await knowHabit(ALICE);
    const token = await e2e.token(alice);
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() =>
        e2e.request({
          method: 'POST',
          path: '/activities',
          token,
          body: { habitId: HABIT, activityDate: TODAY },
        }),
      ),
    );
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(responses.filter((r) => !r.json<ActivityBody>().alreadyRecorded)).toHaveLength(1);
    expect(await e2e.readOutbox()).toHaveLength(1);
  });

  it('ignores any client-supplied user, type or teams (the body is strict)', async () => {
    await knowHabit(ALICE);
    for (const extra of [{ userId: BOB }, { activityType: 'running' }, { teamIds: [PLATFORM] }]) {
      expect((await record(alice, extra)).statusCode).toBe(400);
    }
  });

  it('validates the input with problem details', async () => {
    await knowHabit(ALICE);
    const bad = await call(alice, 'POST', '/activities', {
      habitId: 'nope',
      activityDate: '2026-02-30',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    const fields = bad.json<{ errors: { field: string }[] }>().errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['body.habitId', 'body.activityDate']));
  });

  it('rejects dates outside the window with a specific code', async () => {
    await knowHabit(ALICE);
    const future = await record(alice, { activityDate: '2026-12-25' });
    expect(future.statusCode).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('activity.date_in_future');
    const old = await record(alice, { activityDate: '2026-10-01' });
    expect(old.json<{ code: string }>().code).toBe('activity.date_too_old');
  });

  it('someone else’s habit and an unknown habit give the same 404', async () => {
    await knowHabit(ALICE);
    const theirs = await record(bob);
    const unknown = await record(bob, { habitId: uuid(0x999) });
    expect(theirs.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const strip = (b: Record<string, unknown>) => {
      const { correlationId: _c, instance: _i, ...rest } = b;
      return rest;
    };
    expect(strip(theirs.json())).toEqual(strip(unknown.json()));
    expect(await e2e.readOutbox()).toHaveLength(0);
  });

  it('refuses an archived habit with 409', async () => {
    await knowHabit(ALICE);
    unwrap(
      await e2e.useCases.applyHabitArchived.execute({
        habitId: HABIT,
        ownerUserId: ALICE,
        occurredAt: new Date('2026-11-10T08:00:00Z'),
      }),
    );
    const response = await record(alice);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('habit.archived');
  });

  it('rejects non-JSON bodies with 415', async () => {
    const response = await e2e.request({
      method: 'POST',
      path: '/activities',
      token: await e2e.token(alice),
      headers: { 'content-type': 'text/plain' },
      body: '{"habitId":"x","activityDate":"2026-11-20"}',
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('listing activities', () => {
  async function seed() {
    await knowHabit(ALICE, HABIT);
    await knowHabit(ALICE, OTHER_HABIT, 'yoga');
    await knowHabit(BOB, uuid(0x53));
    for (const date of ['2026-11-18', '2026-11-19', '2026-11-20']) {
      await record(alice, { activityDate: date });
      e2e.clock.advanceMs(1000);
    }
    await record(alice, { habitId: OTHER_HABIT });
    await record(bob, { habitId: uuid(0x53) });
  }

  it('returns only the caller’s activities', async () => {
    await seed();
    const mine = (await call(alice, 'GET', '/activities')).json<{ items: ActivityBody[] }>();
    expect(mine.items).toHaveLength(4);
    const theirs = (await call(bob, 'GET', '/activities')).json<{ items: ActivityBody[] }>();
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]?.habitId).toBe(uuid(0x53));
  });

  it('filters by date range and habit', async () => {
    await seed();
    const ranged = await call(alice, 'GET', '/activities?from=2026-11-19&to=2026-11-19');
    expect(ranged.json<{ items: ActivityBody[] }>().items.map((a) => a.activityDate)).toEqual([
      '2026-11-19',
    ]);
    const byHabit = await call(alice, 'GET', `/activities?habitId=${OTHER_HABIT}`);
    expect(byHabit.json<{ items: ActivityBody[] }>().items).toHaveLength(1);
  });

  it('pages with an opaque cursor until the last page has none', async () => {
    await seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await call(
        alice,
        'GET',
        `/activities?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const page = response.json<{ items: ActivityBody[]; nextCursor?: string }>();
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(4);
  });

  it('rejects an inverted range, a bad limit and a bad cursor', async () => {
    expect((await call(alice, 'GET', '/activities?from=2026-11-20&to=2026-11-01')).statusCode).toBe(
      400,
    );
    expect((await call(alice, 'GET', '/activities?limit=0')).statusCode).toBe(400);
    const bad = await call(alice, 'GET', '/activities?cursor=garbage');
    expect(bad.json<{ code: string }>().code).toBe('cursor.invalid');
  });
});

describe('privacy in logs', () => {
  it('logs without raw user ids or tokens', async () => {
    await knowHabit(ALICE);
    const token = await e2e.token(alice);
    await e2e.request({
      method: 'POST',
      path: '/activities',
      token,
      body: { habitId: HABIT, activityDate: TODAY },
    });
    const logs = e2e.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(ALICE);
    expect(logs).not.toContain(token);
  });
});

describe('failure behaviour', () => {
  it('rate limits a client that records too fast (429 with Retry-After)', async () => {
    await knowHabit(ALICE);
    let last = 0;
    for (let i = 0; i < 130 && last !== 429; i += 1) {
      const response = await record(alice);
      last = response.statusCode;
      if (last === 429) expect(response.headers['retry-after']).toBeDefined();
    }
    expect(last).toBe(429);
  });

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
        path: '/activities',
        token: await down.token(alice),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.body).not.toContain('ECONNREFUSED');
    } finally {
      await down.stop();
    }
  });
});
