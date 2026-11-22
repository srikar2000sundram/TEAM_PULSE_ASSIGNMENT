import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import type { UnitOfWork } from '../../src/application/index.js';
import { ALICE, BOB, CAROL, DATA, DAVE, PLATFORM, REMINDER, uuid } from '../support/harness.js';
import { createE2E, type E2E, type TokenSpec } from '../support/e2e.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const alice: TokenSpec = { userId: ALICE, teams: [PLATFORM] };
const bob: TokenSpec = { userId: BOB, teams: [PLATFORM] };
const carol: TokenSpec = { userId: CAROL, teams: [DATA] };

interface HabitBody {
  id: string;
  ownerUserId: string;
  isOwner: boolean;
  title: string;
  visibility: string;
  teamId?: string;
  archivedAt?: string;
  reminder?: unknown;
  description?: string;
}

async function call(
  spec: TokenSpec | undefined,
  method: 'GET' | 'POST' | 'PATCH',
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

async function createHabit(spec: TokenSpec, body: Record<string, unknown> = {}) {
  const response = await call(spec, 'POST', '/habits', {
    title: 'Morning walk',
    activityType: 'walking',
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<HabitBody>();
}

describe('authentication', () => {
  it('rejects a missing token', async () => {
    const response = await call(undefined, 'GET', '/habits');
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('auth.missing_token');
  });

  it('rejects garbage, expired and wrong-audience tokens', async () => {
    const garbage = await e2e.request({ method: 'GET', path: '/habits', token: 'not-a-jwt' });
    expect(garbage.statusCode).toBe(401);

    const expired = await e2e.request({
      method: 'GET',
      path: '/habits',
      token: await e2e.token({ ...alice, expiresInSeconds: -60 }),
    });
    expect(expired.statusCode).toBe(401);

    const wrongAudience = await e2e.request({
      method: 'GET',
      path: '/habits',
      token: await e2e.token({ ...alice, audience: 'someone-else' }),
    });
    expect(wrongAudience.statusCode).toBe(401);
  });

  it('serves health probes without a token', async () => {
    expect((await e2e.probe('/healthz')).statusCode).toBe(200);
    expect((await e2e.probe('/readyz')).statusCode).toBe(200);
  });
});

describe('creating habits', () => {
  it('creates a private habit by default and returns the full habit', async () => {
    const habit = await createHabit(alice, {
      description: 'after lunch',
      reminder: REMINDER,
    });
    expect(habit).toMatchObject({
      ownerUserId: ALICE,
      isOwner: true,
      title: 'Morning walk',
      description: 'after lunch',
      visibility: 'private',
      reminder: { daysOfWeek: ['mon', 'wed'], remindAt: '07:30', timeZone: 'Europe/Berlin' },
    });
    expect(habit).not.toHaveProperty('teamId');
    expect(habit).not.toHaveProperty('archivedAt');
  });

  it('takes the owner from the token, never from the request body', async () => {
    const response = await call(alice, 'POST', '/habits', {
      title: 'Sneaky',
      activityType: 'yoga',
      ownerUserId: BOB,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns RFC 9457 problem details listing each invalid field', async () => {
    const response = await call(alice, 'POST', '/habits', {
      title: '',
      activityType: 'skydiving',
      visibility: 'team',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json<{
      code: string;
      errors: { field: string }[];
      correlationId: string;
    }>();
    expect(problem.code).toBe('request.invalid');
    expect(problem.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['body.title', 'body.activityType']),
    );
    expect(problem.correlationId).toBe(response.headers['x-correlation-id']);
  });

  it('requires a team for team visibility', async () => {
    const response = await call(alice, 'POST', '/habits', {
      title: 'Run',
      activityType: 'running',
      visibility: 'team',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('body.teamId');
  });

  it('refuses to share with a team the caller is not in (403)', async () => {
    const response = await call(alice, 'POST', '/habits', {
      title: 'Run',
      activityType: 'running',
      visibility: 'team',
      teamId: DATA,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('habit.team_not_member');
  });

  it('rejects non-JSON bodies with 415 (closes the cross-site form route)', async () => {
    const response = await e2e.request({
      method: 'POST',
      path: '/habits',
      token: await e2e.token(alice),
      headers: { 'content-type': 'text/plain' },
      body: '{"title":"x","activityType":"yoga"}',
    });
    expect(response.statusCode).toBe(415);
  });

  it('writes HabitCreated to the outbox in the same transaction, with no free text', async () => {
    const habit = await createHabit(alice, {
      title: 'Confidential title',
      description: 'confidential notes',
      reminder: REMINDER,
    });
    const events = await e2e.readOutbox();
    expect(events).toHaveLength(1);
    expect(parseEvent(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({
      eventType: 'HabitCreated',
      payload: { habitId: habit.id, ownerUserId: ALICE, visibility: 'private' },
    });
    expect(JSON.stringify(events)).not.toContain('Confidential');
    expect(JSON.stringify(events)).not.toContain('confidential');
  });
});

describe('who can see which habit', () => {
  it('the owner reads their private habit; anyone else gets 404, identical to a missing habit', async () => {
    const habit = await createHabit(alice, { title: 'Private one' });
    expect((await call(alice, 'GET', `/habits/${habit.id}`)).statusCode).toBe(200);

    const hidden = await call(bob, 'GET', `/habits/${habit.id}`);
    const missing = await call(bob, 'GET', `/habits/${uuid(0x999)}`);
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    const strip = (body: Record<string, unknown>) => {
      const { correlationId: _c, instance: _i, ...rest } = body;
      return rest;
    };
    expect(strip(hidden.json())).toEqual(strip(missing.json()));
    expect(hidden.body).not.toContain('Private one');
  });

  it('teammates see a shared habit, marked as not theirs', async () => {
    const habit = await createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const response = await call(bob, 'GET', `/habits/${habit.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<HabitBody>()).toMatchObject({
      id: habit.id,
      isOwner: false,
      teamId: PLATFORM,
    });
  });

  it('people in other teams get 404 for a team habit', async () => {
    const habit = await createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    expect((await call(carol, 'GET', `/habits/${habit.id}`)).statusCode).toBe(404);
  });

  it('managers and admins have no special access to individual habits', async () => {
    const priv = await createHabit(alice, { title: 'Private' });
    const shared = await createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const manager: TokenSpec = { userId: DAVE, role: 'manager', manages: [PLATFORM] };
    const admin: TokenSpec = { userId: uuid(0xad), role: 'admin' };

    for (const spec of [manager, admin]) {
      for (const habit of [priv, shared]) {
        expect((await call(spec, 'GET', `/habits/${habit.id}`)).statusCode).toBe(404);
      }
      const list = await call(spec, 'GET', '/habits?scope=team');
      expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    }
  });

  it('rejects a malformed habit id before touching the database', async () => {
    expect((await call(alice, 'GET', '/habits/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('listing', () => {
  it('lists mine and the team feed separately', async () => {
    const mine = await createHabit(alice, { title: 'Mine', visibility: 'team', teamId: PLATFORM });
    await createHabit(alice, { title: 'Private' });
    const theirs = await createHabit(bob, { title: 'Bobs', visibility: 'team', teamId: PLATFORM });
    await createHabit(carol, { title: 'Other team', visibility: 'team', teamId: DATA });

    const own = await call(alice, 'GET', '/habits');
    expect(
      own
        .json<{ items: HabitBody[] }>()
        .items.map((h) => h.title)
        .sort(),
    ).toEqual(['Mine', 'Private']);

    const feed = await call(alice, 'GET', '/habits?scope=team');
    expect(feed.json<{ items: HabitBody[] }>().items.map((h) => h.id)).toEqual([theirs.id]);
    expect(mine.id).toBeDefined();
  });

  it('pages with an opaque cursor until the last page has none', async () => {
    for (let i = 0; i < 5; i += 1) await createHabit(alice, { title: `H${i}` });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await call(
        alice,
        'GET',
        `/habits?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<{ items: HabitBody[]; nextCursor?: string }>();
      seen.push(...page.items.map((h) => h.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects impossible query combinations and bad cursors', async () => {
    expect((await call(alice, 'GET', '/habits?scope=team&status=archived')).statusCode).toBe(400);
    expect((await call(alice, 'GET', `/habits?teamId=${PLATFORM}`)).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/habits?limit=1000')).statusCode).toBe(400);
    const bad = await call(alice, 'GET', '/habits?cursor=garbage');
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ code: string }>().code).toBe('cursor.invalid');
  });
});

describe('changing and archiving', () => {
  it('the owner edits a habit; sharing changes are published, renames are not', async () => {
    const habit = await createHabit(alice);
    await e2e.db.exec('TRUNCATE outbox');

    const rename = await call(alice, 'PATCH', `/habits/${habit.id}`, { title: 'Evening walk' });
    expect(rename.statusCode).toBe(200);
    expect(rename.json<HabitBody>().title).toBe('Evening walk');
    expect(await e2e.readOutbox()).toHaveLength(0);

    const share = await call(alice, 'PATCH', `/habits/${habit.id}`, {
      visibility: 'team',
      teamId: PLATFORM,
    });
    expect(share.json<HabitBody>()).toMatchObject({ visibility: 'team', teamId: PLATFORM });
    const events = await e2e.readOutbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'HabitUpdated' });
  });

  it('null clears the description and reminder', async () => {
    const habit = await createHabit(alice, { description: 'x', reminder: REMINDER });
    const response = await call(alice, 'PATCH', `/habits/${habit.id}`, {
      description: null,
      reminder: null,
    });
    const body = response.json<HabitBody>();
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('reminder');
  });

  it('rejects an empty update and an ambiguous sharing change', async () => {
    const habit = await createHabit(alice);
    expect((await call(alice, 'PATCH', `/habits/${habit.id}`, {})).statusCode).toBe(400);
    expect(
      (await call(alice, 'PATCH', `/habits/${habit.id}`, { visibility: 'team' })).statusCode,
    ).toBe(400);
  });

  it('a teammate gets 403 on a shared habit, a stranger gets 404 on a private one', async () => {
    const shared = await createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const priv = await createHabit(alice, { title: 'Private' });

    const teammate = await call(bob, 'PATCH', `/habits/${shared.id}`, { title: 'Mine now' });
    expect(teammate.statusCode).toBe(403);
    expect(teammate.json<{ code: string }>().code).toBe('habit.not_owner');

    expect((await call(bob, 'PATCH', `/habits/${priv.id}`, { title: 'x' })).statusCode).toBe(404);
    expect((await call(bob, 'POST', `/habits/${priv.id}/archive`)).statusCode).toBe(404);
    expect((await call(bob, 'POST', `/habits/${shared.id}/archive`)).statusCode).toBe(403);
  });

  it('archiving hides the habit from teammates, keeps it for the owner, and is idempotent', async () => {
    const habit = await createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    await e2e.db.exec('TRUNCATE outbox');

    const first = await call(alice, 'POST', `/habits/${habit.id}/archive`);
    expect(first.statusCode).toBe(200);
    expect(first.json<HabitBody>().archivedAt).toBeDefined();
    const again = await call(alice, 'POST', `/habits/${habit.id}/archive`);
    expect(again.statusCode).toBe(200);
    expect(again.json<HabitBody>().archivedAt).toBe(first.json<HabitBody>().archivedAt);
    expect(await e2e.readOutbox()).toHaveLength(1);

    expect((await call(bob, 'GET', `/habits/${habit.id}`)).statusCode).toBe(404);
    expect((await call(alice, 'GET', `/habits/${habit.id}`)).statusCode).toBe(200);
    const archived = await call(alice, 'GET', '/habits?status=archived');
    expect(archived.json<{ items: HabitBody[] }>().items.map((h) => h.id)).toEqual([habit.id]);

    const edit = await call(alice, 'PATCH', `/habits/${habit.id}`, { title: 'Nope' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json<{ code: string }>().code).toBe('habit.archived');
  });
});

describe('privacy in logs and responses', () => {
  it('logs requests without titles, notes, tokens or raw user ids', async () => {
    const token = await e2e.token(alice);
    const habit = await createHabit(alice, { title: 'Titlemarker', description: 'Notesmarker' });
    await e2e.request({ method: 'GET', path: `/habits/${habit.id}`, token });
    await call(bob, 'GET', `/habits/${habit.id}`);

    const logs = e2e.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain('Titlemarker');
    expect(logs).not.toContain('Notesmarker');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(ALICE);
  });

  it('never leaks internals in an error body', async () => {
    const response = await call(alice, 'GET', `/habits/${uuid(0x999)}`);
    expect(response.body).not.toMatch(/SELECT|habits_|stack|node_modules/i);
  });
});

describe('failure behaviour', () => {
  it('answers 404 for unknown routes with problem details', async () => {
    const response = await call(alice, 'GET', '/nothing-here');
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('route.not_found');
  });

  it('rate limits a client that creates habits too fast (429 with Retry-After)', async () => {
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i += 1) {
      const response = await call(alice, 'POST', '/habits', {
        title: `H${i}`,
        activityType: 'yoga',
      });
      last = response.statusCode;
      if (last === 429) expect(response.headers['retry-after']).toBeDefined();
    }
    expect(last).toBe(429);
  });
});

describe('a database outage', () => {
  it('is a 503 with Retry-After, not a 500', async () => {
    const failing: UnitOfWork = {
      run: () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    };
    const down = await createE2E({ uow: failing });
    try {
      await down.start();
      const response = await down.request({
        method: 'GET',
        path: '/habits',
        token: await down.token(alice),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.json<{ code: string }>().code).toBe('service.unavailable');
      expect(response.body).not.toContain('ECONNREFUSED');
    } finally {
      await down.stop();
    }
  });
});
