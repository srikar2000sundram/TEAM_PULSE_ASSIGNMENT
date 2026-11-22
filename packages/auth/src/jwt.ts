import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@teampulse/contracts';
import { err, ok, unauthorizedError, SystemClock, type Clock } from '@teampulse/kernel';
import type { AccessTokenVerifier, Principal } from './principal.js';

/** Accepting only one algorithm blocks algorithm-confusion attacks (for example `alg: none`). */
export const ACCESS_TOKEN_ALGORITHM = 'RS256';

export interface VerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Allowed clock difference between services, in seconds. */
  readonly clockToleranceSeconds?: number;
  readonly clock?: Clock;
}

export function principalFromClaims(claims: AccessTokenClaims): Principal {
  return {
    userId: claims.sub,
    role: claims.role,
    teamIds: claims.teams,
    managedTeamIds: claims.managedTeams,
  };
}

function createVerifier(getKey: JWTVerifyGetKey, options: VerifierOptions): AccessTokenVerifier {
  const clock = options.clock ?? new SystemClock();
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          issuer: options.issuer,
          audience: options.audience,
          clockTolerance: options.clockToleranceSeconds ?? 5,
          currentDate: clock.now(),
          requiredClaims: ['sub', 'exp', 'iat', 'jti'],
        });
        const claims = accessTokenClaimsSchema.safeParse(payload);
        if (!claims.success) return err(unauthorizedError('auth.invalid_token', 'Invalid token'));
        return ok(principalFromClaims(claims.data));
      } catch {
        // Expired, wrong signature, wrong issuer, malformed: all look the same to the caller,
        // so error text cannot be used to probe the verification logic.
        return err(unauthorizedError('auth.invalid_token', 'Invalid or expired token'));
      }
    },
  };
}

/**
 * Verifies tokens against a JWKS endpoint (Identity Service). Keys are cached and refreshed
 * when an unknown `kid` appears, which is what makes key rotation seamless.
 */
export function createRemoteJwksVerifier(
  jwksUrl: URL,
  options: VerifierOptions,
): AccessTokenVerifier {
  const getKey = createRemoteJWKSet(jwksUrl, {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return createVerifier(getKey, options);
}

/** Verifies against a key set held in memory. Used in tests and by the issuer itself. */
export function createLocalJwksVerifier(
  jwks: JSONWebKeySet,
  options: VerifierOptions,
): AccessTokenVerifier {
  return createVerifier(createLocalJWKSet(jwks), options);
}
