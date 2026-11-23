import { describe, expect, it } from 'vitest';
import { MIN_SAMPLES, localHour, suggestTime } from '../../src/domain/timing.js';

/** A completion on a given November day at a given UTC hour. */
const at = (day: number, hourUtc: number, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, hourUtc, minute));

describe('localHour', () => {
  it('reads the wall-clock hour in the given zone', () => {
    expect(localHour(at(20, 8), 'UTC')).toBe(8);
    expect(localHour(at(20, 8), 'Europe/Berlin')).toBe(9); // CET in November
    expect(localHour(at(20, 23, 30), 'Asia/Kolkata')).toBe(5); // +5:30, next day
  });

  it('follows daylight saving time', () => {
    const summer = new Date(Date.UTC(2026, 6, 1, 8, 0)); // CEST
    expect(localHour(summer, 'Europe/Berlin')).toBe(10);
    expect(localHour(at(20, 8), 'Europe/Berlin')).toBe(9);
  });

  it('reports midnight as hour 0, never 24', () => {
    expect(localHour(at(20, 0), 'UTC')).toBe(0);
    expect(localHour(at(19, 23, 59), 'Europe/Berlin')).toBe(0);
  });
});

describe('suggestTime', () => {
  it('needs enough history before it suggests anything', () => {
    const few = Array.from({ length: MIN_SAMPLES - 1 }, (_, day) => at(day + 1, 7));
    expect(suggestTime(few, 'UTC')).toBeNull();
    expect(suggestTime([], 'UTC')).toBeNull();
  });

  it('suggests the start of the hour the person most often does the habit', () => {
    const times = [
      at(1, 7, 5),
      at(2, 7, 40),
      at(3, 7, 15),
      at(4, 7, 55),
      at(5, 18, 0),
      at(6, 7, 30),
    ];
    expect(suggestTime(times, 'UTC')).toEqual({
      hour: 7,
      suggestedTime: '07:00',
      sampleSize: 6,
      matching: 5,
      confidence: 'high',
    });
  });

  it('computes the hour in the requested zone, not in UTC', () => {
    const times = Array.from({ length: 6 }, (_, day) => at(day + 1, 6, 10));
    expect(suggestTime(times, 'UTC')?.suggestedTime).toBe('06:00');
    expect(suggestTime(times, 'Europe/Berlin')?.suggestedTime).toBe('07:00');
    expect(suggestTime(times, 'America/New_York')?.suggestedTime).toBe('01:00');
  });

  it('says nothing when no hour clearly stands out', () => {
    // Six completions spread over six different hours: the best hour holds 1/6 of them.
    const scattered = [6, 9, 12, 15, 18, 21].map((hour, day) => at(day + 1, hour));
    expect(suggestTime(scattered, 'UTC')).toBeNull();
  });

  it('grades confidence by how dominant the hour is', () => {
    const make = (matching: number, total: number) => [
      ...Array.from({ length: matching }, (_, day) => at(day + 1, 7)),
      ...Array.from({ length: total - matching }, (_, day) => at(day + 1, 15 + (day % 6))),
    ];
    expect(suggestTime(make(8, 10), 'UTC')?.confidence).toBe('high'); // 0.8
    expect(suggestTime(make(6, 10), 'UTC')?.confidence).toBe('medium'); // 0.6
    expect(suggestTime(make(4, 10), 'UTC')?.confidence).toBe('low'); // 0.4, still shown
    expect(suggestTime(make(3, 10), 'UTC')).toBeNull(); // 0.3, below the minimum share
  });

  it('breaks ties towards the earlier hour, whatever order the data arrives in', () => {
    const times = [at(1, 20), at(2, 8), at(3, 20), at(4, 8), at(5, 20), at(6, 8)];
    const forwards = suggestTime(times, 'UTC');
    const backwards = suggestTime([...times].reverse(), 'UTC');
    expect(forwards?.suggestedTime).toBe('08:00');
    expect(backwards).toEqual(forwards);
  });

  it('is pure: the same input gives the same answer', () => {
    const times = Array.from({ length: 7 }, (_, day) => at(day + 1, 12, day));
    expect(suggestTime(times, 'Europe/Berlin')).toEqual(suggestTime(times, 'Europe/Berlin'));
  });
});
