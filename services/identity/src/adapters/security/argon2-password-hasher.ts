import { Algorithm, hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../../application/ports.js';

export interface Argon2Params {
  readonly memoryCostKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * OWASP's minimum recommended Argon2id configuration (19 MiB, 2 iterations, 1 lane).
 * Raise it as hardware allows; existing hashes keep verifying because the parameters are stored
 * inside each hash string.
 */
export const OWASP_ARGON2_PARAMS: Argon2Params = {
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly params: Argon2Params = OWASP_ARGON2_PARAMS) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.params.memoryCostKiB,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    });
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      // A malformed stored hash must read as "wrong password", never as a server error that
      // would tell an attacker which accounts have corrupt records.
      return false;
    }
  }
}
