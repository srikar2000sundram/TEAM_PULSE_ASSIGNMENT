import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALICE, BOB, READ, WALK, createE2E, type E2E, type TokenSpec } from '../support/e2e.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const alice: TokenSpec = { userId: ALICE };
const bob: TokenSpec = { userId: BOB };
const ZONE = 'Europe/Berlin';

interface ListBody {
  items: {
    habitId: string;
    suggestedTime: string;
    timeZone: string;
    sampleSize: number;
    matching: number;
    confidence: string;
    status: string;
  }[];
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

/** Six morning walks at 06:10 UTC, which is 07:00 in Berlin in November. */
async function morningWalks(userId: string, habitId = WALK) {
  for (let day = 1; day <= 6; day += 1) {
    await e2e.completed(
      userId,
      habitId,
      `2026-11-${String(day).padStart(2, '0')}T06:10:00Z`,
      day + (habitId === WALK ? 0 : 100) + (userId === ALICE ? 0 : 1000),
    );
  }
}

describe('authentication', () => {
  it('needs a valid bearer token on every endpoint', async () => {
    for (const [method, path] of [
      ['GET', `/recommendations?timeZone=${ZONE}`],
      ['POST', `/recommendations/${WALK}/accept`],
      ['POST', `/recommendations/${WALK}/dismiss`],
    ] as const) {
      expect((await call(undefined, method, path)).statusCode, path).toBe(401);
    }
  });

  it('rejects a token meant for another audience', async () => {
    const response = await call(
      { ...alice, audience: 'someone-else' },
      'GET',
      `/recommendations?timeZone=${ZONE}`,
    );
    expect(response.statusCode).toBe(401);
  });
});

describe('listing recommendations', () => {
  it('suggests nothing until there is enough history', async () => {
    await e2e.completed(ALICE, WALK, '2026-11-01T06:10:00Z', 1);
    const response = await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<ListBody>().items).toEqual([]);
  });

  it('suggests the usual hour, in the requested time zone', async () => {
    await morningWalks(ALICE);
    const berlin = (await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>();
    expect(berlin.items).toEqual([
      {
        habitId: WALK,
        suggestedTime: '07:00',
        timeZone: ZONE,
        sampleSize: 6,
        matching: 6,
        confidence: 'high',
        status: 'pending',
      },
    ]);
    const utc = (await call(alice, 'GET', '/recommendations?timeZone=UTC')).json<ListBody>();
    expect(utc.items[0]?.suggestedTime).toBe('06:00');
  });

  it("never shows another person's habits or history", async () => {
    await morningWalks(ALICE);
    const bobsView = (await call(bob, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>();
    expect(bobsView.items).toEqual([]);
  });

  it('ignores completions older than the look-back window', async () => {
    for (let day = 1; day <= 6; day += 1) {
      await e2e.completed(ALICE, WALK, `2026-08-${String(day).padStart(2, '0')}T06:10:00Z`, day);
    }
    const response = (
      await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)
    ).json<ListBody>();
    expect(response.items).toEqual([]);
  });

  it('puts the strongest evidence first', async () => {
    await morningWalks(ALICE, WALK);
    for (let day = 1; day <= 5; day += 1) {
      await e2e.completed(
        ALICE,
        READ,
        `2026-11-${String(day).padStart(2, '0')}T20:00:00Z`,
        500 + day,
      );
    }
    const response = (
      await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)
    ).json<ListBody>();
    expect(response.items.map((item) => item.habitId)).toEqual([WALK, READ]);
  });

  it('rejects a missing or unknown time zone', async () => {
    expect((await call(alice, 'GET', '/recommendations')).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/recommendations?timeZone=Mars/Olympus')).statusCode).toBe(
      400,
    );
  });
});

describe('accepting and dismissing', () => {
  const decision = { suggestedTime: '07:00', timeZone: ZONE };

  it('records an acceptance, and the recommendation then shows as accepted', async () => {
    await morningWalks(ALICE);
    const response = await call(alice, 'POST', `/recommendations/${WALK}/accept`, decision);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ habitId: WALK, ...decision, status: 'accepted' });

    const list = (await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>();
    expect(list.items[0]?.status).toBe('accepted');
  });

  it('records a dismissal, and deciding again simply changes the decision', async () => {
    await morningWalks(ALICE);
    await call(alice, 'POST', `/recommendations/${WALK}/dismiss`, decision);
    expect(
      (await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>().items[0]
        ?.status,
    ).toBe('dismissed');
    await call(alice, 'POST', `/recommendations/${WALK}/accept`, decision);
    expect(
      (await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>().items[0]
        ?.status,
    ).toBe('accepted');
  });

  it('is idempotent: accepting twice changes nothing', async () => {
    await morningWalks(ALICE);
    const first = await call(alice, 'POST', `/recommendations/${WALK}/accept`, decision);
    const second = await call(alice, 'POST', `/recommendations/${WALK}/accept`, decision);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const { rows } = await e2e.db.query('SELECT 1 FROM decisions');
    expect(rows).toHaveLength(1);
  });

  it('a decision about one suggestion does not hide a different one', async () => {
    await morningWalks(ALICE);
    await call(alice, 'POST', `/recommendations/${WALK}/accept`, {
      suggestedTime: '09:00',
      timeZone: ZONE,
    });
    const list = (await call(alice, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>();
    expect(list.items[0]?.status).toBe('pending');
  });

  it("one person's decision never affects another's", async () => {
    await morningWalks(ALICE);
    await morningWalks(BOB);
    await call(alice, 'POST', `/recommendations/${WALK}/dismiss`, decision);
    const list = (await call(bob, 'GET', `/recommendations?timeZone=${ZONE}`)).json<ListBody>();
    expect(list.items[0]?.status).toBe('pending');
  });

  it.each([
    ['a missing body', undefined],
    ['an impossible time', { suggestedTime: '25:00', timeZone: ZONE }],
    ['an unknown time zone', { suggestedTime: '07:00', timeZone: 'Mars/Olympus' }],
    ['an undeclared field', { ...decision, userId: BOB }],
  ])('rejects %s', async (_name, body) => {
    const response = await call(alice, 'POST', `/recommendations/${WALK}/accept`, body);
    expect(response.statusCode).toBe(400);
  });

  it('rejects a habit id that is not a uuid', async () => {
    expect(
      (await call(alice, 'POST', '/recommendations/not-a-uuid/accept', decision)).statusCode,
    ).toBe(400);
  });
});
