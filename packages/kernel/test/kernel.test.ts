import { describe, expect, it } from 'vitest';
import {
  AppError,
  FixedClock,
  SequentialIdGenerator,
  SystemClock,
  UuidGenerator,
  andThen,
  assertNever,
  conflictError,
  err,
  forbiddenError,
  map,
  mapError,
  notFoundError,
  ok,
  unauthorizedError,
  unwrap,
  validationError,
  type Result,
} from '../src/index.js';

describe('Result', () => {
  it('maps a success and leaves a failure untouched', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const failure = err('boom');
    expect(map(failure, (n: number) => n * 3)).toBe(failure);
  });

  it('maps errors without touching successes', () => {
    expect(mapError(err('a'), (e) => `${e}!`)).toEqual(err('a!'));
    expect(mapError(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('chains with andThen and short-circuits on the first failure', () => {
    const half = (n: number): Result<number, string> =>
      n % 2 === 0 ? ok(n / 2) : err(`${n} is odd`);
    expect(andThen(andThen(ok(8), half), half)).toEqual(ok(2));
    expect(andThen(andThen(ok(6), half), half)).toEqual(err('3 is odd'));
  });

  it('unwrap returns the value or throws the carried error', () => {
    expect(unwrap(ok(5))).toBe(5);
    const failure = notFoundError('habit.not_found', 'Habit not found');
    expect(() => unwrap(err(failure))).toThrow(failure);
    expect(() => unwrap(err('plain text'))).toThrow('plain text');
  });
});

describe('AppError factories', () => {
  it('assign the expected kind and keep a stable code', () => {
    expect(validationError('x.invalid', 'bad', { field: 'x' })).toMatchObject({
      kind: 'validation',
      code: 'x.invalid',
      details: { field: 'x' },
    });
    expect(unauthorizedError().kind).toBe('unauthorized');
    expect(forbiddenError().kind).toBe('forbidden');
    expect(notFoundError('a.not_found', 'nope').kind).toBe('not_found');
    expect(conflictError('a.conflict', 'dup').kind).toBe('conflict');
  });

  it('is a real Error so stack traces and instanceof work', () => {
    const error = notFoundError('a.not_found', 'nope');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.stack).toBeDefined();
  });

  it('defaults details to an empty object', () => {
    expect(conflictError('a.conflict', 'dup').details).toEqual({});
  });
});

describe('Clock', () => {
  it('FixedClock stays still until told otherwise and never leaks its internal Date', () => {
    const clock = new FixedClock('2026-11-20T08:00:00Z');
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-11-20T08:00:00.000Z');

    clock.advanceMs(60_000);
    expect(clock.now().toISOString()).toBe('2026-11-20T08:01:00.000Z');

    clock.set('2027-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('SystemClock returns the current time', () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

describe('IdGenerator', () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('UuidGenerator produces distinct v4 UUIDs', () => {
    const generator = new UuidGenerator();
    const a = generator.next();
    const b = generator.next();
    expect(a).toMatch(uuidV4);
    expect(a).not.toBe(b);
  });

  it('SequentialIdGenerator is predictable and still a valid v4 UUID', () => {
    const generator = new SequentialIdGenerator();
    expect(generator.next()).toBe('00000000-0000-4000-8000-000000000001');
    expect(generator.next()).toBe('00000000-0000-4000-8000-000000000002');
    expect(generator.next()).toMatch(uuidV4);
  });
});

describe('assertNever', () => {
  it('throws if an impossible value reaches it at runtime', () => {
    expect(() => assertNever('surprise' as never)).toThrow('Unexpected value');
  });
});
