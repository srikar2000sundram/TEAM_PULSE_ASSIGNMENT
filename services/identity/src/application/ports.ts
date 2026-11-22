import type { Cursor, Result } from '@teampulse/kernel';
import type { Outbox } from '@teampulse/outbox';
import type { RefreshToken } from '../domain/refresh-token.js';
import type { Team, TeamMember, TeamSummary } from '../domain/team.js';
import type { User } from '../domain/user.js';

/* -------------------------------------------------------------------------------------------
 * Ports: everything the application core needs from the outside world, as interfaces it owns.
 * Adapters implement them; the core never imports an adapter (enforced by ESLint).
 * ----------------------------------------------------------------------------------------- */

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AccessTokenSubject {
  readonly user: User;
  readonly teamIds: readonly string[];
  readonly managedTeamIds: readonly string[];
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface AccessTokenIssuer {
  issue(subject: AccessTokenSubject): Promise<IssuedAccessToken>;
}

/** Opaque refresh-token secrets. Only the hash is ever persisted. */
export interface OpaqueTokens {
  generate(): { readonly secret: string; readonly hash: string };
  hash(secret: string): string;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /**
   * Same as `findById` but locks the row until the transaction ends, so concurrent failed logins
   * are counted one after another instead of overwriting each other's counter.
   */
  findByIdForUpdate(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Fails with a `conflict` error when the email is already registered. */
  insert(user: User): Promise<Result<void>>;
  update(user: User): Promise<void>;
  delete(id: string): Promise<void>;
  /** Keyset pagination ordered by (createdAt, id). */
  list(options: { limit: number; after?: Cursor }): Promise<readonly User[]>;
  countActiveAdmins(): Promise<number>;
}

export interface TeamRepository {
  findById(id: string): Promise<Team | null>;
  /** Fails with a `conflict` error when the (case-insensitive) name is taken. */
  insert(team: Team): Promise<Result<void>>;
  listAll(): Promise<readonly TeamSummary[]>;
  /** Teams the user belongs to or manages. */
  listForUser(userId: string): Promise<readonly TeamSummary[]>;
  teamIdsOfMember(userId: string): Promise<readonly string[]>;
  teamIdsManagedBy(userId: string): Promise<readonly string[]>;
  isMember(teamId: string, userId: string): Promise<boolean>;
  members(teamId: string): Promise<readonly TeamMember[]>;
  /** Returns true when the membership was created, false when it already existed. */
  addMember(teamId: string, userId: string, now: Date): Promise<boolean>;
  /** Returns true when a membership was removed, false when there was none. */
  removeMember(teamId: string, userId: string): Promise<boolean>;
}

export interface RefreshTokenRepository {
  insert(token: RefreshToken): Promise<void>;
  /** Locks the row, so two simultaneous refreshes of one token cannot both succeed. */
  findByHashForUpdate(tokenHash: string): Promise<RefreshToken | null>;
  update(token: RefreshToken): Promise<void>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeAllForUser(userId: string, now: Date): Promise<void>;
}

export interface Transaction {
  readonly users: UserRepository;
  readonly teams: TeamRepository;
  readonly tokens: RefreshTokenRepository;
  readonly outbox: Outbox;
}

/**
 * Runs `work` atomically. The transaction commits when `work` returns, **even if it returns a
 * failed Result**, because some failures must be recorded (a wrong password increments the
 * lockout counter). It rolls back only when `work` throws.
 */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
