import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import {
  ADMIN_PASSWORD,
  AUDIENCE,
  CLIENT_HEADERS,
  ISSUER,
  createE2E,
  type E2E,
} from '../support/e2e.js';

let e2e: E2E;

beforeAll(async () => {
  e2e = await createE2E();
});
afterAll(async () => {
  await e2e.stop();
});
beforeEach(async () => {
  await e2e.close();
  await e2e.reset();
  await e2e.start();
});

const PASSWORD = 'a-good-passphrase-1';
const employee = {
  email: 'erin@example.com',
  displayName: 'Erin Employee',
  role: 'employee' as const,
  password: PASSWORD,
};
const manager = {
  email: 'max@example.com',
  displayName: 'Max Manager',
  role: 'manager' as const,
  password: PASSWORD,
};

describe('complete user journey', () => {
  it('bootstrap, onboard, sign in, see only your own teams, refresh, sign out', async () => {
    const admin = await e2e.adminSession();

    // Admin onboards a manager and an employee, creates a team, and adds the employee.
    const managerId = await e2e.createUser(admin.token, manager);
    const employeeId = await e2e.createUser(admin.token, employee);
    const team = await e2e.request({
      method: 'POST',
      path: '/teams',
      token: admin.token,
      body: { name: 'Platform', managerUserId: managerId },
    });
    expect(team.statusCode).toBe(201);
    const teamId = team.json<{ id: string }>().id;
    expect(team.json()).toMatchObject({
      name: 'Platform',
      managerUserId: managerId,
      memberCount: 0,
    });

    const added = await e2e.request({
      method: 'POST',
      path: `/teams/${teamId}/members`,
      token: admin.token,
      body: { userId: employeeId },
    });
    expect(added.statusCode).toBe(204);

    // The employee signs in; the cookie is locked down and the token carries the team.
    const session = await e2e.login(employee.email, PASSWORD);
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { role: 'employee' },
    });
    const cookie = session.response.cookies.find((c) => c.name === 'tp_refresh');
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/v1/identity/auth',
    });

    const principal = await e2e.verifier().verify(session.accessToken!);
    expect(principal).toMatchObject({
      ok: true,
      value: { userId: employeeId, role: 'employee', teamIds: [teamId], managedTeamIds: [] },
    });

    // They see their own team (and its roster), not the whole organisation.
    const teams = await e2e.request({ method: 'GET', path: '/teams', token: session.accessToken! });
    expect(teams.json()).toEqual({
      items: [{ id: teamId, name: 'Platform', managerUserId: managerId, memberCount: 1 }],
    });
    const roster = await e2e.request({
      method: 'GET',
      path: `/teams/${teamId}/members`,
      token: session.accessToken!,
    });
    expect(roster.json()).toEqual({ items: [{ id: employeeId, displayName: 'Erin Employee' }] });

    // /me works, and admin endpoints are closed to them.
    const me = await e2e.request({ method: 'GET', path: '/me', token: session.accessToken! });
    expect(me.json()).toEqual({
      id: employeeId,
      email: employee.email,
      displayName: 'Erin Employee',
      role: 'employee',
      status: 'active',
    });
    expect(
      (await e2e.request({ method: 'GET', path: '/users', token: session.accessToken! }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await e2e.request({
          method: 'POST',
          path: '/users',
          token: session.accessToken!,
          body: manager,
        })
      ).statusCode,
    ).toBe(403);

    // Refresh rotates the cookie and returns a fresh access token.
    const refreshed = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: session.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    expect(refreshed.statusCode).toBe(200);
    const newCookie = refreshed.cookies.find((c) => c.name === 'tp_refresh')!;
    expect(newCookie.value).not.toBe(session.refreshCookie);

    // Sign out, and the session is really over.
    const out = await e2e.request({
      method: 'POST',
      path: '/auth/logout',
      refreshCookie: newCookie.value,
      headers: CLIENT_HEADERS,
    });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === 'tp_refresh')?.value).toBe('');
    const after = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: newCookie.value,
      headers: CLIENT_HEADERS,
    });
    expect(after.statusCode).toBe(401);
  });

  it('a manager sees the team they manage and their token says so', async () => {
    const admin = await e2e.adminSession();
    const managerId = await e2e.createUser(admin.token, manager);
    const team = await e2e.request({
      method: 'POST',
      path: '/teams',
      token: admin.token,
      body: { name: 'Data', managerUserId: managerId },
    });
    const teamId = team.json<{ id: string }>().id;

    const session = await e2e.login(manager.email, PASSWORD);
    const principal = await e2e.verifier().verify(session.accessToken!);
    expect(principal).toMatchObject({
      ok: true,
      value: { role: 'manager', managedTeamIds: [teamId] },
    });
    const teams = await e2e.request({ method: 'GET', path: '/teams', token: session.accessToken! });
    expect(teams.json<{ items: unknown[] }>().items).toHaveLength(1);
  });
});

describe('login failures', () => {
  it('answers a wrong password and an unknown email with the same body', async () => {
    const admin = await e2e.adminSession();
    await e2e.createUser(admin.token, employee);

    const wrong = await e2e.login(employee.email, 'definitely-not-it-1');
    const unknown = await e2e.login('ghost@example.com', 'definitely-not-it-1');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.response.headers['content-type']).toContain('application/problem+json');
    const strip = (body: object) => ({ ...body, correlationId: undefined });
    expect(strip(wrong.response.json())).toEqual(strip(unknown.response.json()));
    expect(wrong.response.json()).toMatchObject({ code: 'auth.invalid_credentials', status: 401 });
    expect(wrong.response.cookies).toHaveLength(0);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const admin = await e2e.adminSession();
    await e2e.createUser(admin.token, employee);
    // Different client addresses, so the per-IP rate limit does not mask the account lockout.
    for (let i = 0; i < 5; i += 1)
      await e2e.login(employee.email, 'wrong-wrong-wrong-1', `10.0.0.${i + 1}`);

    expect((await e2e.login(employee.email, PASSWORD, '10.0.0.50')).status).toBe(401);
    e2e.clock.advanceMs(16 * 60_000);
    expect((await e2e.login(employee.email, PASSWORD, '10.0.0.51')).status).toBe(200);
  });

  it('rate limits a single client hammering the login endpoint', async () => {
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await e2e.login('nobody@example.com', 'wrong-password-123');
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(last?.response.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(last?.response.headers['retry-after']).toBeDefined();
  });
});

describe('request validation', () => {
  it('rejects unknown fields and wrong media types', async () => {
    const extra = await e2e.request({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'a@example.com', password: 'x', admin: true },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json<{ errors: { field: string }[] }>().errors.map((e) => e.field)).toContain(
      'body',
    );

    const text = await e2e.request({
      method: 'POST',
      path: '/auth/login',
      headers: { 'content-type': 'text/plain' },
      body: 'email=a&password=b',
    });
    expect(text.statusCode).toBe(415);
  });

  it('explains a weak password field by field', async () => {
    const admin = await e2e.adminSession();
    const response = await e2e.request({
      method: 'POST',
      path: '/users',
      token: admin.token,
      body: { ...employee, password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { field: string }[] }>().errors.map((e) => e.field)).toContain(
      'body.password',
    );
  });

  it('rejects malformed ids in the path', async () => {
    const admin = await e2e.adminSession();
    const response = await e2e.request({
      method: 'DELETE',
      path: '/users/not-a-uuid',
      token: admin.token,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('authentication of API calls', () => {
  it.each([
    ['no token', undefined],
    ['garbage token', 'not.a.jwt'],
  ])('rejects %s', async (_name, token) => {
    const response = await e2e.request({
      method: 'GET',
      path: '/me',
      ...(token === undefined ? {} : { token }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects an expired access token', async () => {
    const admin = await e2e.adminSession();
    e2e.clock.advanceMs(16 * 60_000);
    expect((await e2e.request({ method: 'GET', path: '/me', token: admin.token })).statusCode).toBe(
      401,
    );
  });

  it('answers /me with 404 for a deleted user whose token has not expired yet', async () => {
    const admin = await e2e.adminSession();
    const id = await e2e.createUser(admin.token, employee);
    const session = await e2e.login(employee.email, PASSWORD);

    expect(
      (await e2e.request({ method: 'DELETE', path: `/users/${id}`, token: admin.token }))
        .statusCode,
    ).toBe(204);

    expect(
      (await e2e.request({ method: 'GET', path: '/me', token: session.accessToken! })).statusCode,
    ).toBe(404);
    const outbox = await e2e.db.query<{ event_type: string }>(
      'SELECT event_type FROM outbox ORDER BY created_at',
    );
    expect(outbox.rows.map((r) => r.event_type)).toContain('UserDeleted');
  });
});

describe('refresh cookie endpoints', () => {
  it('require the web-client header (CSRF defence in depth)', async () => {
    const admin = await e2e.adminSession();
    expect(admin.token).toBeDefined();
    const session = await e2e.login('admin@example.com', ADMIN_PASSWORD);

    const refresh = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: session.refreshCookie!,
    });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json()).toMatchObject({ code: 'auth.client_header_required' });
    const logout = await e2e.request({
      method: 'POST',
      path: '/auth/logout',
      refreshCookie: session.refreshCookie!,
    });
    expect(logout.statusCode).toBe(403);
  });

  it('answer 401 without a cookie, and 401 plus a cleared cookie when the cookie is dead', async () => {
    const none = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      headers: CLIENT_HEADERS,
    });
    expect(none.statusCode).toBe(401);
    expect(none.cookies).toHaveLength(0); // nothing was sent, so there is nothing to clear

    const bogus = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: 'forged',
      headers: CLIENT_HEADERS,
    });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.cookies.find((c) => c.name === 'tp_refresh')?.value).toBe('');
  });

  it('detect a replayed cookie, and the thief takes the legitimate session down with them', async () => {
    await e2e.adminSession();
    const first = await e2e.login('admin@example.com', ADMIN_PASSWORD);
    const rotated = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: first.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    const legitimate = rotated.cookies.find((c) => c.name === 'tp_refresh')!.value;

    e2e.clock.advanceMs(60_000); // beyond the 10 s benign-race window
    const replay = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: first.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    expect(replay.statusCode).toBe(401);

    const victim = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: legitimate,
      headers: CLIENT_HEADERS,
    });
    expect(victim.statusCode).toBe(401);
  });

  it('treat two near-simultaneous refreshes as a race and keep the session alive', async () => {
    await e2e.adminSession();
    const first = await e2e.login('admin@example.com', ADMIN_PASSWORD);
    const winner = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: first.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    const winnerCookie = winner.cookies.find((c) => c.name === 'tp_refresh')!.value;

    e2e.clock.advanceMs(2_000);
    const loser = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: first.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    expect(loser.statusCode).toBe(409);
    expect(loser.json()).toMatchObject({ code: 'auth.refresh_race' });
    expect(loser.cookies.find((c) => c.name === 'tp_refresh')).toBeUndefined();

    const next = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: winnerCookie,
      headers: CLIENT_HEADERS,
    });
    expect(next.statusCode).toBe(200);
  });
});

describe('administering users over HTTP', () => {
  const patch = (path: string, token: string, body: object) =>
    e2e.request({ method: 'PATCH', path, token, body });

  it('lets an admin disable an account, which ends its access, and re-enable it later', async () => {
    const admin = await e2e.adminSession();
    const id = await e2e.createUser(admin.token, employee);
    const session = await e2e.login(employee.email, PASSWORD);

    const disabled = await patch(`/users/${id}`, admin.token, { status: 'disabled' });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ id, status: 'disabled' });

    expect((await e2e.login(employee.email, PASSWORD, '10.3.0.1')).status).toBe(401);
    const renewal = await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: session.refreshCookie!,
      headers: CLIENT_HEADERS,
    });
    expect(renewal.statusCode).toBe(401);

    await patch(`/users/${id}`, admin.token, { status: 'active' });
    expect((await e2e.login(employee.email, PASSWORD, '10.3.0.2')).status).toBe(200);
  });

  it('promotes a user, rejects empty or unknown-field changes, and forbids non-admins', async () => {
    const admin = await e2e.adminSession();
    const id = await e2e.createUser(admin.token, employee);

    const promoted = await patch(`/users/${id}`, admin.token, { role: 'manager' });
    expect(promoted.json()).toMatchObject({ role: 'manager' });

    expect((await patch(`/users/${id}`, admin.token, {})).statusCode).toBe(400);
    expect(
      (await patch(`/users/${id}`, admin.token, { role: 'admin', email: 'x@y.co' })).statusCode,
    ).toBe(400);

    const session = await e2e.login(employee.email, PASSWORD);
    expect((await patch(`/users/${id}`, session.accessToken!, { role: 'admin' })).statusCode).toBe(
      403,
    );
  });

  it('will not let an admin change their own account', async () => {
    const admin = await e2e.adminSession();
    const response = await patch(`/users/${admin.userId}`, admin.token, { status: 'disabled' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'user.cannot_modify_self' });
  });
});

describe('change password', () => {
  it('signs the user out everywhere and accepts only the new password', async () => {
    const admin = await e2e.adminSession();
    await e2e.createUser(admin.token, employee);
    const session = await e2e.login(employee.email, PASSWORD);

    const changed = await e2e.request({
      method: 'POST',
      path: '/me/password',
      token: session.accessToken!,
      body: { currentPassword: PASSWORD, newPassword: 'a-completely-new-one-1' },
    });
    expect(changed.statusCode).toBe(204);
    expect(changed.cookies.find((c) => c.name === 'tp_refresh')?.value).toBe('');

    expect(
      (
        await e2e.request({
          method: 'POST',
          path: '/auth/refresh',
          refreshCookie: session.refreshCookie!,
          headers: CLIENT_HEADERS,
        })
      ).statusCode,
    ).toBe(401);
    expect((await e2e.login(employee.email, PASSWORD, '10.1.0.1')).status).toBe(401);
    expect((await e2e.login(employee.email, 'a-completely-new-one-1', '10.1.0.2')).status).toBe(
      200,
    );
  });
});

describe('public surface', () => {
  it('publishes only public keys, which verify the tokens it issues', async () => {
    const admin = await e2e.adminSession();
    const response = await e2e.request({ method: 'GET', path: '/.well-known/jwks.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');

    const jwks = response.json<{ keys: Record<string, unknown>[] }>();
    expect(jwks.keys).toHaveLength(1);
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi'])
      expect(jwks.keys[0]).not.toHaveProperty(secret);

    // A different service that only knows the published JWKS can verify our token.
    const remote = createLocalJwksVerifier(jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      clock: e2e.clock,
    });
    expect((await remote.verify(admin.token)).ok).toBe(true);
  });

  it('describes itself with a generated OpenAPI document', async () => {
    const response = await e2e.request({ method: 'GET', path: '/openapi.json' });
    const doc = response.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/identity/auth/login',
        '/api/v1/identity/users',
        '/api/v1/identity/teams/{teamId}/members',
      ]),
    );
  });

  it('serves liveness and readiness without authentication', async () => {
    const app = await e2e.start();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.json()).toEqual({ status: 'ready' });
  });
});

describe('secrets never leak', () => {
  it('keeps hashes, passwords and tokens out of every response and every log line', async () => {
    const admin = await e2e.adminSession();
    await e2e.createUser(admin.token, employee);
    const session = await e2e.login(employee.email, PASSWORD);
    await e2e.login(employee.email, 'wrong-password-123', '10.2.0.1');
    await e2e.request({ method: 'GET', path: '/me', token: session.accessToken! });
    await e2e.request({ method: 'GET', path: '/users', token: admin.token });
    await e2e.request({
      method: 'POST',
      path: '/auth/refresh',
      refreshCookie: session.refreshCookie!,
      headers: CLIENT_HEADERS,
    });

    const responses = e2e.bodies.join('\n');
    expect(responses).not.toMatch(/argon2|passwordHash|password_hash/i);
    expect(responses).not.toContain(PASSWORD);

    const logs = e2e.logLines.join('\n');
    for (const secret of [
      PASSWORD,
      ADMIN_PASSWORD,
      'wrong-password-123',
      session.accessToken!,
      session.refreshCookie!,
      employee.email,
      'argon2id',
    ]) {
      expect(logs).not.toContain(secret);
    }
    // But monitoring still gets the events it needs.
    expect(logs).toContain('auth.login.failed');
    expect(logs).toContain('auth.login.succeeded');
  });
});
