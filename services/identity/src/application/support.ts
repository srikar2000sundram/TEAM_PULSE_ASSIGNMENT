import { requireRole, type Principal } from '@teampulse/auth';
import {
  err,
  forbiddenError,
  ok,
  unauthorizedError,
  type AppError,
  type Result,
} from '@teampulse/kernel';
import type { Role } from '@teampulse/contracts';
import type { RefreshToken } from '../domain/refresh-token.js';
import type { User } from '../domain/user.js';
import type { AccessTokenIssuer, Transaction } from './ports.js';

/** One generic message for every credential failure, so responses reveal nothing about accounts. */
export const invalidCredentials = (): AppError =>
  unauthorizedError('auth.invalid_credentials', 'The email or password is incorrect');

export const invalidRefreshToken = (): AppError =>
  unauthorizedError('auth.invalid_refresh_token', 'The session is no longer valid, sign in again');

/**
 * Authorization for administrative actions.
 * The role in the caller's token can be up to one access-token lifetime old, so a demoted or
 * disabled administrator must not keep working. We check the claim first (cheap, rejects obvious
 * misuse) and then confirm against the database (authoritative).
 */
export async function requireActiveActor(
  tx: Transaction,
  principal: Principal,
  ...allowed: readonly Role[]
): Promise<Result<User>> {
  const claim = requireRole(principal, ...allowed);
  if (!claim.ok) return claim;

  const actor = await tx.users.findById(principal.userId);
  if (actor === null || !actor.isActive || !allowed.includes(actor.role)) {
    return err(forbiddenError());
  }
  return ok(actor);
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/** Issues an access token with the user's *current* teams, so refreshing picks up changes. */
export async function issueAccessToken(
  tx: Transaction,
  issuer: AccessTokenIssuer,
  user: User,
): Promise<SessionTokens> {
  const [teamIds, managedTeamIds] = await Promise.all([
    tx.teams.teamIdsOfMember(user.id),
    tx.teams.teamIdsManagedBy(user.id),
  ]);
  const issued = await issuer.issue({ user, teamIds, managedTeamIds });
  return { accessToken: issued.token, expiresInSeconds: issued.expiresInSeconds };
}

export interface RefreshCredential {
  /** The secret to hand to the client (in a cookie). Never stored. */
  readonly secret: string;
  readonly expiresAt: Date;
}

export const credentialFor = (secret: string, token: RefreshToken): RefreshCredential => ({
  secret,
  expiresAt: token.expiresAt,
});
