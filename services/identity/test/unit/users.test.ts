import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { runWithCorrelationId } from '@teampulse/observability';
import type { Result } from '@teampulse/kernel';
import { User } from '../../src/domain/user.js';
import { decodeCursor, encodeCursor } from '@teampulse/kernel';
import { GOOD_PASSWORD, buildHarness, type Harness } from '../support/harness.js';

function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error('expected a failure but the operation succeeded');
  return result.error;
}

async function adminHarness() {
  const h = buildHarness();
  const admin = await h.seedUser({ email: 'admin@example.com', role: 'admin' });
  return { h, admin, actor: await h.principalOf(admin) };
}

const newUser = {
  email: 'new.person@example.com',
  displayName: 'New Person',
  role: 'employee' as const,
  password: 'a-long-enough-passphrase',
};

describe('CreateUser', () => {
  it('lets an admin create a user, storing a hash, never the password', async () => {
    const { h, actor } = await adminHarness();

    const result = await h.app.createUser.execute({ ...newUser, actor });

    expect(result.ok).toBe(true);
    const stored = await h.uow.run((tx) => tx.users.findByEmail('new.person@example.com'));
    expect(stored?.passwordHash).toBe('fakehash:a-long-enough-passphrase');
    expect(stored?.passwordHash).not.toBe(newUser.password);
  });

  it('emits a valid UserRegistered event in the same transaction, carrying the correlation id', async () => {
    const { h, actor } = await adminHarness();
    const correlationId = '22222222-2222-4222-8222-222222222222';

    const result = await runWithCorrelationId(correlationId, () =>
      h.app.createUser.execute({ ...newUser, actor }),
    );
    if (!result.ok) throw result.error;

    const [event] = h.uow.store.outbox;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'UserRegistered',
      producer: 'identity',
      correlationId,
      payload: { userId: result.value.id, role: 'employee' },
    });
    // Privacy: the event must not carry the email or display name.
    expect(JSON.stringify(event)).not.toContain('new.person');
  });

  it.each(['employee', 'manager'] as const)(
    'forbids a %s and does no hashing work for them',
    async (role) => {
      const { h } = await adminHarness();
      const caller = await h.seedUser({ email: `${role}@example.com`, role });

      const result = await h.app.createUser.execute({
        ...newUser,
        actor: await h.principalOf(caller),
      });

      expect(errorOf(result).kind).toBe('forbidden');
      expect(h.hasher.hashCalls).toHaveLength(2); // only the two seed users
      expect(h.uow.store.outbox).toHaveLength(0);
    },
  );

  it('rejects a token that still says admin after the admin was demoted (stale claim)', async () => {
    const { h, admin, actor } = await adminHarness();
    const other = await h.seedUser({ email: 'other-admin@example.com', role: 'admin' });
    expect(other.role).toBe('admin');
    // Demote in the database; the old token still claims admin.
    const current = (await h.uow.run((tx) => tx.users.findById(admin.id)))!;
    h.uow.store.users.set(
      admin.id,
      User.restore({
        id: current.id,
        email: current.email,
        displayName: current.displayName,
        passwordHash: current.passwordHash,
        role: 'employee',
        status: 'active',
        failedLoginAttempts: 0,
        lockedUntil: null,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      }),
    );

    expect(errorOf(await h.app.createUser.execute({ ...newUser, actor })).kind).toBe('forbidden');
  });

  it('rejects a duplicate email without emitting an event', async () => {
    const { h, actor } = await adminHarness();
    await h.app.createUser.execute({ ...newUser, actor });
    const before = h.uow.store.outbox.length;

    const again = await h.app.createUser.execute({
      ...newUser,
      email: 'NEW.PERSON@example.com',
      actor,
    });

    expect(errorOf(again)).toMatchObject({ kind: 'conflict', code: 'user.email_taken' });
    expect(h.uow.store.outbox).toHaveLength(before);
  });

  it.each([
    ['weak password', { password: 'short' }, 'user.password_weak'],
    ['invalid email', { email: 'nope' }, 'user.email_invalid'],
    ['empty name', { displayName: '   ' }, 'user.display_name_invalid'],
    ['name too long', { displayName: 'x'.repeat(101) }, 'user.display_name_invalid'],
  ])('rejects %s', async (_name, change, code) => {
    const { h, actor } = await adminHarness();
    expect(errorOf(await h.app.createUser.execute({ ...newUser, ...change, actor })).code).toBe(
      code,
    );
  });
});

describe('BootstrapAdmin', () => {
  const input = {
    email: 'first@example.com',
    displayName: 'First Admin',
    password: 'a-long-enough-passphrase',
  };

  it('creates the first administrator', async () => {
    const h = buildHarness();
    const result = await h.app.bootstrapAdmin.execute(input);
    expect(result.ok && result.value.role).toBe('admin');
  });

  it('refuses once an active administrator exists, so it cannot add a back-door admin', async () => {
    const h = buildHarness();
    await h.app.bootstrapAdmin.execute(input);
    const second = await h.app.bootstrapAdmin.execute({ ...input, email: 'second@example.com' });
    expect(errorOf(second).code).toBe('user.admin_exists');
  });
});

describe('DeleteUser', () => {
  it('deletes the user, their memberships and sessions, and emits UserDeleted', async () => {
    const { h, actor } = await adminHarness();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    const team = await h.seedTeam(manager);
    const victim = await h.seedUser({ email: 'victim@example.com' });
    await h.uow.run((tx) => tx.teams.addMember(team.id, victim.id, h.clock.now()));
    await h.app.login.execute({ email: 'victim@example.com', password: GOOD_PASSWORD });

    const result = await h.app.deleteUser.execute({ actor, userId: victim.id });

    expect(result.ok).toBe(true);
    expect(await h.uow.run((tx) => tx.users.findById(victim.id))).toBeNull();
    expect(h.uow.store.members.size).toBe(0);
    expect([...h.uow.store.tokens.values()]).toHaveLength(0);
    const event = h.uow.store.outbox.at(-1);
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({ eventType: 'UserDeleted', payload: { userId: victim.id } });
  });

  it('refuses self-deletion, which is what guarantees an administrator always remains', async () => {
    const { h, admin, actor } = await adminHarness();
    expect(errorOf(await h.app.deleteUser.execute({ actor, userId: admin.id })).code).toBe(
      'user.cannot_delete_self',
    );
    expect(await h.app.deleteUser.execute({ actor, userId: admin.id })).toMatchObject({
      ok: false,
    });
    expect(await h.uow.run((tx) => tx.users.countActiveAdmins())).toBe(1);
  });

  it('lets one admin delete another, leaving the caller as an administrator', async () => {
    const { h, actor } = await adminHarness();
    const second = await h.seedUser({ email: 'second@example.com', role: 'admin' });
    expect((await h.app.deleteUser.execute({ actor, userId: second.id })).ok).toBe(true);
    expect(await h.uow.run((tx) => tx.users.countActiveAdmins())).toBe(1);
  });

  it('will not delete a manager who still manages teams (their teams would be orphaned)', async () => {
    const { h, actor } = await adminHarness();
    const manager = await h.seedUser({ email: 'm@example.com', role: 'manager' });
    await h.seedTeam(manager);
    expect(errorOf(await h.app.deleteUser.execute({ actor, userId: manager.id })).code).toBe(
      'user.manages_teams',
    );
  });

  it('answers not found for an unknown user and forbidden for non-admins', async () => {
    const { h, actor } = await adminHarness();
    expect(
      errorOf(
        await h.app.deleteUser.execute({ actor, userId: '99999999-9999-4999-8999-999999999999' }),
      ).code,
    ).toBe('user.not_found');

    const employee = await h.seedUser({ email: 'e@example.com' });
    const victim = await h.seedUser({ email: 'v@example.com' });
    const denied = await h.app.deleteUser.execute({
      actor: await h.principalOf(employee),
      userId: victim.id,
    });
    expect(errorOf(denied).kind).toBe('forbidden');
    expect(await h.uow.run((tx) => tx.users.findById(victim.id))).not.toBeNull();
  });
});

describe('ListUsers and cursors', () => {
  async function withUsers(
    count: number,
  ): Promise<{ h: Harness; actor: Awaited<ReturnType<Harness['principalOf']>> }> {
    const { h, actor } = await adminHarness();
    for (let i = 0; i < count; i += 1) {
      h.clock.advanceMs(1_000);
      await h.seedUser({ email: `user${i}@example.com`, displayName: `User ${i}` });
    }
    return { h, actor };
  }

  it('pages through every user exactly once, in a stable order', async () => {
    const { h, actor } = await withUsers(4); // plus the admin = 5 users
    const seen: string[] = [];
    let cursor: string | undefined;
    const pageSizes: number[] = [];

    do {
      const page = await h.app.listUsers.execute({ actor, limit: 2, cursor });
      if (!page.ok) throw page.error;
      pageSizes.push(page.value.items.length);
      seen.push(...page.value.items.map((u) => u.id));
      cursor = page.value.nextCursor;
    } while (cursor !== undefined);

    expect(pageSizes).toEqual([2, 2, 1]);
    expect(new Set(seen).size).toBe(5);
  });

  it('has no next cursor when everything fits on one page', async () => {
    const { h, actor } = await withUsers(2);
    const page = await h.app.listUsers.execute({ actor, limit: 50 });
    expect(page.ok && page.value.nextCursor).toBeUndefined();
  });

  it('rejects malformed cursors', async () => {
    const { h, actor } = await withUsers(1);
    for (const cursor of [
      'not-base64-!!',
      Buffer.from('a|b|c').toString('base64url'),
      Buffer.from('nope|x').toString('base64url'),
    ]) {
      expect(errorOf(await h.app.listUsers.execute({ actor, limit: 10, cursor })).code).toBe(
        'cursor.invalid',
      );
    }
  });

  it('round-trips a cursor', () => {
    const cursor = {
      createdAt: new Date('2026-11-20T08:00:00.123Z'),
      id: '00000000-0000-4000-8000-000000000001',
    };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.ok && decoded.value).toEqual(cursor);
  });

  it('is admin only', async () => {
    const { h } = await withUsers(1);
    const employee = await h.seedUser({ email: 'e@example.com' });
    const result = await h.app.listUsers.execute({
      actor: await h.principalOf(employee),
      limit: 10,
    });
    expect(errorOf(result).kind).toBe('forbidden');
  });
});

describe('GetCurrentUser', () => {
  it('returns the caller, and not found once the account is gone', async () => {
    const { h, actor } = await adminHarness();
    const person = await h.seedUser({ email: 'p@example.com' });
    const principal = await h.principalOf(person);

    const found = await h.app.getCurrentUser.execute({ actor: principal });
    expect(found.ok && found.value.id).toBe(person.id);

    await h.app.deleteUser.execute({ actor, userId: person.id });
    expect(errorOf(await h.app.getCurrentUser.execute({ actor: principal })).code).toBe(
      'user.not_found',
    );
  });
});
