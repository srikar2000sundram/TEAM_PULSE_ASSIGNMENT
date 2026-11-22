import { describe, expect, it } from 'vitest';
import type { Result } from '@teampulse/kernel';
import { GOOD_PASSWORD, buildHarness } from '../support/harness.js';

function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error('expected a failure but the operation succeeded');
  return result.error;
}

async function adminHarness() {
  const h = buildHarness();
  const admin = await h.seedUser({ email: 'admin@example.com', role: 'admin' });
  return { h, admin, actor: await h.principalOf(admin) };
}

const GHOST = '99999999-9999-4999-8999-999999999999';

describe('UpdateUser', () => {
  it('disables an account: sign-in stops and existing sessions can no longer be renewed', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });
    const login = await h.app.login.execute({ email: 'p@example.com', password: GOOD_PASSWORD });
    if (!login.ok) throw login.error;

    const result = await h.app.updateUser.execute({ actor, userId: person.id, status: 'disabled' });

    expect(result.ok && result.value.status).toBe('disabled');
    const retry = await h.app.login.execute({ email: 'p@example.com', password: GOOD_PASSWORD });
    expect(errorOf(retry).code).toBe('auth.invalid_credentials');
    expect((await h.app.refresh.execute({ refreshToken: login.value.refresh.secret })).ok).toBe(
      false,
    );
  });

  it('re-enables an account and clears any lockout, so the person can sign in straight away', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });
    for (let i = 0; i < h.lockout.maxFailedAttempts; i += 1) {
      await h.app.login.execute({ email: 'p@example.com', password: 'wrong-password-1' });
    }
    await h.app.updateUser.execute({ actor, userId: person.id, status: 'disabled' });

    await h.app.updateUser.execute({ actor, userId: person.id, status: 'active' });

    const login = await h.app.login.execute({ email: 'p@example.com', password: GOOD_PASSWORD });
    expect(login.ok).toBe(true);
  });

  it('changes the role, and the next token carries it', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });

    const result = await h.app.updateUser.execute({ actor, userId: person.id, role: 'manager' });

    expect(result.ok && result.value.role).toBe('manager');
    await h.app.login.execute({ email: 'p@example.com', password: GOOD_PASSWORD });
    expect(h.tokenIssuer.issued.at(-1)?.user.role).toBe('manager');
  });

  it('can change role and status together, and repeating the request is a harmless no-op', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });
    const request = {
      actor,
      userId: person.id,
      role: 'manager' as const,
      status: 'disabled' as const,
    };

    const first = await h.app.updateUser.execute(request);
    expect(first.ok && [first.value.role, first.value.status]).toEqual(['manager', 'disabled']);
    expect((await h.app.updateUser.execute(request)).ok).toBe(true);
  });

  it('refuses to change your own account, which keeps an administrator always available', async () => {
    const { h, admin, actor } = await adminHarness();
    for (const change of [{ role: 'employee' as const }, { status: 'disabled' as const }]) {
      const result = await h.app.updateUser.execute({ actor, userId: admin.id, ...change });
      expect(errorOf(result).code).toBe('user.cannot_modify_self');
    }
    expect(await h.uow.run((tx) => tx.users.countActiveAdmins())).toBe(1);
  });

  it('will not demote a manager who still manages teams', async () => {
    const { h, actor } = await adminHarness();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    await h.seedTeam(manager);

    const result = await h.app.updateUser.execute({ actor, userId: manager.id, role: 'employee' });

    expect(errorOf(result).code).toBe('user.manages_teams');
    expect((await h.uow.run((tx) => tx.users.findById(manager.id)))?.role).toBe('manager');
  });

  it('requires a change, an existing user, and an administrator', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });

    expect(errorOf(await h.app.updateUser.execute({ actor, userId: person.id })).code).toBe(
      'user.update_empty',
    );
    const missing = await h.app.updateUser.execute({ actor, userId: GHOST, role: 'manager' });
    expect(errorOf(missing).code).toBe('user.not_found');

    const employee = await h.seedUser({ email: 'e@example.com' });
    const denied = await h.app.updateUser.execute({
      actor: await h.principalOf(employee),
      userId: person.id,
      role: 'admin',
    });
    expect(errorOf(denied).kind).toBe('forbidden');
    expect((await h.uow.run((tx) => tx.users.findById(person.id)))?.role).toBe('employee');
  });
});

describe('audit trail for administrative actions', () => {
  it('records who did what, using ids only and no personal data', async () => {
    const { h, admin, actor } = await adminHarness();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    const person = await h.seedUser({ email: 'victim@example.com' });

    const created = await h.app.createUser.execute({
      actor,
      email: 'new.person@example.com',
      displayName: 'New Person',
      role: 'employee',
      password: 'a-long-enough-passphrase',
    });
    const team = await h.app.createTeam.execute({
      actor,
      name: 'Audit',
      managerUserId: manager.id,
    });
    if (!created.ok || !team.ok) throw new Error('setup failed');
    await h.app.addTeamMember.execute({ actor, teamId: team.value.id, userId: person.id });
    await h.app.removeTeamMember.execute({ actor, teamId: team.value.id, userId: person.id });
    await h.app.updateUser.execute({ actor, userId: person.id, status: 'disabled' });
    await h.app.deleteUser.execute({ actor, userId: person.id });

    const audit = h.records().filter((record) => typeof record.actorUserId === 'string');
    expect(audit.map((record) => record.event)).toEqual([
      'user.created',
      'team.created',
      'team.member_added',
      'team.member_removed',
      'user.updated',
      'user.deleted',
    ]);

    // The actor is never written as a raw id, and no email or name appears anywhere.
    const everything = h.logLines.join('\n');
    expect(everything).not.toContain(admin.id);
    expect(everything).not.toContain('victim@example.com');
    expect(everything).not.toContain('new.person');
  });
});
