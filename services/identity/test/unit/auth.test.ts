import { describe, expect, it } from 'vitest';
import type { Result } from '@teampulse/kernel';
import { GOOD_PASSWORD, buildHarness } from '../support/harness.js';

const DAY = 24 * 3_600_000;

function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error('expected a failure but the operation succeeded');
  return result.error;
}

describe('Login', () => {
  it('returns an access token, the user, and a refresh credential', async () => {
    const h = buildHarness();
    const user = await h.seedUser({ email: 'ada@example.com' });

    const result = await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accessToken).toBe(`access-token-for-${user.id}`);
    expect(result.value.expiresInSeconds).toBe(900);
    expect(result.value.user.id).toBe(user.id);
    expect(result.value.refresh.secret).toBe('refresh-secret-1');
  });

  it('stores only the hash of the refresh secret', async () => {
    const h = buildHarness();
    await h.seedUser({ email: 'ada@example.com' });
    const result = await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });
    if (!result.ok) throw result.error;

    const stored = [...h.uow.store.tokens.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(h.opaqueTokens.hash(result.value.refresh.secret));
    expect(JSON.stringify(stored)).not.toContain(result.value.refresh.secret);
  });

  it('is case-insensitive about the email address', async () => {
    const h = buildHarness();
    await h.seedUser({ email: 'ada@example.com' });
    const result = await h.app.login.execute({
      email: ' ADA@Example.com ',
      password: GOOD_PASSWORD,
    });
    expect(result.ok).toBe(true);
  });

  it('puts the current team memberships and managed teams into the token', async () => {
    const h = buildHarness();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    const member = await h.seedUser({ email: 'e@example.com' });
    const team = await h.seedTeam(manager);
    await h.uow.run((tx) => tx.teams.addMember(team.id, member.id, h.clock.now()));

    await h.app.login.execute({ email: 'e@example.com', password: GOOD_PASSWORD });
    await h.app.login.execute({ email: 'm@example.com', password: GOOD_PASSWORD });

    expect(h.tokenIssuer.issued[0]).toMatchObject({ teamIds: [team.id], managedTeamIds: [] });
    expect(h.tokenIssuer.issued[1]).toMatchObject({ teamIds: [], managedTeamIds: [team.id] });
  });

  describe('failure responses reveal nothing about accounts', () => {
    it('gives the identical error for a wrong password, unknown email, bad email, locked and disabled accounts', async () => {
      const h = buildHarness();
      await h.seedUser({ email: 'ada@example.com' });
      await h.seedUser({ email: 'off@example.com', disabled: true });

      const attempts = await Promise.all([
        h.app.login.execute({ email: 'ada@example.com', password: 'wrong-password-1' }),
        h.app.login.execute({ email: 'nobody@example.com', password: 'wrong-password-1' }),
        h.app.login.execute({ email: 'not-an-email', password: 'wrong-password-1' }),
        h.app.login.execute({ email: 'off@example.com', password: GOOD_PASSWORD }),
      ]);

      const errors = attempts.map((a) => {
        const e = errorOf(a);
        return { kind: e.kind, code: e.code, message: e.message };
      });
      for (const error of errors) {
        expect(error).toEqual({
          kind: 'unauthorized',
          code: 'auth.invalid_credentials',
          message: 'The email or password is incorrect',
        });
      }
    });

    it('still does the expensive hash work when the account does not exist (no timing oracle)', async () => {
      const h = buildHarness();
      await h.app.login.execute({ email: 'nobody@example.com', password: 'whatever-12345' });
      expect(h.hasher.verifyCalls).toEqual([
        { hash: 'fakehash:decoy-password-nobody-knows', password: 'whatever-12345' },
      ]);
    });

    it('does the same for a locked account, even when the password is right', async () => {
      const h = buildHarness();
      await h.seedUser({ email: 'ada@example.com' });
      for (let i = 0; i < h.lockout.maxFailedAttempts; i += 1) {
        await h.app.login.execute({ email: 'ada@example.com', password: 'wrong-password-1' });
      }
      h.hasher.verifyCalls.length = 0;

      const result = await h.app.login.execute({
        email: 'ada@example.com',
        password: GOOD_PASSWORD,
      });

      expect(errorOf(result).code).toBe('auth.invalid_credentials');
      expect(h.hasher.verifyCalls[0]?.hash).toBe('fakehash:decoy-password-nobody-knows');
    });
  });

  describe('lockout', () => {
    it('locks after repeated failures and unlocks when the lockout period ends', async () => {
      const h = buildHarness();
      await h.seedUser({ email: 'ada@example.com' });
      for (let i = 0; i < h.lockout.maxFailedAttempts; i += 1) {
        await h.app.login.execute({ email: 'ada@example.com', password: 'wrong-password-1' });
      }

      expect(
        (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
      ).toBe(false);

      h.clock.advanceMs(h.lockout.lockoutMs);
      expect(
        (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
      ).toBe(true);
    });

    it('a success in between resets the failure count', async () => {
      const h = buildHarness();
      const user = await h.seedUser({ email: 'ada@example.com' });
      for (let i = 0; i < h.lockout.maxFailedAttempts - 1; i += 1) {
        await h.app.login.execute({ email: 'ada@example.com', password: 'wrong-password-1' });
      }
      await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });
      expect((await h.uow.run((tx) => tx.users.findById(user.id)))?.failedLoginAttempts).toBe(0);

      // One more failure must not lock: the earlier ones no longer count.
      await h.app.login.execute({ email: 'ada@example.com', password: 'wrong-password-1' });
      expect(
        (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
      ).toBe(true);
    });
  });

  it('logs failures for monitoring without ever logging the email or password', async () => {
    const h = buildHarness();
    await h.seedUser({ email: 'ada@example.com' });
    await h.app.login.execute({ email: 'ada@example.com', password: 'hunter2-hunter2' });
    await h.app.login.execute({ email: 'ghost@example.com', password: 'hunter2-hunter2' });

    const failures = h.records().filter((r) => r.event === 'auth.login.failed');
    expect(failures.map((r) => r.reason)).toEqual(['bad_password', 'unknown_user']);
    const everything = h.logLines.join('\n');
    expect(everything).not.toContain('ada@example.com');
    expect(everything).not.toContain('ghost@example.com');
    expect(everything).not.toContain('hunter2');
  });
});

describe('RefreshSession', () => {
  async function loggedIn() {
    const h = buildHarness();
    const user = await h.seedUser({ email: 'ada@example.com' });
    const login = await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });
    if (!login.ok) throw login.error;
    return { h, user, secret: login.value.refresh.secret };
  }

  it('rotates: a new token is issued and the old one is retired', async () => {
    const { h, secret } = await loggedIn();
    h.clock.advanceMs(60_000);

    const result = await h.app.refresh.execute({ refreshToken: secret });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refresh.secret).not.toBe(secret);
    const old = h.uow.store.tokens.get(h.opaqueTokens.hash(secret));
    expect(old?.isRevoked).toBe(true);
    expect(old?.replacedById).not.toBeNull();
  });

  it('picks up team changes made since login', async () => {
    const { h, user, secret } = await loggedIn();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    const team = await h.seedTeam(manager);
    await h.uow.run((tx) => tx.teams.addMember(team.id, user.id, h.clock.now()));

    await h.app.refresh.execute({ refreshToken: secret });

    expect(h.tokenIssuer.issued.at(-1)?.teamIds).toEqual([team.id]);
  });

  it('rejects an unknown token with the generic session error', async () => {
    const { h } = await loggedIn();
    const result = await h.app.refresh.execute({ refreshToken: 'made-up' });
    expect(errorOf(result).code).toBe('auth.invalid_refresh_token');
  });

  it('treats reuse of an old token as theft and revokes the whole session family', async () => {
    const { h, secret } = await loggedIn();
    h.clock.advanceMs(60_000);
    const rotated = await h.app.refresh.execute({ refreshToken: secret });
    if (!rotated.ok) throw rotated.error;

    h.clock.advanceMs(h.rotation.reuseGraceMs + 1);
    const replay = await h.app.refresh.execute({ refreshToken: secret });

    expect(errorOf(replay).code).toBe('auth.invalid_refresh_token');
    // The legitimate holder's newer token is dead too, forcing everyone to sign in again.
    const legit = await h.app.refresh.execute({ refreshToken: rotated.value.refresh.secret });
    expect(errorOf(legit).code).toBe('auth.invalid_refresh_token');
    expect(h.records().some((r) => r.event === 'auth.refresh.reuse_detected')).toBe(true);
  });

  it('treats a near-simultaneous second refresh (two tabs) as a race, not theft', async () => {
    const { h, secret } = await loggedIn();
    h.clock.advanceMs(60_000);
    const first = await h.app.refresh.execute({ refreshToken: secret });
    if (!first.ok) throw first.error;

    h.clock.advanceMs(1_000);
    const second = await h.app.refresh.execute({ refreshToken: secret });

    expect(errorOf(second)).toMatchObject({ kind: 'conflict', code: 'auth.refresh_race' });
    // Nobody was signed out: the winner's token still works.
    const next = await h.app.refresh.execute({ refreshToken: first.value.refresh.secret });
    expect(next.ok).toBe(true);
  });

  it('rejects an expired token', async () => {
    const { h, secret } = await loggedIn();
    h.clock.advanceMs(h.rotation.tokenTtlMs + 1);
    expect(errorOf(await h.app.refresh.execute({ refreshToken: secret })).code).toBe(
      'auth.invalid_refresh_token',
    );
  });

  it('ends a session at its absolute maximum age even if it is used constantly', async () => {
    const { h, secret: first } = await loggedIn();
    let secret = first;
    let elapsed = 0;
    // Refresh every 5 days: each individual token is always valid, but the family is capped.
    while (elapsed + 5 * DAY < h.rotation.familyMaxAgeMs) {
      h.clock.advanceMs(5 * DAY);
      elapsed += 5 * DAY;
      const next = await h.app.refresh.execute({ refreshToken: secret });
      if (!next.ok) throw next.error;
      secret = next.value.refresh.secret;
    }
    h.clock.advanceMs(h.rotation.familyMaxAgeMs - elapsed);
    expect(errorOf(await h.app.refresh.execute({ refreshToken: secret })).code).toBe(
      'auth.invalid_refresh_token',
    );
  });

  it('refuses to refresh for a user disabled in the meantime and kills the session', async () => {
    const { h, user, secret } = await loggedIn();
    const current = await h.uow.run((tx) => tx.users.findById(user.id));
    if (current === null) throw new Error('missing');
    // Disable directly in the store.
    const { User } = await import('../../src/domain/user.js');
    h.uow.store.users.set(
      user.id,
      User.restore({
        id: current.id,
        email: current.email,
        displayName: current.displayName,
        passwordHash: current.passwordHash,
        role: current.role,
        status: 'disabled',
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      }),
    );

    expect((await h.app.refresh.execute({ refreshToken: secret })).ok).toBe(false);
    expect([...h.uow.store.tokens.values()].every((t) => t.isRevoked)).toBe(true);
  });
});

describe('Logout', () => {
  it('revokes the session so its refresh token no longer works', async () => {
    const h = buildHarness();
    await h.seedUser({ email: 'ada@example.com' });
    const login = await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });
    if (!login.ok) throw login.error;

    expect((await h.app.logout.execute({ refreshToken: login.value.refresh.secret })).ok).toBe(
      true,
    );

    expect((await h.app.refresh.execute({ refreshToken: login.value.refresh.secret })).ok).toBe(
      false,
    );
  });

  it('succeeds quietly for a missing or unknown token (cannot be used to probe)', async () => {
    const h = buildHarness();
    expect((await h.app.logout.execute({ refreshToken: undefined })).ok).toBe(true);
    expect((await h.app.logout.execute({ refreshToken: 'unknown' })).ok).toBe(true);
  });
});

describe('ChangePassword', () => {
  const NEW_PASSWORD = 'a-brand-new-passphrase';

  it('replaces the password and signs the user out everywhere', async () => {
    const h = buildHarness();
    const user = await h.seedUser({ email: 'ada@example.com' });
    const login = await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD });
    if (!login.ok) throw login.error;

    const result = await h.app.changePassword.execute({
      actor: await h.principalOf(user),
      currentPassword: GOOD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(result.ok).toBe(true);
    expect(
      (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
    ).toBe(false);
    expect(
      (await h.app.login.execute({ email: 'ada@example.com', password: NEW_PASSWORD })).ok,
    ).toBe(true);
    expect((await h.app.refresh.execute({ refreshToken: login.value.refresh.secret })).ok).toBe(
      false,
    );
  });

  it('rejects a wrong current password and counts it towards the lockout', async () => {
    const h = buildHarness();
    const user = await h.seedUser({ email: 'ada@example.com' });
    const actor = await h.principalOf(user);

    for (let i = 0; i < h.lockout.maxFailedAttempts; i += 1) {
      const result = await h.app.changePassword.execute({
        actor,
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
      });
      expect(errorOf(result).code).toBe('auth.invalid_credentials');
    }
    expect(
      (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
    ).toBe(false);
  });

  it('rejects a weak new password without touching anything', async () => {
    const h = buildHarness();
    const user = await h.seedUser({ email: 'ada@example.com' });
    const result = await h.app.changePassword.execute({
      actor: await h.principalOf(user),
      currentPassword: GOOD_PASSWORD,
      newPassword: 'short',
    });
    expect(errorOf(result).code).toBe('user.password_weak');
    expect(
      (await h.app.login.execute({ email: 'ada@example.com', password: GOOD_PASSWORD })).ok,
    ).toBe(true);
  });
});
