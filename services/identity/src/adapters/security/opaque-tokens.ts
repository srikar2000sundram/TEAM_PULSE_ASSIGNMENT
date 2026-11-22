import { createHash, randomBytes } from 'node:crypto';
import type { OpaqueTokens } from '../../application/ports.js';

/**
 * Refresh-token secrets: 256 bits from the OS random source. Because they are uniformly random
 * and high-entropy, a plain SHA-256 is the right way to store them (a slow password hash would add
 * cost without adding security).
 */
export class CryptoOpaqueTokens implements OpaqueTokens {
  generate() {
    const secret = randomBytes(32).toString('base64url');
    return { secret, hash: this.hash(secret) };
  }

  hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}
