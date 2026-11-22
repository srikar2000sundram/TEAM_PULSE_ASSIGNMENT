import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@teampulse/kernel';
import {
  hasRole,
  hideUnless,
  isMemberOf,
  isSelf,
  managesTeam,
  requireRole,
  type Principal,
} from '../src/index.js';
import { createLocalJwksVerifier } from '../src/jwt.js';

const ISSUER = 'teampulse-identity';
const AUDIENCE = 'teampulse-api';
const NOW = new Date('2026-11-20T08:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: uuid(1),
  role: 'employee',
  teamIds: [uuid(10)],
  managedTeamIds: [],
  ...overrides,
});

describe('authorization helpers', () => {
  it('requireRole allows listed roles and forbids the rest', () => {
    expect(requireRole(principal({ role: 'admin' }), 'admin').ok).toBe(true);
    const denied = requireRole(principal(), 'admin', 'manager');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('forbidden');
  });

  it('answers membership, management and self questions', () => {
    const manager = principal({ role: 'manager', managedTeamIds: [uuid(20)] });
    expect(hasRole(manager, 'manager')).toBe(true);
    expect(managesTeam(manager, uuid(20))).toBe(true);
    expect(managesTeam(manager, uuid(21))).toBe(false);
    expect(isMemberOf(manager, uuid(10))).toBe(true);
    expect(isMemberOf(manager, uuid(99))).toBe(false);
    expect(isSelf(manager, uuid(1))).toBe(true);
    expect(isSelf(manager, uuid(2))).toBe(false);
  });

  it('hideUnless answers not_found, never forbidden, so existence is not revealed', () => {
    const denied = hideUnless(false, 'habit.not_found', 'Habit not found');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('not_found');
    expect(hideUnless(true, 'x', 'y').ok).toBe(true);
  });
});

describe('access token verification', () => {
  type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let signingKey: SigningKey;
  let otherKey: SigningKey;
  let jwks: JSONWebKeySet;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const other = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    otherKey = other.privateKey;
    jwks = {
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }],
    };
  });

  const verifier = () =>
    createLocalJwksVerifier(jwks, { issuer: ISSUER, audience: AUDIENCE, clock });

  async function token(
    options: {
      key?: SigningKey;
      kid?: string;
      issuer?: string;
      audience?: string;
      issuedAt?: Date;
      expiresAt?: Date;
      claims?: Record<string, unknown>;
      jti?: string | null;
    } = {},
  ) {
    const jwt = new SignJWT({
      role: 'manager',
      teams: [uuid(10)],
      managedTeams: [uuid(20)],
      ...options.claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'key-1' })
      .setSubject(uuid(1))
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt(options.issuedAt ?? NOW)
      .setExpirationTime(options.expiresAt ?? new Date(NOW.getTime() + 15 * 60_000));
    if (options.jti !== null) jwt.setJti(options.jti ?? 'jti-1');
    return jwt.sign(options.key ?? signingKey);
  }

  it('accepts a valid token and builds the principal from its claims', async () => {
    const result = await verifier().verify(await token());
    expect(result).toEqual({
      ok: true,
      value: {
        userId: uuid(1),
        role: 'manager',
        teamIds: [uuid(10)],
        managedTeamIds: [uuid(20)],
      },
    });
  });

  it('rejects an expired token (time comes from the injected clock)', async () => {
    const stale = await token({
      issuedAt: new Date(NOW.getTime() - 3_600_000),
      expiresAt: new Date(NOW.getTime() - 1_800_000),
    });
    expect((await verifier().verify(stale)).ok).toBe(false);
  });

  it('accepts the same token while still inside its lifetime and rejects it after', async () => {
    const t = await token();
    const local = new FixedClock(NOW);
    const v = createLocalJwksVerifier(jwks, { issuer: ISSUER, audience: AUDIENCE, clock: local });
    expect((await v.verify(t)).ok).toBe(true);
    local.advanceMs(16 * 60_000);
    expect((await v.verify(t)).ok).toBe(false);
  });

  it('rejects a wrong issuer and a wrong audience', async () => {
    expect((await verifier().verify(await token({ issuer: 'evil' }))).ok).toBe(false);
    expect((await verifier().verify(await token({ audience: 'other-api' }))).ok).toBe(false);
  });

  it('rejects a token signed by a different key, even with a matching kid', async () => {
    expect((await verifier().verify(await token({ key: otherKey }))).ok).toBe(false);
  });

  it('rejects an unknown kid', async () => {
    expect((await verifier().verify(await token({ kid: 'rotated-away' }))).ok).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await token()).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: uuid(1), role: 'admin', teams: [], managedTeams: [] }),
    ).toString('base64url');
    expect((await verifier().verify(`${header}.${forgedPayload}.${signature}`)).ok).toBe(false);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: uuid(1),
      role: 'admin',
      teams: [],
      managedTeams: [],
      jti: 'x',
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 600,
    })}.`;
    expect((await verifier().verify(unsigned)).ok).toBe(false);
  });

  it('rejects a token without a jti, an unknown role, or a malformed team claim', async () => {
    expect((await verifier().verify(await token({ jti: null }))).ok).toBe(false);
    expect((await verifier().verify(await token({ claims: { role: 'superuser' } }))).ok).toBe(
      false,
    );
    expect((await verifier().verify(await token({ claims: { teams: ['not-a-uuid'] } }))).ok).toBe(
      false,
    );
  });

  it('rejects garbage, and always with the same error code', async () => {
    const results = await Promise.all(
      ['', 'abc', 'a.b.c', await token({ issuer: 'evil' })].map((t) => verifier().verify(t)),
    );
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('auth.invalid_token');
    }
  });
});
