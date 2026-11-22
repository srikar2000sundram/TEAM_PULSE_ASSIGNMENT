import { createHmac } from 'node:crypto';
import type { Pseudonymizer } from '../application/ports.js';

/**
 * HMAC-SHA-256 of `scope + user id` under a secret key, shortened to 12 hex characters (48 bits).
 *
 * - **Stable**: the same person in the same scope always gets the same token, so distinct people can
 *   be counted.
 * - **Scoped**: a different scope gives an unrelated token, so a person cannot be followed from one
 *   team's cells to another's.
 * - **Keyed**: without the key, the user ids (which are guessable in principle: they are UUIDs that
 *   appear in other services) cannot be tested against the stored tokens.
 * - **Short**: keeps a cell small. With 20,000 people in a scope, the chance that two share a token
 *   is about 1 in 10^6, and the effect would be counting one person too few.
 */
export class HmacPseudonymizer implements Pseudonymizer {
  constructor(private readonly key: string) {
    if (key.length < 32) throw new RangeError('The pseudonym key must be at least 32 characters');
  }

  participant(scopeKey: string, userId: string): string {
    return createHmac('sha256', this.key)
      .update(`${scopeKey}|${userId}`)
      .digest('hex')
      .slice(0, 12);
  }
}
