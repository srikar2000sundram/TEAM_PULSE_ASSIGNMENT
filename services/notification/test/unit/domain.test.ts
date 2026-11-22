import { describe, expect, it } from 'vitest';
import { notificationKinds } from '@teampulse/contracts';
import {
  DEFAULT_PREFERENCES,
  Notification,
  categoryOf,
  isEnabled,
  render,
  type NotificationContent,
} from '../../src/domain/notification.js';
import { dueOccurrence, localMoment, type ReminderSchedule } from '../../src/domain/reminder.js';
import { ALICE, uuid } from '../support/harness.js';

describe('render', () => {
  const cases: [NotificationContent, RegExp][] = [
    [{ kind: 'milestone', milestoneKind: 'streak', threshold: 7 }, /7 days in a row/],
    [{ kind: 'milestone', milestoneKind: 'total', threshold: 100 }, /completed 100 activities/],
    [{ kind: 'badge', badgeKind: 'streak' }, /streak badge/],
    [{ kind: 'challenge_completed' }, /challenge you joined has finished/],
    [{ kind: 'reminder' }, /time to do one of your habits/],
  ];

  it.each(cases)('writes sensible text for %j', (content, expected) => {
    const { title, body } = render(content);
    expect(title.length).toBeGreaterThan(0);
    expect(body).toMatch(expected);
  });

  it('a reminder never names the habit, because no event carries its title', () => {
    expect(render({ kind: 'reminder' }).body).not.toMatch(/walk|yoga|run/i);
  });
});

describe('categories and preferences', () => {
  it('maps every notification kind to a preference', () => {
    const mapped = notificationKinds.map((kind) => categoryOf(kind));
    expect(new Set(mapped)).toEqual(new Set(['milestones', 'badges', 'challenges', 'reminders']));
  });

  it('everything is on by default, and a switched-off category blocks only its kinds', () => {
    for (const kind of notificationKinds) expect(isEnabled(DEFAULT_PREFERENCES, kind)).toBe(true);
    const off = { ...DEFAULT_PREFERENCES, reminders: false };
    expect(isEnabled(off, 'reminder')).toBe(false);
    expect(isEnabled(off, 'milestone')).toBe(true);
  });
});

describe('Notification', () => {
  const create = () =>
    Notification.create({
      id: uuid(1),
      userId: ALICE,
      content: { kind: 'reminder' },
      sourceId: uuid(2),
      now: new Date('2026-11-20T08:00:00Z'),
    });

  it('starts unread', () => {
    expect(create()).toMatchObject({ isRead: false, readAt: null, kind: 'reminder' });
  });

  it('marking read keeps the first read time (idempotent) and does not modify the original', () => {
    const unread = create();
    const first = unread.markRead(new Date('2026-11-20T09:00:00Z'));
    const again = first.markRead(new Date('2026-11-20T10:00:00Z'));
    expect(first.readAt).toEqual(new Date('2026-11-20T09:00:00Z'));
    expect(again).toBe(first);
    expect(unread.isRead).toBe(false);
  });
});

describe('localMoment', () => {
  const instant = new Date('2026-11-20T08:00:00Z'); // a Friday

  it('gives the wall clock of each zone', () => {
    expect(localMoment(instant, 'UTC')).toEqual({
      day: 'fri',
      date: '2026-11-20',
      minutesIntoDay: 480,
    });
    expect(localMoment(instant, 'Europe/Berlin')).toEqual({
      day: 'fri',
      date: '2026-11-20',
      minutesIntoDay: 540,
    });
    expect(localMoment(instant, 'Asia/Tokyo').minutesIntoDay).toBe(17 * 60);
    expect(localMoment(instant, 'Asia/Kolkata').minutesIntoDay).toBe(13 * 60 + 30); // half-hour zone
  });

  it('can be a different day and date than UTC', () => {
    expect(localMoment(new Date('2026-11-20T20:00:00Z'), 'Asia/Tokyo')).toEqual({
      day: 'sat',
      date: '2026-11-21',
      minutesIntoDay: 5 * 60,
    });
    expect(localMoment(new Date('2026-11-20T03:00:00Z'), 'America/Los_Angeles')).toEqual({
      day: 'thu',
      date: '2026-11-19',
      minutesIntoDay: 19 * 60,
    });
  });

  it('reads midnight as 00:00, never 24:00', () => {
    expect(localMoment(new Date('2026-11-20T00:00:00Z'), 'UTC').minutesIntoDay).toBe(0);
    expect(
      localMoment(new Date('2026-11-20T08:00:00Z'), 'America/Los_Angeles').minutesIntoDay,
    ).toBe(0);
  });
});

describe('dueOccurrence', () => {
  const berlin = (
    remindAt: string,
    days: ReminderSchedule['daysOfWeek'] = ['fri'],
  ): ReminderSchedule => ({
    daysOfWeek: days,
    remindAt,
    timeZone: 'Europe/Berlin',
  });
  const at = (iso: string) => new Date(iso);

  it('is due from the reminder time until the window ends, not before and not after', () => {
    const schedule = berlin('09:00');
    // Berlin is UTC+1 in November: 09:00 local is 08:00 UTC.
    expect(dueOccurrence(schedule, at('2026-11-20T07:59:00Z'), 15)).toBeNull();
    expect(dueOccurrence(schedule, at('2026-11-20T08:00:00Z'), 15)).toEqual({
      localDate: '2026-11-20',
    });
    expect(dueOccurrence(schedule, at('2026-11-20T08:14:59Z'), 15)).toEqual({
      localDate: '2026-11-20',
    });
    expect(dueOccurrence(schedule, at('2026-11-20T08:15:00Z'), 15)).toBeNull();
  });

  it('only on the chosen days, judged in the reminder time zone', () => {
    expect(dueOccurrence(berlin('09:00', ['mon']), at('2026-11-20T08:00:00Z'), 15)).toBeNull();
    // 23:30 UTC on Thursday is already Friday 00:30 in Berlin.
    expect(dueOccurrence(berlin('00:30'), at('2026-11-19T23:30:00Z'), 15)).toEqual({
      localDate: '2026-11-20',
    });
  });

  it('follows daylight saving time instead of a fixed offset', () => {
    // Berlin switched to summer time on 2026-03-29: 07:30 local is 05:30 UTC afterwards, 06:30 before.
    const schedule = berlin('07:30', ['sun', 'mon']);
    expect(dueOccurrence(schedule, at('2026-03-29T05:30:00Z'), 15)).toEqual({
      localDate: '2026-03-29',
    });
    expect(dueOccurrence(schedule, at('2026-03-29T06:30:00Z'), 15)).toBeNull();
    expect(dueOccurrence(schedule, at('2026-03-23T06:30:00Z'), 15)).toEqual({
      localDate: '2026-03-23',
    });
  });

  it('does not carry a missed late-evening reminder over midnight', () => {
    const schedule = berlin('23:55', ['fri', 'sat']);
    expect(dueOccurrence(schedule, at('2026-11-20T22:56:00Z'), 15)).toEqual({
      localDate: '2026-11-20',
    });
    expect(dueOccurrence(schedule, at('2026-11-20T23:05:00Z'), 15)).toBeNull(); // 00:05 Saturday
  });

  it('gives the same local date for every instant in the window, so it is claimed once', () => {
    const schedule = berlin('09:00');
    const dates = ['08:00', '08:05', '08:10', '08:14'].map(
      (t) => dueOccurrence(schedule, at(`2026-11-20T${t}:00Z`), 15)?.localDate,
    );
    expect(new Set(dates)).toEqual(new Set(['2026-11-20']));
  });
});
