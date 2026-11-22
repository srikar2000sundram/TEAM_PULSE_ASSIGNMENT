import { z } from 'zod';

export const roles = ['employee', 'manager', 'admin'] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;

export const activityTypes = [
  'walking',
  'running',
  'cycling',
  'strength',
  'yoga',
  'meditation',
  'sleep',
  'hydration',
  'nutrition',
  'other',
] as const;
export const activityTypeSchema = z.enum(activityTypes);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const habitVisibilities = ['private', 'team'] as const;
export const habitVisibilitySchema = z.enum(habitVisibilities);
export type HabitVisibility = z.infer<typeof habitVisibilitySchema>;

export const challengeStatuses = ['draft', 'active', 'completed', 'cancelled'] as const;
export const challengeStatusSchema = z.enum(challengeStatuses);
export type ChallengeStatus = z.infer<typeof challengeStatusSchema>;

export const badgeKinds = ['streak', 'total', 'milestone'] as const;
export const badgeKindSchema = z.enum(badgeKinds);
export type BadgeKind = z.infer<typeof badgeKindSchema>;

export const daysOfWeek = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const dayOfWeekSchema = z.enum(daysOfWeek);
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;

/** RFC 9562 UUID. Identifiers cross service boundaries as plain UUIDs, never as foreign keys. */
export const idSchema = z.uuid();

/** Calendar date without time zone, for example `2026-11-20`. Invalid dates such as Feb 30 fail. */
export const isoDateSchema = z.iso.date();

/** UTC instant, for example `2026-11-20T08:15:00Z`. */
export const isoDateTimeSchema = z.iso.datetime();

/** `HH:mm` in 24-hour time, used for reminder times. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

/** True for names the runtime time zone database knows, for example Europe/Berlin or UTC. */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * When to remind the owner of a habit. The time zone is part of the reminder because "07:30" means
 * nothing to a scheduler without it, and offices span several zones.
 */
export const habitReminderSchema = z.strictObject({
  daysOfWeek: z
    .array(dayOfWeekSchema)
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'Days must not repeat'),
  remindAt: timeOfDaySchema,
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'Unknown time zone, use an IANA name such as Europe/Berlin'),
});
export type HabitReminder = z.infer<typeof habitReminderSchema>;
