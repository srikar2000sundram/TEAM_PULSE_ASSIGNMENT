import type { Role } from '@teampulse/contracts';
import type { Email } from './email.js';

export type UserStatus = 'active' | 'disabled';

/** Brute-force protection settings. Injected, so tests and operators can tune them. */
export interface LockoutPolicy {
  readonly maxFailedAttempts: number;
  readonly lockoutMs: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  maxFailedAttempts: 5,
  lockoutMs: 15 * 60_000,
};

export interface UserProps {
  readonly id: string;
  readonly email: Email;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Immutable: every change returns a new User. That makes state transitions explicit, easy to
 * test, and safe to hold in a repository without accidental shared mutation.
 */
export class User {
  private constructor(private readonly props: UserProps) {}

  static create(
    input: Pick<UserProps, 'id' | 'email' | 'displayName' | 'passwordHash' | 'role'> & {
      now: Date;
    },
  ): User {
    return new User({
      id: input.id,
      email: input.email,
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
      role: input.role,
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuilds a user from stored state. Used by repositories only. */
  static restore(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }
  get email(): Email {
    return this.props.email;
  }
  get displayName(): string {
    return this.props.displayName;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get role(): Role {
    return this.props.role;
  }
  get status(): UserStatus {
    return this.props.status;
  }
  get failedLoginAttempts(): number {
    return this.props.failedLoginAttempts;
  }
  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isActive(): boolean {
    return this.props.status === 'active';
  }

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && this.props.lockedUntil.getTime() > now.getTime();
  }

  /** Whether a login attempt may even be evaluated: active and not currently locked. */
  canLogin(now: Date): boolean {
    return this.isActive && !this.isLocked(now);
  }

  /** Counts a wrong password. Reaching the limit locks the account and restarts the counter. */
  registerFailedLogin(now: Date, policy: LockoutPolicy): User {
    const attempts = this.props.failedLoginAttempts + 1;
    if (attempts >= policy.maxFailedAttempts) {
      return this.with({
        failedLoginAttempts: 0,
        lockedUntil: new Date(now.getTime() + policy.lockoutMs),
        updatedAt: now,
      });
    }
    return this.with({ failedLoginAttempts: attempts, updatedAt: now });
  }

  /** Clears the failure counter and any expired lock after a correct password. */
  registerSuccessfulLogin(now: Date): User {
    if (this.props.failedLoginAttempts === 0 && this.props.lockedUntil === null) return this;
    return this.with({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: now });
  }

  changeRole(role: Role, now: Date): User {
    return role === this.props.role ? this : this.with({ role, updatedAt: now });
  }

  disable(now: Date): User {
    return this.isActive ? this.with({ status: 'disabled', updatedAt: now }) : this;
  }

  /** Re-enabling also clears any lockout, so the person can sign in straight away. */
  enable(now: Date): User {
    return this.isActive
      ? this
      : this.with({ status: 'active', failedLoginAttempts: 0, lockedUntil: null, updatedAt: now });
  }

  changePasswordHash(passwordHash: string, now: Date): User {
    return this.with({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, updatedAt: now });
  }

  private with(changes: Partial<UserProps>): User {
    return new User({ ...this.props, ...changes });
  }
}
