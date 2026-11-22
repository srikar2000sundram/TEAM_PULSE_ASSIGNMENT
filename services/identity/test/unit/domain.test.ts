import { describe, expect, it } from 'vitest';
import { unwrap } from '@teampulse/kernel';
import { Email } from '../../src/domain/email.js';
import { validateNewPassword } from '../../src/domain/password-policy.js';
import { DEFAULT_ROTATION_POLICY, RefreshToken } from '../../src/domain/refresh-token.js';
import { DEFAULT_LOCKOUT_POLICY, User } from '../../src/domain/user.js';

const T0 = new Date('2026-11-20T08:00:00Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

describe('Email', () => {
  it('normalises case and whitespace', () => {
    expect(unwrap(Email.create('  Alice@Example.COM ')).value).toBe('alice@example.com');
  });

  it.each(['', 'plain', 'a@b', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@x.io`])(
    'rejects %j',
    (raw) => {
      expect(Email.create(raw).ok).toBe(false);
    },
  );

  it('exposes the local part and compares by value', () => {
    const a = unwrap(Email.create('Jane.Doe@example.com'));
    expect(a.localPart).toBe('jane.doe');
    expect(a.equals(unwrap(Email.create('jane.doe@EXAMPLE.com')))).toBe(true);
  });
});

describe('password policy', () => {
  const email = unwrap(Email.create('jane.doe@example.com'));
  const check = (password: string) => validateNewPassword(password, email);

  it('accepts a long passphrase without composition rules', () => {
    expect(check('correct horse battery staple').ok).toBe(true);
  });

  it('rejects short passwords and reports the reason per field', () => {
    const result = check('short');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('user.password_weak');
      expect(result.error.details.errors).toEqual([
        { field: 'password', message: 'must be at least 12 characters' },
      ]);
    }
  });

  it('rejects passwords containing the email name, repeated characters and common choices', () => {
    expect(check('xx-jane.doe-xx-123').ok).toBe(false);
    expect(check('aaaaaaaaaaaaaaaa').ok).toBe(false);
    expect(check('abababababababab').ok).toBe(false);
    expect(check('PasswordPassword').ok).toBe(false);
  });

  it('rejects absurdly long passwords (denial of service by hashing)', () => {
    expect(check('x1'.repeat(100) + 'abc').ok).toBe(false);
  });
});

describe('User lockout rules', () => {
  const make = () =>
    User.create({
      id: 'u1',
      email: unwrap(Email.create('a@example.com')),
      displayName: '  Ada  ',
      passwordHash: 'h',
      role: 'employee',
      now: T0,
    });

  it('starts active, unlocked, with a trimmed name', () => {
    const user = make();
    expect(user.isActive).toBe(true);
    expect(user.canLogin(T0)).toBe(true);
    expect(user.displayName).toBe('Ada');
  });

  it('counts failures and locks at the limit, then restarts the counter', () => {
    let user = make();
    for (let i = 1; i < DEFAULT_LOCKOUT_POLICY.maxFailedAttempts; i += 1) {
      user = user.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
      expect(user.failedLoginAttempts).toBe(i);
      expect(user.canLogin(T0)).toBe(true);
    }
    user = user.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
    expect(user.isLocked(T0)).toBe(true);
    expect(user.canLogin(T0)).toBe(false);
    expect(user.failedLoginAttempts).toBe(0);
  });

  it('unlocks by itself when the lockout expires', () => {
    let user = make();
    for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.maxFailedAttempts; i += 1) {
      user = user.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
    }
    expect(user.isLocked(after(DEFAULT_LOCKOUT_POLICY.lockoutMs - 1))).toBe(true);
    expect(user.isLocked(after(DEFAULT_LOCKOUT_POLICY.lockoutMs))).toBe(false);
  });

  it('a successful login clears failures, and is a no-op when there is nothing to clear', () => {
    const clean = make();
    expect(clean.registerSuccessfulLogin(T0)).toBe(clean);
    const failed = clean.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
    expect(failed.registerSuccessfulLogin(T0).failedLoginAttempts).toBe(0);
  });

  it('changing the password also clears failures and any lock', () => {
    let user = make();
    for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.maxFailedAttempts; i += 1) {
      user = user.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
    }
    const changed = user.changePasswordHash('new', after(1000));
    expect(changed.passwordHash).toBe('new');
    expect(changed.isLocked(after(1000))).toBe(false);
  });

  it('is immutable: transitions return new instances', () => {
    const user = make();
    user.registerFailedLogin(T0, DEFAULT_LOCKOUT_POLICY);
    expect(user.failedLoginAttempts).toBe(0);
  });
});

describe('RefreshToken', () => {
  const policy = DEFAULT_ROTATION_POLICY;
  const first = RefreshToken.startFamily({
    id: 't1',
    userId: 'u1',
    familyId: 'f1',
    tokenHash: 'h1',
    now: T0,
    policy,
  });

  it('expires after its time to live', () => {
    expect(first.isExpired(after(policy.tokenTtlMs - 1))).toBe(false);
    expect(first.isExpired(after(policy.tokenTtlMs))).toBe(true);
  });

  it('successor stays in the family and inherits its start time', () => {
    const next = first.successor({ id: 't2', tokenHash: 'h2', now: after(3_600_000), policy });
    expect(next).toMatchObject({ familyId: 'f1', userId: 'u1', revokedAt: null });
    expect(next.familyStartedAt).toEqual(T0);
  });

  it('caps a successor at the family absolute maximum age', () => {
    const late = after(policy.familyMaxAgeMs - 60_000);
    const next = first.successor({ id: 't2', tokenHash: 'h2', now: late, policy });
    expect(next.expiresAt.getTime()).toBe(T0.getTime() + policy.familyMaxAgeMs);
    expect(first.isFamilyTooOld(after(policy.familyMaxAgeMs), policy)).toBe(true);
    expect(first.isFamilyTooOld(after(policy.familyMaxAgeMs - 1), policy)).toBe(false);
  });

  it('distinguishes a just-rotated token (benign race) from an old rotated one (theft)', () => {
    const rotated = first.rotateTo('t2', after(1_000));
    expect(rotated.isRevoked).toBe(true);
    expect(rotated.wasJustRotated(after(1_000 + policy.reuseGraceMs), policy)).toBe(true);
    expect(rotated.wasJustRotated(after(1_000 + policy.reuseGraceMs + 1), policy)).toBe(false);
  });

  it('a revoked token (logout) is never mistaken for a rotation race', () => {
    const revoked = first.revoke(after(1_000));
    expect(revoked.isRevoked).toBe(true);
    expect(revoked.replacedById).toBeNull();
    expect(revoked.wasJustRotated(after(1_001), policy)).toBe(false);
  });

  it('revoking twice keeps the original revocation time', () => {
    const once = first.revoke(after(1_000));
    expect(once.revoke(after(9_000)).revokedAt).toEqual(after(1_000));
  });
});
