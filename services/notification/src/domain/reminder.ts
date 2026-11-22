import { daysOfWeek, type DayOfWeek, type HabitReminder } from '@teampulse/contracts';

/** A habit's reminder as this service stores it. */
export interface ReminderSchedule {
  readonly daysOfWeek: readonly DayOfWeek[];
  /** `HH:mm`, local time in `timeZone`. */
  readonly remindAt: string;
  /** IANA name, for example `Europe/Berlin`. */
  readonly timeZone: string;
}

export const toSchedule = (reminder: HabitReminder): ReminderSchedule => ({
  daysOfWeek: reminder.daysOfWeek,
  remindAt: reminder.remindAt,
  timeZone: reminder.timeZone,
});

export interface LocalMoment {
  readonly day: DayOfWeek;
  /** `YYYY-MM-DD` in the zone. */
  readonly date: string;
  readonly minutesIntoDay: number;
}

const WEEKDAY: Readonly<Record<string, DayOfWeek>> = Object.fromEntries(
  daysOfWeek.map((day) => [day, day]),
);

/**
 * The wall-clock day, date and time in a time zone at an instant. Uses the platform's time zone
 * database, so daylight saving changes are handled by the platform rather than by arithmetic here.
 */
export function localMoment(instant: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = WEEKDAY[get('weekday').toLowerCase().slice(0, 3)];
  if (day === undefined) throw new Error('Unrecognised weekday from the time zone database');
  return {
    day,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesIntoDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/**
 * Is this reminder due at `now`? Due means: today is one of its days and the local time is at or
 * after the reminder time but less than `windowMinutes` after it. The window lets a brief outage
 * or a slow tick still deliver the reminder, while a reminder from hours ago is not sent late. It
 * does not carry over midnight: a 23:55 reminder missed until 00:05 is skipped.
 *
 * Returns the local date, which together with the habit identifies this occurrence, so the same
 * reminder is never sent twice for the same day.
 */
export function dueOccurrence(
  schedule: ReminderSchedule,
  now: Date,
  windowMinutes: number,
): { localDate: string } | null {
  const local = localMoment(now, schedule.timeZone);
  if (!schedule.daysOfWeek.includes(local.day)) return null;
  const sinceReminder = local.minutesIntoDay - minutesOf(schedule.remindAt);
  return sinceReminder >= 0 && sinceReminder < windowMinutes ? { localDate: local.date } : null;
}
