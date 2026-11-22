import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, pageOf } from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const row = (n: number) => ({
  createdAt: new Date(Date.UTC(2026, 10, 20, 8, 0, n)),
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
});

describe('cursor codec', () => {
  it('round-trips a position', () => {
    const cursor = { createdAt: new Date('2026-11-20T08:00:00.123Z'), id: ID };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.ok && decoded.value).toEqual(cursor);
  });

  it.each([
    ['empty', ''],
    ['not base64 of a position', 'hello'],
    ['extra part', Buffer.from(`2026-11-20T08:00:00.000Z|${ID}|x`).toString('base64url')],
    ['bad date', Buffer.from(`yesterday|${ID}`).toString('base64url')],
    ['non-canonical date', Buffer.from(`2026-11-20|${ID}`).toString('base64url')],
    ['bad id', Buffer.from('2026-11-20T08:00:00.000Z|not-an-id').toString('base64url')],
  ])('rejects a malformed cursor: %s', (_name, raw) => {
    const decoded = decodeCursor(raw);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe('cursor.invalid');
  });
});

describe('pageOf', () => {
  it('returns every row and no cursor when everything fits', () => {
    const page = pageOf([row(1), row(2)], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it('trims the probe row and points the cursor at the last returned row', () => {
    const page = pageOf([row(3), row(2), row(1)], 2);
    expect(page.items.map((r) => r.id)).toEqual([row(3).id, row(2).id]);
    const next = decodeCursor(page.nextCursor ?? '');
    expect(next.ok && next.value.id).toBe(row(2).id);
  });

  it('handles an empty result', () => {
    expect(pageOf([], 10)).toEqual({ items: [], nextCursor: undefined });
  });
});
