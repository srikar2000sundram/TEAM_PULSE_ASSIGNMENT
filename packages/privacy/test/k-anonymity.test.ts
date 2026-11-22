import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_COHORT_SIZE,
  MIN_ALLOWED_COHORT_SIZE,
  assertValidCohortSize,
  release,
  releaseBreakdown,
  type Measure,
  type Released,
} from '../src/index.js';

const m = (value: number, cohortSize: number): Measure => ({ value, cohortSize });
const isShown = (r: Released) => !r.suppressed;

describe('assertValidCohortSize', () => {
  it('accepts whole numbers from the minimum up', () => {
    expect(assertValidCohortSize(MIN_ALLOWED_COHORT_SIZE)).toBe(3);
    expect(assertValidCohortSize(5)).toBe(5);
    expect(assertValidCohortSize(50)).toBe(50);
  });

  it.each([0, 1, 2, -5, 4.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (k) => {
    expect(() => assertValidCohortSize(k)).toThrow(RangeError);
  });
});

describe('release', () => {
  it('defaults K to 5', () => {
    expect(DEFAULT_MIN_COHORT_SIZE).toBe(5);
  });

  it('suppresses one person fewer than K and releases exactly K', () => {
    expect(release(m(40, 4))).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(release(m(40, 5))).toEqual({ suppressed: false, value: 40, cohortSize: 5 });
    expect(release(m(40, 12)).suppressed).toBe(false);
  });

  it('honours a configured K', () => {
    expect(release(m(10, 7), 8).suppressed).toBe(true);
    expect(release(m(10, 8), 8).suppressed).toBe(false);
  });

  it('a suppressed cell carries no number and no size, not even zero', () => {
    const hidden = release(m(123, 2));
    expect(hidden).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(JSON.stringify(hidden)).not.toContain('123');
    expect(hidden).not.toHaveProperty('value');
    expect(hidden).not.toHaveProperty('cohortSize');
  });

  it('refuses an invalid K instead of quietly hiding nothing', () => {
    expect(() => release(m(1, 100), 1)).toThrow(RangeError);
  });
});

describe('releaseBreakdown', () => {
  it('releases everything when every cell is large enough', () => {
    const result = releaseBreakdown(m(100, 20), { walking: m(60, 12), yoga: m(40, 9) });
    expect(isShown(result.total)).toBe(true);
    expect(Object.values(result.parts).every(isShown)).toBe(true);
  });

  it('hides everything when the total itself has fewer than K people', () => {
    const result = releaseBreakdown(m(30, 4), { walking: m(20, 4), yoga: m(10, 3) });
    expect(result.total).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(Object.values(result.parts).every((p) => p.suppressed)).toBe(true);
  });

  it('hides small parts but keeps the rest when two or more are hidden', () => {
    const result = releaseBreakdown(m(100, 20), {
      walking: m(70, 15),
      yoga: m(18, 3),
      sleep: m(12, 2),
    });
    expect(result.parts.yoga).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(result.parts.sleep).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(isShown(result.parts.walking)).toBe(true);
    expect(isShown(result.total)).toBe(true);
  });

  it('closes the subtraction hole: one hidden part also hides the smallest visible one', () => {
    // Without this, 100 - 60 - 25 = 15 would reveal the hidden yoga count.
    const result = releaseBreakdown(m(100, 20), {
      walking: m(60, 12),
      cycling: m(25, 6),
      yoga: m(15, 3),
    });
    expect(result.parts.yoga).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(result.parts.cycling).toEqual({ suppressed: true, reason: 'complementary' });
    expect(isShown(result.parts.walking)).toBe(true);
  });

  it('breaks ties between the smallest visible parts by key, deterministically', () => {
    const parts = { b: m(30, 6), a: m(30, 6), c: m(10, 2) };
    const first = releaseBreakdown(m(70, 20), parts);
    const second = releaseBreakdown(m(70, 20), { c: parts.c, a: parts.a, b: parts.b });
    expect(first).toEqual(second);
    expect(first.parts.a).toEqual({ suppressed: true, reason: 'complementary' });
    expect(isShown(first.parts.b)).toBe(true);
  });

  it('hides the total instead when the only part is the hidden one (they would be equal)', () => {
    const result = releaseBreakdown(m(10, 6), { yoga: m(10, 3) });
    expect(result.parts.yoga.suppressed).toBe(true);
    expect(result.total).toEqual({ suppressed: true, reason: 'complementary' });
  });

  it('does not apply complementary suppression to parts that are not exhaustive', () => {
    const result = releaseBreakdown(
      m(100, 20),
      { walking: m(60, 12), yoga: m(15, 3) },
      { exhaustive: false },
    );
    expect(result.parts.yoga.suppressed).toBe(true);
    expect(isShown(result.parts.walking)).toBe(true);
  });

  it('honours a configured K, including for complementary suppression', () => {
    const result = releaseBreakdown(
      m(100, 30),
      { a: m(50, 20), b: m(30, 9), c: m(20, 8) },
      { k: 10 },
    );
    expect(result.parts.b).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(result.parts.c).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(isShown(result.parts.a)).toBe(true);
  });

  it('handles an empty breakdown', () => {
    const result = releaseBreakdown(m(10, 6), {});
    expect(isShown(result.total)).toBe(true);
    expect(result.parts).toEqual({});
  });

  it('does not modify its input', () => {
    const parts = { walking: m(60, 12), yoga: m(15, 3), cycling: m(25, 6) };
    const copy = JSON.parse(JSON.stringify(parts)) as typeof parts;
    releaseBreakdown(m(100, 20), parts);
    expect(parts).toEqual(copy);
  });

  it('never leaves exactly one hidden part next to a released total (exhaustive parts)', () => {
    // Exhaustive search over small cohort sizes: no combination allows recovery by subtraction.
    const sizes = [0, 1, 2, 3, 4, 5, 6, 8, 13];
    for (const totalSize of sizes) {
      for (const a of sizes) {
        for (const b of sizes) {
          for (const c of sizes) {
            const result = releaseBreakdown(m(100, totalSize), {
              a: m(40, a),
              b: m(35, b),
              c: m(25, c),
            });
            const hiddenParts = Object.values(result.parts).filter((p) => p.suppressed).length;
            if (isShown(result.total)) {
              expect(hiddenParts, `total ${totalSize} parts ${a},${b},${c}`).not.toBe(1);
            }
          }
        }
      }
    }
  });
});
