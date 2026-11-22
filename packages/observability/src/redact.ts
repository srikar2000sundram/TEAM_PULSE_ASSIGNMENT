import { createHash } from 'node:crypto';

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/**
 * Keys whose values must never reach a log line, compared case-insensitively with separators
 * removed (so `habit_title`, `habitTitle` and `HabitTitle` all match).
 * Covers credentials, contact details and wellness content (ADR-0005, doc 06).
 */
const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'secret',
  'apikey',
  'privatekey',
  'email',
  'title',
  'habittitle',
  'notes',
  'description',
  'message', // free-text user content; the logger's own `msg` field is separate
] as const;

/** Keys holding user identifiers. They are pseudonymised, or redacted when no salt is set. */
const USER_ID_KEYS = ['userid', 'owneruserid', 'actoruserid'] as const;

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Stable, non-reversible token for a user id: lets operators correlate lines without exposing ids. */
export function pseudonymize(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 16);
}

export interface RedactionOptions {
  /** Extra keys to treat as sensitive, in addition to the defaults. */
  readonly extraSensitiveKeys?: readonly string[];
  /** When set, user id fields are replaced by a salted hash. When absent they are redacted. */
  readonly pseudonymSalt?: string | undefined;
}

export type Redactor = (value: unknown) => unknown;

export function createRedactor(options: RedactionOptions = {}): Redactor {
  const sensitive = new Set<string>(
    [...DEFAULT_SENSITIVE_KEYS, ...(options.extraSensitiveKeys ?? [])].map(normalise),
  );
  const userIdKeys = new Set<string>(USER_ID_KEYS);
  const salt = options.pseudonymSalt;

  function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return serializeError(value);

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalised = normalise(key);
      if (sensitive.has(normalised)) {
        output[key] = REDACTED;
      } else if (userIdKeys.has(normalised)) {
        output[key] =
          salt !== undefined && typeof item === 'string' ? pseudonymize(item, salt) : REDACTED;
      } else {
        output[key] = walk(item, depth + 1, seen);
      }
    }
    return output;
  }

  return (value) => walk(value, 0, new WeakSet());
}

export function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') serialized.code = code;
  return serialized;
}
