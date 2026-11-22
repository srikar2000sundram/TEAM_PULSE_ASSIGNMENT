import { createHash } from 'node:crypto';

/**
 * A UUID derived from a seed: the same seed always gives the same id.
 *
 * It lets a consumer that produces an event in response to another event give the produced event a
 * stable identity (for example "the StreakUpdated caused by ActivityCompleted X"). If the work is
 * retried, the retry emits the same event id, so downstream consumers that remember event ids see
 * a duplicate instead of a new event.
 *
 * The result is shaped as a version 5 style UUID (SHA-256 truncated, version and variant bits set),
 * so it passes the same UUID validation as any other id. Not a secret and not for security use.
 */
export function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
