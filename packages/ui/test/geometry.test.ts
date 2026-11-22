import { describe, expect, it } from 'vitest';
import { clamp, fraction, ringGeometry, scaleSeries } from '../src/lib/geometry.js';

describe('clamp and fraction', () => {
  it('keeps numbers in range and turns NaN and infinity into the minimum', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(30, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
  });

  it('gives the share reached, never below 0 or above 1, and 0 when there is no target', () => {
    expect(fraction(25, 100)).toBe(0.25);
    expect(fraction(150, 100)).toBe(1);
    expect(fraction(-5, 100)).toBe(0);
    expect(fraction(5, 0)).toBe(0);
    expect(fraction(5, -10)).toBe(0);
    expect(fraction(5, Number.NaN)).toBe(0);
  });
});

describe('ringGeometry', () => {
  it('hides exactly the unfilled share of the circumference', () => {
    const empty = ringGeometry(100, 10, 0);
    const half = ringGeometry(100, 10, 0.5);
    const full = ringGeometry(100, 10, 1);
    expect(empty.radius).toBe(45);
    expect(empty.offset).toBeCloseTo(empty.circumference);
    expect(half.offset).toBeCloseTo(half.circumference / 2);
    expect(full.offset).toBe(0);
    expect(full.center).toBe(50);
  });
});

describe('scaleSeries', () => {
  const series = [
    { date: '2026-11-18', value: 0 },
    { date: '2026-11-19', value: 5 },
    { date: '2026-11-20', value: 10 },
  ];

  it('spreads points evenly inside the padding, highest value at the top', () => {
    const points = scaleSeries(series, 120, 80, 10);
    expect(points.map((p) => p.x)).toEqual([10, 60, 110]);
    expect(points.map((p) => p.y)).toEqual([70, 40, 10]);
  });

  it('starts the scale at zero, so a flat non-zero series sits at the top, not the bottom', () => {
    const points = scaleSeries(
      [
        { date: 'a', value: 3 },
        { date: 'b', value: 3 },
      ],
      100,
      100,
      0,
    );
    expect(points.map((p) => p.y)).toEqual([0, 0]);
  });

  it('centres a single point and keeps an all-zero series on the baseline', () => {
    expect(scaleSeries([{ date: 'a', value: 4 }], 100, 50, 10)[0]?.x).toBe(50);
    expect(
      scaleSeries(
        [
          { date: 'a', value: 0 },
          { date: 'b', value: 0 },
        ],
        100,
        50,
        10,
      ).map((p) => p.y),
    ).toEqual([40, 40]);
  });

  it('is empty for no data and ignores negative values', () => {
    expect(scaleSeries([], 100, 50, 10)).toEqual([]);
    expect(
      scaleSeries(
        [
          { date: 'a', value: -5 },
          { date: 'b', value: 5 },
        ],
        100,
        50,
        10,
      )[0]?.y,
    ).toBe(40);
  });
});
