import { describe, expect, it } from 'vitest';
import { applyActivity, daysBetween, type StreakState } from '../../src/domain/streak.js';

const ids = { userId: 'u', habitId: 'h' };
const on = (activityDate: string) => ({ ...ids, activityDate });

const state = (overrides: Partial<StreakState> = {}): StreakState => ({
  ...ids,
  currentStreak: 3,
  longestStreak: 5,
  lastActivityDate: '2026-11-20',
  version: 4,
  ...overrides,
});

describe('applyActivity', () => {
  it('starts a streak of one on the first activity', () => {
    const { state: next, outcome } = applyActivity(null, on('2026-11-20'));
    expect(outcome).toBe('started');
    expect(next).toEqual({
      ...ids,
      currentStreak: 1,
      longestStreak: 1,
      lastActivityDate: '2026-11-20',
      version: 1,
    });
  });

  it('continues the streak on the next day and raises the longest when it overtakes it', () => {
    const { state: next, outcome } = applyActivity(
      state({ currentStreak: 5, longestStreak: 5 }),
      on('2026-11-21'),
    );
    expect(outcome).toBe('continued');
    expect(next).toMatchObject({
      currentStreak: 6,
      longestStreak: 6,
      lastActivityDate: '2026-11-21',
      version: 5,
    });
  });

  it('keeps the longest when the current streak is still shorter', () => {
    const { state: next } = applyActivity(state(), on('2026-11-21'));
    expect(next).toMatchObject({ currentStreak: 4, longestStreak: 5 });
  });

  it('restarts at one after a gap, and remembers the longest', () => {
    for (const date of ['2026-11-22', '2026-12-31', '2027-03-01']) {
      const { state: next, outcome } = applyActivity(state(), on(date));
      expect(outcome, date).toBe('reset');
      expect(next).toMatchObject({ currentStreak: 1, longestStreak: 5, lastActivityDate: date });
    }
  });

  it('changes nothing for the same day again (a redelivered event)', () => {
    const before = state();
    const { state: next, outcome } = applyActivity(before, on('2026-11-20'));
    expect(outcome).toBe('repeated');
    expect(next).toBe(before);
  });

  it('ignores a back-dated activity', () => {
    const before = state();
    const { state: next, outcome } = applyActivity(before, on('2026-11-18'));
    expect(outcome).toBe('backdated');
    expect(next).toBe(before);
  });

  it('counts across month, year and leap-day boundaries', () => {
    const next = (last: string, date: string) =>
      applyActivity(state({ lastActivityDate: last, currentStreak: 1 }), on(date)).state;
    expect(next('2026-11-30', '2026-12-01').currentStreak).toBe(2);
    expect(next('2026-12-31', '2027-01-01').currentStreak).toBe(2);
    expect(next('2028-02-28', '2028-02-29').currentStreak).toBe(2);
    expect(next('2028-02-29', '2028-03-01').currentStreak).toBe(2);
    expect(next('2027-02-28', '2027-03-01').currentStreak).toBe(2);
  });

  it('does not modify the previous state', () => {
    const before = state();
    applyActivity(before, on('2026-11-21'));
    expect(before.currentStreak).toBe(3);
  });

  it('a week of daily activity builds a streak of seven', () => {
    let current: StreakState | null = null;
    for (let day = 14; day <= 20; day += 1) {
      current = applyActivity(current, on(`2026-11-${day}`)).state;
    }
    expect(current).toMatchObject({ currentStreak: 7, longestStreak: 7, version: 7 });
  });
});

describe('daysBetween', () => {
  it('counts calendar days, positive forwards and negative backwards', () => {
    expect(daysBetween('2026-11-20', '2026-11-21')).toBe(1);
    expect(daysBetween('2026-11-21', '2026-11-20')).toBe(-1);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // across a DST change in Europe
  });
});
