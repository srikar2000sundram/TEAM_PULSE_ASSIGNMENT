import { err, ok, validationError, type Result } from '@teampulse/kernel';
import type { Email } from './email.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** A very small deny-list: the real defence is length. A breached-password check is future work. */
const COMMON = new Set([
  'passwordpassword',
  'password1234',
  'qwertyuiop12',
  'iloveyou1234',
  'welcome12345',
  'administrator',
  'letmein12345',
]);

/**
 * Length-first password rules (NIST SP 800-63B style): no composition rules such as "must
 * contain a symbol", which push people towards predictable patterns.
 */
export function validateNewPassword(password: string, email: Email): Result<void> {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }

  const lowered = password.toLowerCase();
  if (email.localPart.length >= 4 && lowered.includes(email.localPart)) {
    problems.push('must not contain your email name');
  }
  if (new Set(password).size <= 2) {
    problems.push('must not be made of one or two repeated characters');
  }
  if (COMMON.has(lowered)) {
    problems.push('is too common');
  }

  if (problems.length === 0) return ok(undefined);
  return err(
    validationError('user.password_weak', `The password ${problems.join(', ')}`, {
      errors: problems.map((message) => ({ field: 'password', message })),
    }),
  );
}
