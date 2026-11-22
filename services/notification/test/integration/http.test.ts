import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '@teampulse/kernel';
import type { UnitOfWork } from '../../src/application/index.js';
import { createE2E, type E2E, type TokenSpec } from '../support/e2e.js';
import { ALICE, BOB, uuid } from '../support/harness.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const alice: TokenSpec = { userId: ALICE };
const bob: TokenSpec = { userId: BOB };

interface NotificationBody {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
interface ListBody {
  items: NotificationBody[];
  unreadCount: number;
  nextCursor?: string;
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

/** Creates a notification as an event handler would. */
async function notify(userId: string, source: number, threshold = 7) {
  unwrap(
    await e2e.useCases.notifyUser.execute({
      userId,
      sourceId: uuid(0x7000 + source),
      content: { kind: 'milestone', milestoneKind: 'streak', threshold },
    }),
  );
  e2e.clock.advanceMs(1000);
}

describe('authentication', () => {
  it('needs a valid bearer token on every endpoint', async () => {
    for (const [method, path] of [
      ['GET', '/notifications'],
      ['POST', `/notifications/${uuid(1)}/read`],
      ['GET', '/preferences'],
      ['PATCH', '/preferences'],
    ] as const) {
      const response = await call(
        undefined,
        method,
        path,
        method === 'PATCH' ? { badges: false } : undefined,
      );
      expect(response.statusCode, `${method} ${path}`).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('auth.missing_token');
    }
  });

  it('rejects an expired token', async () => {
    const response = await e2e.request({
      method: 'GET',
      path: '/notifications',
      token: await e2e.token({ ...alice, expiresInSeconds: -60 }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('serves health probes without a token', async () => {
    expect((await e2e.probe('/healthz')).statusCode).toBe(200);
    expect((await e2e.probe('/readyz')).statusCode).toBe(200);
  });
});

describe('listing and reading notifications', () => {
  it('lists my notifications with rendered text and the unread count', async () => {
    await notify(ALICE, 1, 7);
    await notify(ALICE, 2, 30);
    await notify(BOB, 3);

    const response = await call(alice, 'GET', '/notifications');
    expect(response.statusCode).toBe(200);
    const body = response.json<ListBody>();
    expect(body.unreadCount).toBe(2);
    expect(body.items.map((n) => n.body)).toEqual([
      expect.stringContaining('30 days in a row'),
      expect.stringContaining('7 days in a row'),
    ]);
    expect(body.items[0]).toMatchObject({ kind: 'milestone', title: 'Streak milestone' });
    expect(body.items[0]).not.toHaveProperty('readAt');
  });

  it('never shows another person’s notifications or exposes ids and sources', async () => {
    await notify(BOB, 1);
    const response = await call(alice, 'GET', '/notifications');
    expect(response.json<ListBody>().items).toEqual([]);
    const bobs = await call(bob, 'GET', '/notifications');
    expect(Object.keys(bobs.json<ListBody>().items[0]!).sort()).toEqual([
      'body',
      'createdAt',
      'id',
      'kind',
      'title',
    ]);
    expect(bobs.body).not.toContain(BOB);
  });

  it('marks one as read, which shows in the list and lowers the unread count', async () => {
    await notify(ALICE, 1);
    await notify(ALICE, 2);
    const [newest] = (await call(alice, 'GET', '/notifications')).json<ListBody>().items;

    const read = await call(alice, 'POST', `/notifications/${newest!.id}/read`);
    expect(read.statusCode).toBe(200);
    expect(read.json<NotificationBody>().readAt).toBeDefined();

    const unread = await call(alice, 'GET', '/notifications?unread=true');
    expect(unread.json<ListBody>().items).toHaveLength(1);
    expect(unread.json<ListBody>().unreadCount).toBe(1);

    // Reading again is harmless and keeps the first time.
    const again = await call(alice, 'POST', `/notifications/${newest!.id}/read`);
    expect(again.json<NotificationBody>().readAt).toBe(read.json<NotificationBody>().readAt);
  });

  it('someone else’s notification and a missing one give the same 404', async () => {
    await notify(BOB, 1);
    const [bobs] = (await call(bob, 'GET', '/notifications')).json<ListBody>().items;
    const theirs = await call(alice, 'POST', `/notifications/${bobs!.id}/read`);
    const missing = await call(alice, 'POST', `/notifications/${uuid(0x999)}/read`);
    expect(theirs.statusCode).toBe(404);
    const strip = (b: Record<string, unknown>) => {
      const { correlationId: _c, instance: _i, ...rest } = b;
      return rest;
    };
    expect(strip(theirs.json())).toEqual(strip(missing.json()));
    expect((await call(bob, 'GET', '/notifications')).json<ListBody>().unreadCount).toBe(1);
  });

  it('pages with an opaque cursor until the last page has none', async () => {
    for (let i = 1; i <= 5; i += 1) await notify(ALICE, i);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = (
        await call(alice, 'GET', `/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      ).json<ListBody>();
      expect(page.unreadCount).toBe(5);
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed id, a bad limit, a bad flag and a bad cursor', async () => {
    expect((await call(alice, 'POST', '/notifications/not-a-uuid/read')).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/notifications?limit=0')).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/notifications?unread=maybe')).statusCode).toBe(400);
    const bad = await call(alice, 'GET', '/notifications?cursor=garbage');
    expect(bad.json<{ code: string }>().code).toBe('cursor.invalid');
  });
});

describe('preferences', () => {
  it('start with everything on', async () => {
    const response = await call(alice, 'GET', '/preferences');
    expect(response.json()).toEqual({
      milestones: true,
      badges: true,
      challenges: true,
      reminders: true,
    });
  });

  it('change only what is sent, per person, and decide what is delivered', async () => {
    const changed = await call(alice, 'PATCH', '/preferences', { milestones: false });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ milestones: false, badges: true });
    expect((await call(bob, 'GET', '/preferences')).json()).toMatchObject({ milestones: true });

    await notify(ALICE, 1); // a milestone: switched off, so nothing is created
    await notify(BOB, 2);
    expect((await call(alice, 'GET', '/notifications')).json<ListBody>().items).toHaveLength(0);
    expect((await call(bob, 'GET', '/notifications')).json<ListBody>().items).toHaveLength(1);
  });

  it('rejects an empty update, unknown categories and non-booleans', async () => {
    expect((await call(alice, 'PATCH', '/preferences', {})).statusCode).toBe(400);
    expect((await call(alice, 'PATCH', '/preferences', { spam: true })).statusCode).toBe(400);
    expect((await call(alice, 'PATCH', '/preferences', { badges: 'no' })).statusCode).toBe(400);
  });
});

describe('failure behaviour', () => {
  it('rate limits a client that changes preferences too fast (429 with Retry-After)', async () => {
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i += 1) {
      const response = await call(alice, 'PATCH', '/preferences', { badges: i % 2 === 0 });
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
        path: '/notifications',
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
    const token = await e2e.token(alice);
    await e2e.request({ method: 'GET', path: '/notifications', token });
    const logs = e2e.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(ALICE);
    expect(logs).not.toContain(token);
  });
});
