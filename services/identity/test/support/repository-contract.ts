import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent } from '@teampulse/contracts';
import { conflictError, err, unwrap } from '@teampulse/kernel';
import { emailTaken, teamNameTaken } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports.js';
import { Email } from '../../src/domain/email.js';
import { DEFAULT_ROTATION_POLICY, RefreshToken } from '../../src/domain/refresh-token.js';
import type { Team } from '../../src/domain/team.js';
import { DEFAULT_LOCKOUT_POLICY, User } from '../../src/domain/user.js';

export interface RepositoryFixture {
  readonly uow: UnitOfWork;
  /** Events written to the outbox so far. */
  readOutbox(): Promise<unknown[]>;
  /** Empties everything so each test starts clean. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const T0 = new Date('2026-11-20T08:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function makeUser(
  overrides: {
    email?: string;
    role?: 'employee' | 'manager' | 'admin';
    name?: string;
    createdAt?: Date;
  } = {},
): User {
  return User.create({
    id: uuid(),
    email: unwrap(Email.create(overrides.email ?? `u${counter + 1}@example.com`)),
    displayName: overrides.name ?? 'Test User',
    passwordHash: '$argon2id$v=19$stub',
    role: overrides.role ?? 'employee',
    now: overrides.createdAt ?? T0,
  });
}

const makeTeam = (managerUserId: string, name: string): Team => ({
  id: uuid(),
  name,
  managerUserId,
  createdAt: T0,
});

function makeToken(userId: string, familyId = uuid(), hash = `hash-${uuid()}`) {
  return RefreshToken.startFamily({
    id: uuid(),
    userId,
    familyId,
    tokenHash: hash,
    now: T0,
    policy: DEFAULT_ROTATION_POLICY,
  });
}

/**
 * The behaviour every persistence implementation must provide. Running one suite against the
 * in-memory fakes and against real PostgreSQL is what lets the use-case tests trust the fakes
 * (Liskov substitution made executable).
 */
export function repositoryContract(name: string, create: () => Promise<RepositoryFixture>): void {
  describe(`repository contract: ${name}`, () => {
    let fixture: RepositoryFixture;
    // Delegates to whatever unit of work the fixture currently holds: `reset()` may replace it.
    const uow: UnitOfWork = { run: (work) => fixture.uow.run(work) };

    const setup = create().then((f) => {
      fixture = f;
    });
    beforeEach(async () => {
      await setup;
      await fixture.reset();
    });
    afterAll(async () => {
      await setup;
      await fixture.close();
    });

    describe('users', () => {
      it('round-trips every field', async () => {
        const base = makeUser({ email: 'ada@example.com', name: 'Ada Lovelace', role: 'manager' });
        let locked = base;
        for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.maxFailedAttempts; i += 1) {
          locked = locked.registerFailedLogin(at(5), DEFAULT_LOCKOUT_POLICY);
        }
        expect((await uow.run((tx) => tx.users.insert(locked))).ok).toBe(true);

        const found = await uow.run((tx) => tx.users.findById(locked.id));
        expect(found).not.toBeNull();
        expect(found?.email.value).toBe('ada@example.com');
        expect(found?.displayName).toBe('Ada Lovelace');
        expect(found?.role).toBe('manager');
        expect(found?.status).toBe('active');
        expect(found?.passwordHash).toBe('$argon2id$v=19$stub');
        expect(found?.createdAt).toEqual(T0);
        expect(found?.lockedUntil).toEqual(locked.lockedUntil);
        expect(found?.failedLoginAttempts).toBe(0);
        expect(await uow.run((tx) => tx.users.findByEmail('ada@example.com'))).toMatchObject({
          id: locked.id,
        });
      });

      it('returns null for unknown ids and emails', async () => {
        expect(await uow.run((tx) => tx.users.findById(uuid()))).toBeNull();
        expect(await uow.run((tx) => tx.users.findByEmail('nobody@example.com'))).toBeNull();
        expect(await uow.run((tx) => tx.users.findByIdForUpdate(uuid()))).toBeNull();
      });

      it('reports a conflict, not an exception, for a duplicate email', async () => {
        await uow.run((tx) => tx.users.insert(makeUser({ email: 'dup@example.com' })));
        const second = await uow.run((tx) =>
          tx.users.insert(makeUser({ email: 'dup@example.com' })),
        );
        expect(second).toEqual(err(emailTaken()));
      });

      it('a duplicate email does not poison the surrounding transaction', async () => {
        await uow.run((tx) => tx.users.insert(makeUser({ email: 'dup@example.com' })));
        // In PostgreSQL a failed statement aborts the transaction; the outbox write after it
        // must still succeed and commit.
        await uow.run(async (tx) => {
          const dup = await tx.users.insert(makeUser({ email: 'dup@example.com' }));
          expect(dup.ok).toBe(false);
          await tx.outbox.append(
            createEvent('UserDeleted', {
              eventId: uuid(),
              occurredAt: T0,
              correlationId: uuid(),
              payload: { userId: uuid() },
            }),
          );
        });
        expect(await fixture.readOutbox()).toHaveLength(1);
      });

      it('persists updates', async () => {
        const user = makeUser();
        await uow.run((tx) => tx.users.insert(user));
        const changed = user.changePasswordHash('new-hash', at(60));
        await uow.run((tx) => tx.users.update(changed));
        const found = await uow.run((tx) => tx.users.findById(user.id));
        expect(found?.passwordHash).toBe('new-hash');
        expect(found?.updatedAt).toEqual(at(60));
      });

      it('lists in a stable order and pages with a keyset cursor, even with identical timestamps', async () => {
        const users = [0, 0, 0, 1, 2].map((s) => makeUser({ createdAt: at(s) }));
        for (const user of users) await uow.run((tx) => tx.users.insert(user));

        const expected = [...users].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
        );
        const collected: string[] = [];
        let after: { createdAt: Date; id: string } | undefined;
        for (;;) {
          const page = await uow.run((tx) =>
            tx.users.list({ limit: 2, ...(after === undefined ? {} : { after }) }),
          );
          collected.push(...page.map((u) => u.id));
          const last = page.at(-1);
          if (page.length < 2 || last === undefined) break;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(collected).toEqual(expected.map((u) => u.id));
      });

      it('counts only active administrators', async () => {
        await uow.run(async (tx) => {
          await tx.users.insert(makeUser({ role: 'admin' }));
          await tx.users.insert(makeUser({ role: 'admin' }));
          await tx.users.insert(makeUser({ role: 'manager' }));
          await tx.users.insert(makeUser({ role: 'employee' }));
        });
        expect(await uow.run((tx) => tx.users.countActiveAdmins())).toBe(2);
      });

      it('deleting a user removes their memberships and sessions', async () => {
        const manager = makeUser({ role: 'manager' });
        const member = makeUser();
        const team = makeTeam(manager.id, 'Alpha');
        await uow.run(async (tx) => {
          await tx.users.insert(manager);
          await tx.users.insert(member);
          await tx.teams.insert(team);
          await tx.teams.addMember(team.id, member.id, T0);
          await tx.tokens.insert(makeToken(member.id, uuid(), 'gone-with-user'));
        });

        await uow.run((tx) => tx.users.delete(member.id));

        expect(await uow.run((tx) => tx.users.findById(member.id))).toBeNull();
        expect(await uow.run((tx) => tx.teams.members(team.id))).toEqual([]);
        expect(await uow.run((tx) => tx.tokens.findByHashForUpdate('gone-with-user'))).toBeNull();
      });

      it('refuses to delete a user who still manages a team', async () => {
        const manager = makeUser({ role: 'manager' });
        await uow.run(async (tx) => {
          await tx.users.insert(manager);
          await tx.teams.insert(makeTeam(manager.id, 'Alpha'));
        });
        await expect(uow.run((tx) => tx.users.delete(manager.id))).rejects.toThrow();
        expect(await uow.run((tx) => tx.users.findById(manager.id))).not.toBeNull();
      });
    });

    describe('teams', () => {
      async function seed() {
        const manager = makeUser({ role: 'manager' });
        const alice = makeUser({ name: 'Alice' });
        const bob = makeUser({ name: 'Bob' });
        const alpha = makeTeam(manager.id, 'Alpha');
        const beta = makeTeam(manager.id, 'Beta');
        await uow.run(async (tx) => {
          for (const user of [manager, alice, bob]) await tx.users.insert(user);
          await tx.teams.insert(alpha);
          await tx.teams.insert(beta);
        });
        return { manager, alice, bob, alpha, beta };
      }

      it('stores and finds a team', async () => {
        const { alpha, manager } = await seed();
        expect(await uow.run((tx) => tx.teams.findById(alpha.id))).toEqual({
          id: alpha.id,
          name: 'Alpha',
          managerUserId: manager.id,
          createdAt: T0,
        });
        expect(await uow.run((tx) => tx.teams.findById(uuid()))).toBeNull();
      });

      it('rejects a duplicate name regardless of case, as a conflict', async () => {
        const { manager } = await seed();
        const dup = await uow.run((tx) => tx.teams.insert(makeTeam(manager.id, 'ALPHA')));
        expect(dup).toEqual(err(teamNameTaken()));
      });

      it('adds and removes members idempotently, reporting whether anything changed', async () => {
        const { alpha, alice } = await seed();
        expect(await uow.run((tx) => tx.teams.addMember(alpha.id, alice.id, T0))).toBe(true);
        expect(await uow.run((tx) => tx.teams.addMember(alpha.id, alice.id, T0))).toBe(false);
        expect(await uow.run((tx) => tx.teams.isMember(alpha.id, alice.id))).toBe(true);
        expect(await uow.run((tx) => tx.teams.removeMember(alpha.id, alice.id))).toBe(true);
        expect(await uow.run((tx) => tx.teams.removeMember(alpha.id, alice.id))).toBe(false);
        expect(await uow.run((tx) => tx.teams.isMember(alpha.id, alice.id))).toBe(false);
      });

      it('lists members by name, and teams with their member counts', async () => {
        const { alpha, beta, alice, bob } = await seed();
        await uow.run(async (tx) => {
          await tx.teams.addMember(alpha.id, bob.id, T0);
          await tx.teams.addMember(alpha.id, alice.id, T0);
        });
        expect(
          (await uow.run((tx) => tx.teams.members(alpha.id))).map((m) => m.displayName),
        ).toEqual(['Alice', 'Bob']);

        const all = await uow.run((tx) => tx.teams.listAll());
        expect(all.map((s) => [s.team.name, s.memberCount])).toEqual([
          ['Alpha', 2],
          ['Beta', 0],
        ]);
        expect(beta.name).toBe('Beta');
      });

      it('answers which teams a user belongs to, manages, or can see', async () => {
        const { manager, alice, alpha, beta } = await seed();
        await uow.run((tx) => tx.teams.addMember(beta.id, alice.id, T0));

        expect(await uow.run((tx) => tx.teams.teamIdsOfMember(alice.id))).toEqual([beta.id]);
        expect(await uow.run((tx) => tx.teams.teamIdsManagedBy(manager.id))).toEqual(
          [alpha.id, beta.id].sort(),
        );
        expect(
          (await uow.run((tx) => tx.teams.listForUser(alice.id))).map((s) => s.team.name),
        ).toEqual(['Beta']);
        expect(
          (await uow.run((tx) => tx.teams.listForUser(manager.id))).map((s) => s.team.name),
        ).toEqual(['Alpha', 'Beta']);
      });
    });

    describe('refresh tokens', () => {
      async function seedUser() {
        const user = makeUser();
        await uow.run((tx) => tx.users.insert(user));
        return user;
      }

      it('round-trips a token by its hash', async () => {
        const user = await seedUser();
        const token = makeToken(user.id, uuid(), 'the-hash');
        await uow.run((tx) => tx.tokens.insert(token));

        const found = await uow.run((tx) => tx.tokens.findByHashForUpdate('the-hash'));
        expect(found).toMatchObject({
          id: token.id,
          userId: user.id,
          familyId: token.familyId,
          familyStartedAt: T0,
          expiresAt: token.expiresAt,
          revokedAt: null,
          replacedById: null,
        });
        expect(await uow.run((tx) => tx.tokens.findByHashForUpdate('other'))).toBeNull();
      });

      it('persists rotation', async () => {
        const user = await seedUser();
        const token = makeToken(user.id, uuid(), 'h1');
        await uow.run((tx) => tx.tokens.insert(token));
        const successorId = uuid();
        await uow.run((tx) => tx.tokens.update(token.rotateTo(successorId, at(30))));

        const found = await uow.run((tx) => tx.tokens.findByHashForUpdate('h1'));
        expect(found?.revokedAt).toEqual(at(30));
        expect(found?.replacedById).toBe(successorId);
      });

      it('revokes a whole family but only once, preserving the original revocation time', async () => {
        const user = await seedUser();
        const family = uuid();
        await uow.run(async (tx) => {
          await tx.tokens.insert(makeToken(user.id, family, 'a'));
          await tx.tokens.insert(makeToken(user.id, family, 'b'));
          await tx.tokens.insert(makeToken(user.id, uuid(), 'other-family'));
        });

        await uow.run((tx) => tx.tokens.revokeFamily(family, at(10)));
        await uow.run((tx) => tx.tokens.revokeFamily(family, at(99)));

        const revoked = async (hash: string) =>
          (await uow.run((tx) => tx.tokens.findByHashForUpdate(hash)))?.revokedAt ?? null;
        expect(await revoked('a')).toEqual(at(10));
        expect(await revoked('b')).toEqual(at(10));
        expect(await revoked('other-family')).toBeNull();
      });

      it('revokes every session of a user', async () => {
        const user = await seedUser();
        const other = await seedUser();
        await uow.run(async (tx) => {
          await tx.tokens.insert(makeToken(user.id, uuid(), 'u1'));
          await tx.tokens.insert(makeToken(user.id, uuid(), 'u2'));
          await tx.tokens.insert(makeToken(other.id, uuid(), 'o1'));
        });
        await uow.run((tx) => tx.tokens.revokeAllForUser(user.id, at(5)));

        const isRevoked = async (hash: string) =>
          (await uow.run((tx) => tx.tokens.findByHashForUpdate(hash)))?.isRevoked;
        expect([await isRevoked('u1'), await isRevoked('u2'), await isRevoked('o1')]).toEqual([
          true,
          true,
          false,
        ]);
      });
    });

    describe('unit of work', () => {
      const event = () =>
        createEvent('UserDeleted', {
          eventId: uuid(),
          occurredAt: T0,
          correlationId: uuid(),
          payload: { userId: uuid() },
        });

      it('commits the change and its outbox event together', async () => {
        const user = makeUser();
        await uow.run(async (tx) => {
          await tx.users.insert(user);
          await tx.outbox.append(event());
        });
        expect(await uow.run((tx) => tx.users.findById(user.id))).not.toBeNull();
        expect(await fixture.readOutbox()).toHaveLength(1);
      });

      it('rolls everything back when the work throws', async () => {
        const user = makeUser();
        await expect(
          uow.run(async (tx) => {
            await tx.users.insert(user);
            await tx.outbox.append(event());
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await uow.run((tx) => tx.users.findById(user.id))).toBeNull();
        expect(await fixture.readOutbox()).toHaveLength(0);
      });

      it('commits even when the work returns a failed Result (a recorded failure, such as a failed login)', async () => {
        const user = makeUser();
        await uow.run((tx) => tx.users.insert(user));
        const failed = user.registerFailedLogin(at(1), DEFAULT_LOCKOUT_POLICY);
        await uow.run(async (tx) => {
          await tx.users.update(failed);
          return err(conflictError('x', 'y'));
        });
        expect((await uow.run((tx) => tx.users.findById(user.id)))?.failedLoginAttempts).toBe(1);
      });
    });
  });
}
