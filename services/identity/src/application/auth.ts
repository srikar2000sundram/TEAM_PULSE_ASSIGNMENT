import type { Principal } from '@teampulse/auth';
import {
  conflictError,
  err,
  ok,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { Email } from '../domain/email.js';
import { validateNewPassword } from '../domain/password-policy.js';
import { RefreshToken, type RotationPolicy } from '../domain/refresh-token.js';
import type { LockoutPolicy, User } from '../domain/user.js';
import type { AccessTokenIssuer, OpaqueTokens, PasswordHasher, UnitOfWork } from './ports.js';
import {
  credentialFor,
  invalidCredentials,
  invalidRefreshToken,
  issueAccessToken,
  type RefreshCredential,
  type SessionTokens,
} from './support.js';

export interface Session extends SessionTokens {
  readonly user: User;
  readonly refresh: RefreshCredential;
}

/* ------------------------------------------------------------------------------------------ */

export interface LoginDeps {
  readonly uow: UnitOfWork;
  readonly hasher: PasswordHasher;
  readonly tokenIssuer: AccessTokenIssuer;
  readonly opaqueTokens: OpaqueTokens;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly lockout: LockoutPolicy;
  readonly rotation: RotationPolicy;
  /**
   * A real hash of a random password, computed once at startup. Verifying against it when the
   * account does not exist makes unknown-email and wrong-password take the same time, so response
   * timing cannot be used to discover which emails are registered.
   */
  readonly decoyPasswordHash: string;
}

export class Login {
  constructor(private readonly deps: LoginDeps) {}

  async execute(input: { email: string; password: string }): Promise<Result<Session>> {
    const { uow, hasher, clock, logger } = this.deps;
    const email = Email.create(input.email);
    if (!email.ok) {
      await hasher.verify(this.deps.decoyPasswordHash, input.password);
      return err(invalidCredentials());
    }

    // Slow password hashing happens outside any database transaction, so no connection or row
    // lock is held while we wait on the CPU.
    const found = await uow.run((tx) => tx.users.findByEmail(email.value.value));
    const now = clock.now();

    if (found === null) {
      await hasher.verify(this.deps.decoyPasswordHash, input.password);
      logger.warn({ event: 'auth.login.failed', reason: 'unknown_user' }, 'login failed');
      return err(invalidCredentials());
    }

    if (!found.canLogin(now)) {
      await hasher.verify(this.deps.decoyPasswordHash, input.password);
      logger.warn(
        {
          event: 'auth.login.failed',
          reason: found.isActive ? 'locked' : 'disabled',
          userId: found.id,
        },
        'login failed',
      );
      return err(invalidCredentials());
    }

    const passwordOk = await hasher.verify(found.passwordHash, input.password);

    return uow.run(async (tx) => {
      // Re-read under a row lock and apply the change to the fresh state: parallel guesses are
      // then counted one after another, so they cannot slip past the lockout.
      const user = await tx.users.findByIdForUpdate(found.id);
      if (user === null) return err(invalidCredentials());

      if (!passwordOk) {
        const updated = user.registerFailedLogin(now, this.deps.lockout);
        await tx.users.update(updated);
        logger.warn(
          {
            event: 'auth.login.failed',
            reason: 'bad_password',
            userId: user.id,
            locked: updated.isLocked(now),
          },
          'login failed',
        );
        return err(invalidCredentials());
      }

      const loggedIn = user.registerSuccessfulLogin(now);
      if (loggedIn !== user) await tx.users.update(loggedIn);

      const { secret, hash } = this.deps.opaqueTokens.generate();
      const refreshToken = RefreshToken.startFamily({
        id: this.deps.ids.next(),
        userId: user.id,
        familyId: this.deps.ids.next(),
        tokenHash: hash,
        now,
        policy: this.deps.rotation,
      });
      await tx.tokens.insert(refreshToken);

      const access = await issueAccessToken(tx, this.deps.tokenIssuer, loggedIn);
      logger.info({ event: 'auth.login.succeeded', userId: user.id }, 'login succeeded');
      return ok({ ...access, user: loggedIn, refresh: credentialFor(secret, refreshToken) });
    });
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface RefreshDeps {
  readonly uow: UnitOfWork;
  readonly tokenIssuer: AccessTokenIssuer;
  readonly opaqueTokens: OpaqueTokens;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly rotation: RotationPolicy;
}

/**
 * Exchanges a refresh token for a new access token and a new refresh token (rotation).
 * Presenting an already-used token is treated as theft: the whole family is revoked.
 */
export class RefreshSession {
  constructor(private readonly deps: RefreshDeps) {}

  async execute(input: { refreshToken: string }): Promise<Result<Session>> {
    const { uow, clock, logger, rotation } = this.deps;
    const now = clock.now();
    const tokenHash = this.deps.opaqueTokens.hash(input.refreshToken);

    return uow.run(async (tx) => {
      const current = await tx.tokens.findByHashForUpdate(tokenHash);
      if (current === null) return err(invalidRefreshToken());

      if (current.isRevoked) {
        if (current.wasJustRotated(now, rotation)) {
          // Two tabs refreshed at once. Not an attack: ask the loser to retry with the new cookie.
          return err(
            conflictError('auth.refresh_race', 'The session was just refreshed, retry the request'),
          );
        }
        // A used token came back later: someone other than the legitimate client holds it.
        await tx.tokens.revokeFamily(current.familyId, now);
        logger.warn(
          { event: 'auth.refresh.reuse_detected', userId: current.userId },
          'refresh token reuse detected, session family revoked',
        );
        return err(invalidRefreshToken());
      }

      if (current.isExpired(now) || current.isFamilyTooOld(now, rotation)) {
        return err(invalidRefreshToken());
      }

      const user = await tx.users.findById(current.userId);
      if (user === null || !user.isActive) {
        await tx.tokens.revokeFamily(current.familyId, now);
        return err(invalidRefreshToken());
      }

      const { secret, hash } = this.deps.opaqueTokens.generate();
      const successor = current.successor({
        id: this.deps.ids.next(),
        tokenHash: hash,
        now,
        policy: rotation,
      });
      await tx.tokens.update(current.rotateTo(successor.id, now));
      await tx.tokens.insert(successor);

      const access = await issueAccessToken(tx, this.deps.tokenIssuer, user);
      return ok({ ...access, user, refresh: credentialFor(secret, successor) });
    });
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface LogoutDeps {
  readonly uow: UnitOfWork;
  readonly opaqueTokens: OpaqueTokens;
  readonly clock: Clock;
}

/** Ends the session. Always succeeds, so it cannot be used to probe which tokens exist. */
export class Logout {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(input: { refreshToken: string | undefined }): Promise<Result<void>> {
    if (input.refreshToken === undefined) return ok(undefined);
    const tokenHash = this.deps.opaqueTokens.hash(input.refreshToken);
    const now = this.deps.clock.now();
    await this.deps.uow.run(async (tx) => {
      const token = await tx.tokens.findByHashForUpdate(tokenHash);
      if (token !== null) await tx.tokens.revokeFamily(token.familyId, now);
    });
    return ok(undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface ChangePasswordDeps {
  readonly uow: UnitOfWork;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly lockout: LockoutPolicy;
}

export class ChangePassword {
  constructor(private readonly deps: ChangePasswordDeps) {}

  async execute(input: {
    actor: Principal;
    currentPassword: string;
    newPassword: string;
  }): Promise<Result<void>> {
    const { uow, hasher, clock, logger } = this.deps;
    const now = clock.now();

    const found = await uow.run((tx) => tx.users.findById(input.actor.userId));
    if (found === null || !found.isActive) return err(invalidCredentials());

    const policy = validateNewPassword(input.newPassword, found.email);
    if (!policy.ok) return policy;

    const currentOk = await hasher.verify(found.passwordHash, input.currentPassword);
    const newHash = currentOk ? await hasher.hash(input.newPassword) : '';

    return uow.run(async (tx) => {
      const user = await tx.users.findByIdForUpdate(found.id);
      if (user === null) return err(invalidCredentials());

      if (!currentOk) {
        // A stolen access token must not be a free oracle for guessing the current password.
        await tx.users.update(user.registerFailedLogin(now, this.deps.lockout));
        logger.warn(
          { event: 'auth.password_change.failed', userId: user.id },
          'password change failed',
        );
        return err(invalidCredentials());
      }

      await tx.users.update(user.changePasswordHash(newHash, now));
      // Changing the password signs the user out everywhere, including whoever else had access.
      await tx.tokens.revokeAllForUser(user.id, now);
      logger.info({ event: 'auth.password_changed', userId: user.id }, 'password changed');
      return ok(undefined);
    });
  }
}
