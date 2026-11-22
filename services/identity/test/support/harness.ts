import type { Principal } from '@teampulse/auth';
import type { Role } from '@teampulse/contracts';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createUseCases } from '../../src/application/index.js';
import { Email } from '../../src/domain/email.js';
import { DEFAULT_ROTATION_POLICY } from '../../src/domain/refresh-token.js';
import type { Team } from '../../src/domain/team.js';
import { DEFAULT_LOCKOUT_POLICY, User } from '../../src/domain/user.js';
import {
  FakeAccessTokenIssuer,
  FakeOpaqueTokens,
  FakePasswordHasher,
  InMemoryUnitOfWork,
} from './in-memory.js';

export const START = '2026-11-20T08:00:00Z';
export const GOOD_PASSWORD = 'correct-horse-battery';

/** The whole application wired to in-memory adapters and fakes. No I/O, so tests run in ms. */
export function buildHarness() {
  const clock = new FixedClock(START);
  const ids = new SequentialIdGenerator();
  const uow = new InMemoryUnitOfWork();
  const hasher = new FakePasswordHasher();
  const tokenIssuer = new FakeAccessTokenIssuer();
  const opaqueTokens = new FakeOpaqueTokens();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'identity-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });
  const lockout = DEFAULT_LOCKOUT_POLICY;
  const rotation = DEFAULT_ROTATION_POLICY;
  const decoyPasswordHash = 'fakehash:decoy-password-nobody-knows';

  const app = createUseCases({
    uow,
    hasher,
    tokenIssuer,
    opaqueTokens,
    clock,
    ids,
    logger,
    lockout,
    rotation,
    decoyPasswordHash,
  });

  /** Inserts a user directly, bypassing use cases (and their authorization). */
  async function seedUser(
    options: {
      email?: string;
      role?: Role;
      password?: string;
      displayName?: string;
      disabled?: boolean;
    } = {},
  ): Promise<User> {
    const email = unwrap(Email.create(options.email ?? `user${ids.next().slice(-4)}@example.com`));
    const user = User.create({
      id: ids.next(),
      email,
      displayName: options.displayName ?? 'Test User',
      passwordHash: await hasher.hash(options.password ?? GOOD_PASSWORD),
      role: options.role ?? 'employee',
      now: clock.now(),
    });
    await uow.run((tx) => tx.users.insert(user));
    if (options.disabled === true) {
      const disabled = User.restore({ ...propsOf(user), status: 'disabled' });
      await uow.run((tx) => tx.users.update(disabled));
      return disabled;
    }
    return user;
  }

  async function seedTeam(manager: User, name = 'Platform'): Promise<Team> {
    const team: Team = { id: ids.next(), name, managerUserId: manager.id, createdAt: clock.now() };
    await uow.run((tx) => tx.teams.insert(team));
    return team;
  }

  /** What the caller's access token would claim right now. */
  async function principalOf(user: User): Promise<Principal> {
    return uow.run(async (tx) => ({
      userId: user.id,
      role: user.role,
      teamIds: await tx.teams.teamIdsOfMember(user.id),
      managedTeamIds: await tx.teams.teamIdsManagedBy(user.id),
    }));
  }

  const records = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    app,
    clock,
    ids,
    uow,
    hasher,
    tokenIssuer,
    opaqueTokens,
    logLines,
    records,
    lockout,
    rotation,
    seedUser,
    seedTeam,
    principalOf,
  };
}

export type Harness = ReturnType<typeof buildHarness>;

/** Re-exposes the user's properties; `User` hides them behind getters. */
function propsOf(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    passwordHash: user.passwordHash,
    role: user.role,
    status: user.status,
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
