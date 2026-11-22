import { describe, expect, it } from 'vitest';
import type { ActivityType } from '@teampulse/contracts';
import { buildPersonalReport, buildTeamReport, type CellData } from '../../src/domain/report.js';

const K = 5;

/** `people` different participants behind `completions` completions of one type on one day. */
const cell = (
  day: string,
  activityType: ActivityType,
  completions: number,
  people: number,
  prefix = 'p',
): CellData => ({
  day,
  activityType,
  completions,
  participants: Array.from({ length: people }, (_, i) => `${prefix}${i}`),
});

const shown = (value: number, cohortSize: number) => ({ suppressed: false, value, cohortSize });
const hidden = (reason: 'cohort_too_small' | 'complementary') => ({ suppressed: true, reason });

describe('buildTeamReport', () => {
  it('shows every number when each is backed by at least K different people', () => {
    const report = buildTeamReport(
      [cell('2026-11-19', 'walking', 20, 8), cell('2026-11-20', 'yoga', 12, 6, 'q')],
      K,
    );
    expect(report.total).toEqual(shown(32, 14));
    expect(report.byActivityType).toEqual({ walking: shown(20, 8), yoga: shown(12, 6) });
    expect(report.byDay).toEqual([
      { date: '2026-11-19', cell: shown(20, 8) },
      { date: '2026-11-20', cell: shown(12, 6) },
    ]);
  });

  it('hides everything when the whole group is smaller than K, and shows no counts at all', () => {
    const report = buildTeamReport([cell('2026-11-20', 'walking', 9, 4)], K);
    expect(report.total).toEqual(hidden('cohort_too_small'));
    expect(report.byActivityType).toEqual({ walking: hidden('cohort_too_small') });
    expect(report.byDay).toEqual([{ date: '2026-11-20', cell: hidden('cohort_too_small') }]);
    expect(JSON.stringify(report)).not.toMatch(/"(value|cohortSize)"/);
  });

  it('reports an empty period as a hidden total with no parts', () => {
    expect(buildTeamReport([], K)).toEqual({
      total: hidden('cohort_too_small'),
      byActivityType: {},
      byDay: [],
    });
  });

  it('ignores cells with no completions or no participants (erased people leave husks)', () => {
    const report = buildTeamReport(
      [
        cell('2026-11-20', 'walking', 10, 6),
        cell('2026-11-20', 'yoga', 0, 3),
        { day: '2026-11-20', activityType: 'running', completions: 4, participants: [] },
      ],
      K,
    );
    expect(Object.keys(report.byActivityType)).toEqual(['walking']);
  });

  it('counts one person once across days and types, but once per part inside each part', () => {
    // The same 5 people on two days and two types: 5 different people overall, not 20.
    const report = buildTeamReport(
      [
        cell('2026-11-19', 'walking', 5, 5),
        cell('2026-11-20', 'walking', 5, 5),
        cell('2026-11-19', 'yoga', 5, 5),
        cell('2026-11-20', 'yoga', 5, 5),
      ],
      K,
    );
    expect(report.total).toEqual(shown(20, 5));
    expect(report.byActivityType.walking).toEqual(shown(10, 5));
    expect(report.byDay[0]).toEqual({ date: '2026-11-19', cell: shown(10, 5) });
  });

  describe('subtraction attack (complementary suppression)', () => {
    it('hides a second part when exactly one part is hidden, so it cannot be computed', () => {
      // total 100 = walking 60 + cycling 25 + yoga 15; yoga has only 3 people.
      const report = buildTeamReport(
        [
          cell('2026-11-20', 'walking', 60, 10),
          cell('2026-11-20', 'cycling', 25, 6),
          cell('2026-11-20', 'yoga', 15, 3),
        ],
        K,
      );
      expect(report.total.suppressed).toBe(false);
      expect(report.byActivityType.yoga).toEqual(hidden('cohort_too_small'));
      // Not walking (60) - cycling (25) - total: the smallest visible part is also hidden.
      expect(report.byActivityType.cycling).toEqual(hidden('complementary'));
      expect(report.byActivityType.walking).toEqual(shown(60, 10));
    });

    it('does not mistake a missing type for a hidden zero, which would let subtraction through', () => {
      // Only walking (visible) and yoga (hidden) have data. Listing "cycling: hidden" for the
      // empty type would count as a second hidden part and wrongly skip the complementary rule.
      const report = buildTeamReport(
        [cell('2026-11-20', 'walking', 40, 9), cell('2026-11-20', 'yoga', 7, 2)],
        K,
      );
      expect(Object.keys(report.byActivityType).sort()).toEqual(['walking', 'yoga']);
      const hiddenParts = Object.values(report.byActivityType).filter((p) => p.suppressed);
      expect(hiddenParts).toHaveLength(2);
    });

    it('applies the same protection to the breakdown by day', () => {
      const report = buildTeamReport(
        [
          cell('2026-11-18', 'walking', 30, 8),
          cell('2026-11-19', 'walking', 30, 8, 'q'),
          cell('2026-11-20', 'walking', 3, 2, 'r'),
        ],
        K,
      );
      const hiddenDays = report.byDay.filter((day) => day.cell.suppressed);
      expect(hiddenDays).toHaveLength(2);
    });

    it('never leaves a shown total next to exactly one hidden part, for any mix of group sizes', () => {
      const sizes = [1, 3, 4, 5, 6, 9];
      for (const a of sizes) {
        for (const b of sizes) {
          for (const c of sizes) {
            const report = buildTeamReport(
              [
                cell('2026-11-18', 'walking', 10 * a, a, 'a'),
                cell('2026-11-19', 'yoga', 10 * b, b, 'b'),
                cell('2026-11-20', 'running', 10 * c, c, 'c'),
              ],
              K,
            );
            const checks: Released[][] = [
              Object.values(report.byActivityType),
              report.byDay.map((day) => day.cell),
            ];
            for (const parts of checks) {
              const hiddenCount = parts.filter((p) => p.suppressed).length;
              if (!report.total.suppressed) {
                expect(hiddenCount, `sizes ${a},${b},${c}`).not.toBe(1);
              } else {
                // A hidden total takes every part with it: visible parts would add up to it.
                expect(hiddenCount, `sizes ${a},${b},${c}`).toBe(parts.length);
              }
            }
          }
        }
      }
    });
  });
});

type Released = ReturnType<typeof buildTeamReport>['total'];

describe('buildPersonalReport', () => {
  const day = (d: string, type: ActivityType, completions: number) => ({
    day: d,
    activityType: type,
    completions,
    scopeKeys: [],
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  });

  it('adds up your own numbers by type and by day, and hides nothing', () => {
    expect(
      buildPersonalReport([
        day('2026-11-20', 'walking', 2),
        day('2026-11-20', 'yoga', 1),
        day('2026-11-19', 'walking', 1),
      ]),
    ).toEqual({
      total: 4,
      byActivityType: { walking: 3, yoga: 1 },
      byDay: [
        { date: '2026-11-19', completions: 1 },
        { date: '2026-11-20', completions: 3 },
      ],
    });
  });

  it('is empty for no activity', () => {
    expect(buildPersonalReport([])).toEqual({ total: 0, byActivityType: {}, byDay: [] });
  });
});
