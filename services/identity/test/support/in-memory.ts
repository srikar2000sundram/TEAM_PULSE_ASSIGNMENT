import { createHash } from 'node:crypto';
import type { TeamPulseEvent } from '@teampulse/contracts';
import type { Outbox } from '@teampulse/outbox';
import { err, ok, type Cursor, type Result } from '@teampulse/kernel';
import { emailTaken, teamNameTaken } from '../../src/application/errors.js';
import type {
  AccessTokenIssuer,
  AccessTokenSubject,
  IssuedAccessToken,
  OpaqueTokens,
  PasswordHasher,
  RefreshTokenRepository,
  TeamRepository,
  Transaction,
  UnitOfWork,
  UserRepository,
} from '../../src/application/ports.js';
import type { RefreshToken } from '../../src/domain/refresh-token.js';
import type { Team, TeamMember, TeamSummary } from '../../src/domain/team.js';
import type { User } from '../../src/domain/user.js';

/**
 * In-memory adapters used by unit tests. They enforce the same constraints as the SQL schema
 * (unique email, unique team name, cascade deletes, restrict on managers), and the shared
 * repository contract suite runs against both this and PostgreSQL, so the two cannot drift.
 */
export class InMemoryStore {
  users = new Map<string, User>();
  teams = new Map<string, Team>();
  /** key: `${teamId}|${userId}` */
  members = new Map<string, Date>();
  tokens = new Map<string, RefreshToken>();
  outbox: TeamPulseEvent[] = [];

  snapshot() {
    return {
      users: new Map(this.users),
      teams: new Map(this.teams),
      members: new Map(this.members),
      tokens: new Map(this.tokens),
      outbox: [...this.outbox],
    };
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>): void {
    this.users = snapshot.users;
    this.teams = snapshot.teams;
    this.members = snapshot.members;
    this.tokens = snapshot.tokens;
    this.outbox = snapshot.outbox;
  }
}

class InMemoryUsers implements UserRepository {
  constructor(private readonly store: InMemoryStore) {}

  findById(id: string) {
    return Promise.resolve(this.store.users.get(id) ?? null);
  }
  findByIdForUpdate(id: string) {
    return this.findById(id);
  }
  findByEmail(email: string) {
    const found = [...this.store.users.values()].find((user) => user.email.value === email);
    return Promise.resolve(found ?? null);
  }
  insert(user: User): Promise<Result<void>> {
    if ([...this.store.users.values()].some((u) => u.email.equals(user.email))) {
      return Promise.resolve(err(emailTaken()));
    }
    this.store.users.set(user.id, user);
    return Promise.resolve(ok(undefined));
  }
  update(user: User) {
    this.store.users.set(user.id, user);
    return Promise.resolve();
  }
  delete(id: string) {
    if ([...this.store.teams.values()].some((team) => team.managerUserId === id)) {
      throw new Error('foreign key violation: user still manages a team');
    }
    this.store.users.delete(id);
    for (const key of [...this.store.members.keys()]) {
      if (key.endsWith(`|${id}`)) this.store.members.delete(key);
    }
    for (const [hash, token] of this.store.tokens) {
      if (token.userId === id) this.store.tokens.delete(hash);
    }
    return Promise.resolve();
  }
  list(options: { limit: number; after?: Cursor }) {
    const sorted = [...this.store.users.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const after = options.after;
    const page =
      after === undefined
        ? sorted
        : sorted.filter(
            (user) =>
              user.createdAt.getTime() > after.createdAt.getTime() ||
              (user.createdAt.getTime() === after.createdAt.getTime() && user.id > after.id),
          );
    return Promise.resolve(page.slice(0, options.limit));
  }
  countActiveAdmins() {
    return Promise.resolve(
      [...this.store.users.values()].filter((u) => u.role === 'admin' && u.isActive).length,
    );
  }
}

class InMemoryTeams implements TeamRepository {
  constructor(private readonly store: InMemoryStore) {}

  private summary(team: Team): TeamSummary {
    const memberCount = [...this.store.members.keys()].filter((key) =>
      key.startsWith(`${team.id}|`),
    ).length;
    return { team, memberCount };
  }

  findById(id: string) {
    return Promise.resolve(this.store.teams.get(id) ?? null);
  }
  insert(team: Team): Promise<Result<void>> {
    const taken = [...this.store.teams.values()].some(
      (t) => t.name.toLowerCase() === team.name.toLowerCase(),
    );
    if (taken) return Promise.resolve(err(teamNameTaken()));
    this.store.teams.set(team.id, team);
    return Promise.resolve(ok(undefined));
  }
  listAll() {
    return Promise.resolve(
      [...this.store.teams.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((team) => this.summary(team)),
    );
  }
  listForUser(userId: string) {
    return Promise.resolve(
      [...this.store.teams.values()]
        .filter(
          (team) => team.managerUserId === userId || this.store.members.has(`${team.id}|${userId}`),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((team) => this.summary(team)),
    );
  }
  teamIdsOfMember(userId: string) {
    return Promise.resolve(
      [...this.store.members.keys()]
        .filter((key) => key.endsWith(`|${userId}`))
        .map((key) => key.split('|')[0] ?? '')
        .sort(),
    );
  }
  teamIdsManagedBy(userId: string) {
    return Promise.resolve(
      [...this.store.teams.values()]
        .filter((team) => team.managerUserId === userId)
        .map((team) => team.id)
        .sort(),
    );
  }
  isMember(teamId: string, userId: string) {
    return Promise.resolve(this.store.members.has(`${teamId}|${userId}`));
  }
  members(teamId: string): Promise<readonly TeamMember[]> {
    return Promise.resolve(
      [...this.store.members.keys()]
        .filter((key) => key.startsWith(`${teamId}|`))
        .flatMap((key) => {
          const user = this.store.users.get(key.split('|')[1] ?? '');
          return user === undefined ? [] : [{ id: user.id, displayName: user.displayName }];
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    );
  }
  addMember(teamId: string, userId: string, now: Date) {
    const key = `${teamId}|${userId}`;
    if (this.store.members.has(key)) return Promise.resolve(false);
    this.store.members.set(key, now);
    return Promise.resolve(true);
  }
  removeMember(teamId: string, userId: string) {
    return Promise.resolve(this.store.members.delete(`${teamId}|${userId}`));
  }
}

class InMemoryTokens implements RefreshTokenRepository {
  constructor(private readonly store: InMemoryStore) {}

  insert(token: RefreshToken) {
    this.store.tokens.set(token.tokenHash, token);
    return Promise.resolve();
  }
  findByHashForUpdate(tokenHash: string) {
    return Promise.resolve(this.store.tokens.get(tokenHash) ?? null);
  }
  update(token: RefreshToken) {
    this.store.tokens.set(token.tokenHash, token);
    return Promise.resolve();
  }
  revokeFamily(familyId: string, now: Date) {
    for (const [hash, token] of this.store.tokens) {
      if (token.familyId === familyId) this.store.tokens.set(hash, token.revoke(now));
    }
    return Promise.resolve();
  }
  revokeAllForUser(userId: string, now: Date) {
    for (const [hash, token] of this.store.tokens) {
      if (token.userId === userId) this.store.tokens.set(hash, token.revoke(now));
    }
    return Promise.resolve();
  }
}

class InMemoryOutbox implements Outbox {
  constructor(private readonly store: InMemoryStore) {}
  append(event: TeamPulseEvent) {
    this.store.outbox.push(event);
    return Promise.resolve();
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store: InMemoryStore = new InMemoryStore()) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    const tx: Transaction = {
      users: new InMemoryUsers(this.store),
      teams: new InMemoryTeams(this.store),
      tokens: new InMemoryTokens(this.store),
      outbox: new InMemoryOutbox(this.store),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.store.restore(before); // roll back only when the work throws
      throw error;
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Fast, deterministic fakes for the security ports.                                           */

/** Not a real hash: just reversible and instant, and it records how often it was asked to verify. */
export class FakePasswordHasher implements PasswordHasher {
  verifyCalls: { hash: string; password: string }[] = [];
  hashCalls: string[] = [];

  hash(password: string) {
    this.hashCalls.push(password);
    return Promise.resolve(`fakehash:${password}`);
  }
  verify(hash: string, password: string) {
    this.verifyCalls.push({ hash, password });
    return Promise.resolve(hash === `fakehash:${password}`);
  }
}

export class FakeAccessTokenIssuer implements AccessTokenIssuer {
  issued: AccessTokenSubject[] = [];

  issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    this.issued.push(subject);
    return Promise.resolve({ token: `access-token-for-${subject.user.id}`, expiresInSeconds: 900 });
  }
}

export class FakeOpaqueTokens implements OpaqueTokens {
  private counter = 0;

  generate() {
    this.counter += 1;
    const secret = `refresh-secret-${this.counter}`;
    return { secret, hash: this.hash(secret) };
  }
  hash(secret: string) {
    return createHash('sha256').update(secret).digest('hex');
  }
}
