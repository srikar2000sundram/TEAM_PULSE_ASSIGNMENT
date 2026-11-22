import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, type JSONWebKeySet } from 'jose';
import { ACCESS_TOKEN_ALGORITHM } from '@teampulse/auth/jwt';
import { accessTokenClaimsSchema } from '@teampulse/contracts';
import type { Clock, IdGenerator } from '@teampulse/kernel';
import type {
  AccessTokenIssuer,
  AccessTokenSubject,
  IssuedAccessToken,
} from '../../application/ports.js';

const MIN_RSA_BITS = 2048;

type PublicJwk = JsonWebKey & { kid: string; alg: string; use: 'sig' };

async function publicJwk(key: KeyObject): Promise<PublicJwk> {
  // `createPublicKey` derives a public key from a private one, but rejects a key that is already
  // public (the retired keys we are given for rotation).
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    ...jwk,
    kid: await calculateJwkThumbprint(jwk),
    alg: ACCESS_TOKEN_ALGORITHM,
    use: 'sig',
  };
}

function assertStrongRsa(key: KeyObject): void {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== 'rsa' || bits === undefined || bits < MIN_RSA_BITS) {
    throw new Error(`JWT keys must be RSA with at least ${MIN_RSA_BITS} bits`);
  }
}

/**
 * The signing key plus the public keys of recently retired signing keys.
 *
 * Rotation procedure, with no downtime and no forced logout:
 *   1. Generate a new key pair.
 *   2. Deploy with the new private key and the OLD public key in `previousPublicKeyPems`.
 *      New tokens carry the new `kid`; tokens signed by the old key still verify.
 *   3. After one access-token lifetime (15 minutes), drop the old public key.
 * Other services re-fetch the JWKS when they meet an unknown `kid`, so they follow along.
 */
export class KeyRing {
  private constructor(
    readonly signingKey: KeyObject,
    readonly keyId: string,
    private readonly keys: readonly PublicJwk[],
  ) {}

  static async fromPem(options: {
    privateKeyPem: string;
    previousPublicKeyPems?: readonly string[];
  }): Promise<KeyRing> {
    const signingKey = createPrivateKey(options.privateKeyPem);
    assertStrongRsa(signingKey);
    const current = await publicJwk(signingKey);

    const previous = await Promise.all(
      (options.previousPublicKeyPems ?? []).map(async (pem) => {
        const key = createPublicKey(pem);
        assertStrongRsa(key);
        return publicJwk(key);
      }),
    );
    // Dedupe by kid so re-listing the current key as "previous" is harmless.
    const all = [current, ...previous.filter((key) => key.kid !== current.kid)];
    return new KeyRing(signingKey, current.kid, all);
  }

  /** The public JSON Web Key Set served at `/.well-known/jwks.json`. Contains no private material. */
  jwks(): JSONWebKeySet {
    return { keys: this.keys.map((key) => ({ ...key })) };
  }
}

export interface IssuerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  constructor(
    private readonly keyRing: KeyRing,
    private readonly options: IssuerOptions,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const claims = {
      iss: this.options.issuer,
      aud: this.options.audience,
      sub: subject.user.id,
      role: subject.user.role,
      teams: [...subject.teamIds],
      managedTeams: [...subject.managedTeamIds],
      jti: this.ids.next(),
      iat: issuedAt,
      exp: issuedAt + this.options.ttlSeconds,
    };

    // Validate against the shared contract before signing. A token other services would reject
    // (for example because of too many team claims) must fail here, loudly, not at every caller.
    const checked = accessTokenClaimsSchema.safeParse(claims);
    if (!checked.success) {
      throw new Error('Refusing to issue an access token that violates the token contract');
    }

    const token = await new SignJWT({
      role: claims.role,
      teams: claims.teams,
      managedTeams: claims.managedTeams,
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: this.keyRing.keyId, typ: 'JWT' })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .sign(this.keyRing.signingKey);

    return { token, expiresInSeconds: this.options.ttlSeconds };
  }
}
