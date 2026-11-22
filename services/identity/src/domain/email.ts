import { err, ok, validationError, type Result } from '@teampulse/kernel';

const MAX_LENGTH = 254;
// Deliberately simple: one "@", no spaces, a dot in the domain. Real validation is "can we send
// mail to it", which an internal platform checks by having an administrator create the account.
const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A normalised (trimmed, lower-cased) email address. Create it with `Email.create`. */
export class Email {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Email> {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || value.length > MAX_LENGTH || !SHAPE.test(value)) {
      return err(validationError('user.email_invalid', 'The email address is not valid'));
    }
    return ok(new Email(value));
  }

  /** Part before the "@", used by the password policy. */
  get localPart(): string {
    return this.value.slice(0, this.value.indexOf('@'));
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}
