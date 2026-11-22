import {
  forbiddenError,
  notFoundError,
  ok,
  err,
  type AppError,
  type Result,
} from '@teampulse/kernel';
import type { Role } from '@teampulse/contracts';

/** The authenticated caller, derived from a verified access token. Never built from request input. */
export interface Principal {
  readonly userId: string;
  readonly role: Role;
  readonly teamIds: readonly string[];
  readonly managedTeamIds: readonly string[];
}

/** Port used by every service's HTTP layer to turn a bearer token into a Principal. */
export interface AccessTokenVerifier {
  verify(token: string): Promise<Result<Principal>>;
}

export const hasRole = (principal: Principal, ...allowed: readonly Role[]): boolean =>
  allowed.includes(principal.role);

export const isSelf = (principal: Principal, userId: string): boolean =>
  principal.userId === userId;

export const isMemberOf = (principal: Principal, teamId: string): boolean =>
  principal.teamIds.includes(teamId);

export const managesTeam = (principal: Principal, teamId: string): boolean =>
  principal.managedTeamIds.includes(teamId);

/** Layer 2 of the authorization model: is this role allowed to call this operation at all? */
export function requireRole(
  principal: Principal,
  ...allowed: readonly Role[]
): Result<Principal, AppError> {
  return hasRole(principal, ...allowed) ? ok(principal) : err(forbiddenError());
}

/**
 * Layer 3 helper for resources that must stay undiscoverable (for example another person's
 * private habit): the caller gets "not found", never "forbidden", so existence is not revealed.
 */
export function hideUnless(
  allowed: boolean,
  code: string,
  message: string,
): Result<true, AppError> {
  return allowed ? ok(true) : err(notFoundError(code, message));
}
