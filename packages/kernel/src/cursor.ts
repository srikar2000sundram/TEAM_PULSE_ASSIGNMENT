import { validationError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * Keyset pagination position: the (createdAt, id) of the last row a client has seen.
 * Rows are ordered by `createdAt` and then `id`, which is total and stable, so pages never skip or
 * repeat a row even when rows share a timestamp (unlike OFFSET, which also gets slower per page).
 */
export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Opaque to clients: they only hand it back. The format may change without a version bump. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString('base64url');
}

export function decodeCursor(raw: string): Result<Cursor> {
  const invalid = () => err(validationError('cursor.invalid', 'The cursor is not valid'));
  const [time, id, extra] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (time === undefined || id === undefined || extra !== undefined) return invalid();
  const createdAt = new Date(time);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== time) return invalid();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return invalid();
  return ok({ createdAt, id });
}

/**
 * Turns "limit + 1 rows" into a page. Queries ask for one extra row to learn whether another page
 * exists without a count query.
 */
export function pageOf<T extends Cursor>(
  rows: readonly T[],
  limit: number,
): { items: readonly T[]; nextCursor: string | undefined } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : undefined,
  };
}
