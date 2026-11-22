import { describe, expect, it } from 'vitest';
import { checkActivityDate, utcDay, DEFAULT_DATE_POLICY } from '../../src/domain/activity.js';

const NOW = new Date('2026-11-20T08:00:00Z');
const check = (date: string, now = NOW, backfillDays = 7) =>
  checkActivityDate(date, now, { backfillDays });

describe('checkActivityDate', () => {
  it('accepts today, the past week, and tomorrow (people east of UTC)', () => {
    for (const date of ['2026-11-20', '2026-11-19', '2026-11-13', '2026-11-21']) {
      expect(check(date).ok, date).toBe(true);
    }
  });

  it('rejects the day after tomorrow and later as the future', () => {
    for (const date of ['2026-11-22', '2027-01-01']) {
      const result = check(date);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('activity.date_in_future');
    }
  });

  it('rejects days beyond the back-fill window', () => {
    const result = check('2026-11-12');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('activity.date_too_old');
      expect(result.error.kind).toBe('validation');
    }
  });

  it('honours the configured window, including zero (today only, plus the timezone allowance)', () => {
    expect(check('2026-11-19', NOW, 0).ok).toBe(false);
    expect(check('2026-11-20', NOW, 0).ok).toBe(true);
    expect(check('2026-11-01', NOW, 30).ok).toBe(true);
  });

  it('uses the UTC day, so a late-evening instant does not shift the window', () => {
    const lateUtc = new Date('2026-11-20T23:59:00Z');
    expect(utcDay(lateUtc)).toBe('2026-11-20');
    expect(check('2026-11-21', lateUtc).ok).toBe(true);
    expect(check('2026-11-22', lateUtc).ok).toBe(false);
  });

  it('works across month and year boundaries and leap days', () => {
    const newYear = new Date('2027-01-02T00:00:00Z');
    expect(check('2026-12-26', newYear).ok).toBe(true);
    expect(check('2026-12-25', newYear).ok).toBe(false);
    const leap = new Date('2028-03-01T00:00:00Z');
    expect(check('2028-02-29', leap).ok).toBe(true);
  });

  it('defaults to a one-week window', () => {
    expect(DEFAULT_DATE_POLICY.backfillDays).toBe(7);
  });
});
