import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { Argon2PasswordHasher } from '../../src/adapters/security/argon2-password-hasher.js';
import {
  JwtAccessTokenIssuer,
  KeyRing,
} from '../../src/adapters/security/jwt-access-token-issuer.js';
import { CryptoOpaqueTokens } from '../../src/adapters/security/opaque-tokens.js';
import { Email } from '../../src/domain/email.js';
import { User } from '../../src/domain/user.js';

const pem = (key: KeyObject, type: 'private' | 'public') =>
  key.export(
    type === 'private' ? { type: 'pkcs8', format: 'pem' } : { type: 'spki', format: 'pem' },
  ) as string;

function rsa(bits = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return { privatePem: pem(privateKey, 'private'), publicPem: pem(publicKey, 'public') };
}

describe('Argon2PasswordHasher', () => {
  // Cheap parameters: this tests behaviour, not hardness.
  const hasher = new Argon2PasswordHasher({ memoryCostKiB: 64, timeCost: 1, parallelism: 1 });

  it('produces an Argon2id hash that verifies only the right password', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse batterz')).toBe(false);
  });

  it('salts every hash, so equal passwords never produce equal hashes', async () => {
    expect(await hasher.hash('same-password-12')).not.toBe(await hasher.hash('same-password-12'));
  });

  it('treats a malformed stored hash as a wrong password rather than an error', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
  });

  it('verifies hashes created with different parameters (parameters live inside the hash)', async () => {
    const stronger = new Argon2PasswordHasher({ memoryCostKiB: 128, timeCost: 2, parallelism: 1 });
    const hash = await stronger.hash('rotate-the-cost-12');
    expect(await hasher.verify(hash, 'rotate-the-cost-12')).toBe(true);
  });

  it('never contains the password in the hash', async () => {
    expect(await hasher.hash('visible-secret-12')).not.toContain('visible-secret-12');
  });
});

describe('CryptoOpaqueTokens', () => {
  const tokens = new CryptoOpaqueTokens();

  it('generates unique 256-bit secrets and a matching hash', () => {
    const a = tokens.generate();
    const b = tokens.generate();
    expect(a.secret).not.toBe(b.secret);
    expect(Buffer.from(a.secret, 'base64url')).toHaveLength(32);
    expect(a.hash).toBe(tokens.hash(a.secret));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.secret);
  });
});

describe('KeyRing and JwtAccessTokenIssuer', () => {
  const NOW = new Date('2026-11-20T08:00:00Z');
  const ISSUER = 'teampulse-identity';
  const AUDIENCE = 'teampulse-api';
  const TEAM = '00000000-0000-4000-8000-0000000000a1';
  const MANAGED = '00000000-0000-4000-8000-0000000000a2';

  const user = User.create({
    id: '00000000-0000-4000-8000-000000000001',
    email: unwrap(Email.create('a@example.com')),
    displayName: 'A',
    passwordHash: 'h',
    role: 'manager',
    now: NOW,
  });

  const issuer = (ring: KeyRing, clock = new FixedClock(NOW)) =>
    new JwtAccessTokenIssuer(
      ring,
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900 },
      clock,
      new SequentialIdGenerator(),
    );

  const verifierFor = (ring: KeyRing, clock = new FixedClock(NOW)) =>
    createLocalJwksVerifier(ring.jwks(), { issuer: ISSUER, audience: AUDIENCE, clock });

  it('issues tokens that the shared verifier accepts, with the right principal', async () => {
    const ring = await KeyRing.fromPem({ privateKeyPem: rsa().privatePem });
    const { token, expiresInSeconds } = await issuer(ring).issue({
      user,
      teamIds: [TEAM],
      managedTeamIds: [MANAGED],
    });

    expect(expiresInSeconds).toBe(900);
    expect(await verifierFor(ring).verify(token)).toEqual({
      ok: true,
      value: { userId: user.id, role: 'manager', teamIds: [TEAM], managedTeamIds: [MANAGED] },
    });
  });

  it('stamps the key id in the header and expires tokens after the configured lifetime', async () => {
    const ring = await KeyRing.fromPem({ privateKeyPem: rsa().privatePem });
    const { token } = await issuer(ring).issue({ user, teamIds: [], managedTeamIds: [] });

    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<
      string,
      string
    >;
    expect(header).toMatchObject({ alg: 'RS256', kid: ring.keyId, typ: 'JWT' });

    // Valid for its 900 s lifetime plus the verifier's 5 s clock-skew tolerance, not a second more.
    const edge = new FixedClock(new Date(NOW.getTime() + 904_000));
    expect((await verifierFor(ring, edge).verify(token)).ok).toBe(true);
    const expired = new FixedClock(new Date(NOW.getTime() + 906_000));
    expect((await verifierFor(ring, expired).verify(token)).ok).toBe(false);
  });

  it('gives every token its own jti', async () => {
    const ring = await KeyRing.fromPem({ privateKeyPem: rsa().privatePem });
    const i = issuer(ring);
    const a = (await i.issue({ user, teamIds: [], managedTeamIds: [] })).token;
    const b = (await i.issue({ user, teamIds: [], managedTeamIds: [] })).token;
    const jti = (t: string) =>
      (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as { jti: string }).jti;
    expect(jti(a)).not.toBe(jti(b));
  });

  it('publishes only public key material in the JWKS', async () => {
    const ring = await KeyRing.fromPem({ privateKeyPem: rsa().privatePem });
    const [key] = ring.jwks().keys;
    expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: ring.keyId });
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(key).not.toHaveProperty(secret);
  });

  it('supports rotation: tokens from the retired key still verify while the new key signs', async () => {
    const oldPair = rsa();
    const newPair = rsa();
    const oldRing = await KeyRing.fromPem({ privateKeyPem: oldPair.privatePem });
    const rotated = await KeyRing.fromPem({
      privateKeyPem: newPair.privatePem,
      previousPublicKeyPems: [oldPair.publicPem],
    });

    const oldToken = (await issuer(oldRing).issue({ user, teamIds: [], managedTeamIds: [] })).token;
    const newToken = (await issuer(rotated).issue({ user, teamIds: [], managedTeamIds: [] })).token;

    expect(rotated.jwks().keys).toHaveLength(2);
    expect(rotated.keyId).not.toBe(oldRing.keyId);
    expect((await verifierFor(rotated).verify(oldToken)).ok).toBe(true);
    expect((await verifierFor(rotated).verify(newToken)).ok).toBe(true);
    // Once the old key is dropped from the ring, its tokens stop verifying.
    const afterCutover = await KeyRing.fromPem({ privateKeyPem: newPair.privatePem });
    expect((await verifierFor(afterCutover).verify(oldToken)).ok).toBe(false);
  });

  it('does not duplicate the current key when it is also listed as previous', async () => {
    const pair = rsa();
    const ring = await KeyRing.fromPem({
      privateKeyPem: pair.privatePem,
      previousPublicKeyPems: [pair.publicPem],
    });
    expect(ring.jwks().keys).toHaveLength(1);
  });

  it('rejects weak or non-RSA keys', async () => {
    await expect(KeyRing.fromPem({ privateKeyPem: rsa(1024).privatePem })).rejects.toThrow(
      /at least 2048/,
    );
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    await expect(KeyRing.fromPem({ privateKeyPem: pem(ec, 'private') })).rejects.toThrow(/RSA/);
    await expect(KeyRing.fromPem({ privateKeyPem: 'garbage' })).rejects.toThrow();
  });

  it('refuses to issue a token that other services would reject (too many team claims)', async () => {
    const ring = await KeyRing.fromPem({ privateKeyPem: rsa().privatePem });
    const many = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
    );
    await expect(issuer(ring).issue({ user, teamIds: many, managedTeamIds: [] })).rejects.toThrow(
      /token contract/,
    );
  });
});
