import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TeamActivityReport, MyActivityReport } from '@teampulse/contracts';
import { createE2E, type E2E, type TokenSpec } from '../support/e2e.js';
import { ADMIN, MANAGER, OTHER_TEAM, TEAM, person, uuid } from '../support/harness.js';

let e2e: E2E;
beforeAll(async () => {
  e2e = await createE2E();
  await e2e.start();
});
beforeEach(() => e2e.reset());
afterAll(() => e2e.stop());

const member: TokenSpec = { userId: person(1), teams: [TEAM] };
const manager: TokenSpec = { userId: MANAGER, role: 'manager', manages: [TEAM], teams: [TEAM] };
const admin: TokenSpec = { userId: ADMIN, role: 'admin' };

const PERIOD = 'from=2026-11-01&to=2026-11-30';

async function get(spec: TokenSpec | undefined, path: string) {
  return e2e.request({ path, ...(spec === undefined ? {} : { token: await e2e.token(spec) }) });
}

async function activity(
  n: number,
  options: { type?: 'walking' | 'yoga'; date?: string; teams?: string[]; eventId?: string } = {},
) {
  await e2e.useCases.recordActivity.execute({
    eventId: options.eventId ?? uuid(0x30000 + Math.floor(Math.random() * 1e9)),
    userId: person(n),
    teamIds: options.teams ?? [TEAM],
    activityType: options.type ?? 'walking',
    activityDate: options.date ?? '2026-11-20',
  });
}

describe('authentication', () => {
  it('needs a valid bearer token on every endpoint', async () => {
    for (const path of [
      `/teams/${TEAM}/activity?${PERIOD}`,
      `/organization/activity?${PERIOD}`,
      `/me/activity?${PERIOD}`,
    ]) {
      const response = await get(undefined, path);
      expect(response.statusCode, path).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('auth.missing_token');
    }
  });

  it('serves health probes without a token', async () => {
    expect((await e2e.probe('/healthz')).statusCode).toBe(200);
    expect((await e2e.probe('/readyz')).statusCode).toBe(200);
  });
});

describe('team analytics', () => {
  it('shows numbers once at least five different people stand behind them', async () => {
    for (let n = 1; n <= 5; n += 1) await activity(n);
    const response = await get(manager, `/teams/${TEAM}/activity?${PERIOD}`);
    expect(response.statusCode).toBe(200);
    const body = response.json<TeamActivityReport>();
    expect(body).toMatchObject({
      scope: 'team',
      teamId: TEAM,
      from: '2026-11-01',
      to: '2026-11-30',
      minCohortSize: 5,
      total: { suppressed: false, completions: 5, participants: 5 },
      byActivityType: { walking: { suppressed: false, completions: 5, participants: 5 } },
      byDay: [{ date: '2026-11-20', cell: { suppressed: false, completions: 5 } }],
    });
  });

  it('withholds numbers, and the group size, for a small team', async () => {
    for (let n = 1; n <= 4; n += 1) await activity(n);
    const response = await get(manager, `/teams/${TEAM}/activity?${PERIOD}`);
    const body = response.json<TeamActivityReport>();
    expect(body.total).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    // Nothing numeric about the group is in the response body.
    expect(response.body).not.toMatch(/"(completions|participants)"/);
  });

  it('hides a second number so a hidden one cannot be worked out by subtraction', async () => {
    for (let n = 1; n <= 8; n += 1) await activity(n, { type: 'walking' });
    for (let n = 1; n <= 6; n += 1) await activity(n, { type: 'yoga', date: '2026-11-19' });
    await activity(9, { type: 'yoga', date: '2026-11-18' });
    const body = (
      await get(manager, `/teams/${TEAM}/activity?${PERIOD}`)
    ).json<TeamActivityReport>();
    const dayCells = body.byDay.map((day) => day.cell);
    expect(dayCells.filter((cell) => cell.suppressed)).toHaveLength(2);
  });

  it('lets an employee see their own team and a manager only the teams they manage', async () => {
    for (let n = 1; n <= 5; n += 1) await activity(n, { teams: [TEAM, OTHER_TEAM] });
    expect((await get(member, `/teams/${TEAM}/activity?${PERIOD}`)).statusCode).toBe(200);
    const elsewhere = await get(manager, `/teams/${OTHER_TEAM}/activity?${PERIOD}`);
    const missing = await get(manager, `/teams/${uuid(0x404)}/activity?${PERIOD}`);
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json<{ code: string }>().code).toBe('team.not_found');
    expect(elsewhere.json<{ detail: string }>().detail).toBe(
      missing.json<{ detail: string }>().detail,
    );
  });

  it('lets an administrator read any team', async () => {
    for (let n = 1; n <= 5; n += 1) await activity(n, { teams: [OTHER_TEAM] });
    expect((await get(admin, `/teams/${OTHER_TEAM}/activity?${PERIOD}`)).statusCode).toBe(200);
  });

  it('never exposes a user id or a pseudonym', async () => {
    for (let n = 1; n <= 6; n += 1) await activity(n);
    const response = await get(manager, `/teams/${TEAM}/activity?${PERIOD}`);
    for (let n = 1; n <= 6; n += 1) expect(response.body).not.toContain(person(n));
    expect(Object.keys(response.json<object>()).sort()).toEqual([
      'byActivityType',
      'byDay',
      'from',
      'minCohortSize',
      'scope',
      'teamId',
      'to',
      'total',
    ]);
  });

  it.each([
    ['a missing period', `/teams/${TEAM}/activity`],
    ['a reversed period', `/teams/${TEAM}/activity?from=2026-11-30&to=2026-11-01`],
    ['a period over 92 days', `/teams/${TEAM}/activity?from=2026-01-01&to=2026-06-01`],
    ['a malformed date', `/teams/${TEAM}/activity?from=yesterday&to=today`],
    ['an unknown parameter', `/teams/${TEAM}/activity?${PERIOD}&team=other`],
    ['a malformed team id', `/teams/not-a-uuid/activity?${PERIOD}`],
  ])('rejects %s', async (_name, path) => {
    const response = await get(manager, path);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
  });
});

describe('organization analytics', () => {
  it('is for administrators only', async () => {
    for (let n = 1; n <= 5; n += 1) await activity(n, { teams: [] });
    const allowed = await get(admin, `/organization/activity?${PERIOD}`);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<TeamActivityReport>()).toMatchObject({
      scope: 'organization',
      total: { suppressed: false, completions: 5, participants: 5 },
    });
    expect(allowed.json<TeamActivityReport>()).not.toHaveProperty('teamId');
    for (const spec of [manager, member]) {
      expect((await get(spec, `/organization/activity?${PERIOD}`)).statusCode).toBe(403);
    }
  });
});

describe('my analytics', () => {
  it('shows only your own numbers, unhidden, and not other people’s', async () => {
    await activity(1, { type: 'yoga' });
    await activity(1, { type: 'yoga', date: '2026-11-19' });
    await activity(2, { type: 'walking' });
    const response = await get(member, `/me/activity?${PERIOD}`);
    expect(response.json<MyActivityReport>()).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      total: 2,
      byActivityType: { yoga: 2 },
      byDay: [
        { date: '2026-11-19', completions: 1 },
        { date: '2026-11-20', completions: 1 },
      ],
    });
  });

  it('has no way to ask for someone else', async () => {
    await activity(2);
    const response = await get(member, `/me/activity?${PERIOD}&userId=${person(2)}`);
    expect(response.statusCode).toBe(400);
  });
});

describe('failure behaviour', () => {
  it('a store outage is a 503 with Retry-After, not a 500, and reveals nothing', async () => {
    const down = await createE2E();
    try {
      await down.start();
      down.store.failWith = Object.assign(new Error('socket hang up at dynamodb.eu-west-1'), {
        name: 'TimeoutError',
      });
      const response = await down.request({
        path: `/teams/${TEAM}/activity?${PERIOD}`,
        token: await down.token(manager),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.body).not.toContain('dynamodb');
      const ready = await down.probe('/readyz');
      expect(ready.statusCode).toBe(503);
    } finally {
      await down.stop();
    }
  });

  it('logs without raw user ids or tokens', async () => {
    const token = await e2e.token(member);
    await e2e.request({ path: `/me/activity?${PERIOD}`, token });
    const logs = e2e.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(person(1));
    expect(logs).not.toContain(token);
  });
});
