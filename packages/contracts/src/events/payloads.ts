import { z } from 'zod';
import {
  activityTypeSchema,
  badgeKindSchema,
  habitReminderSchema,
  habitVisibilitySchema,
  idSchema,
  isoDateSchema,
  roleSchema,
} from '../common.js';

/**
 * Event payloads carry identifiers, counts and dates. They never carry habit titles, notes or any
 * other free text (see ADR-0005). Fields are added only when a consumer needs them.
 */

const teamIdsSchema = z.array(idSchema).max(20);
const nonNegativeInt = z.number().int().min(0);

/** `teamIds` is a snapshot of the user's team memberships when the activity happened. */
export const activityCompletedPayload = z.strictObject({
  userId: idSchema,
  habitId: idSchema,
  teamIds: teamIdsSchema,
  activityType: activityTypeSchema,
  activityDate: isoDateSchema,
  /**
   * How many activities this user has recorded, including this one, when it was stored. A count,
   * never content. It lets the badge Lambda announce "total" milestones without keeping state.
   */
  totalCompleted: z.number().int().positive(),
});

export const streakUpdatedPayload = z.strictObject({
  userId: idSchema,
  habitId: idSchema,
  currentStreak: nonNegativeInt,
  longestStreak: nonNegativeInt,
  activityDate: isoDateSchema,
});

export const badgeAwardedPayload = z.strictObject({
  userId: idSchema,
  challengeId: idSchema,
  badgeRuleId: idSchema,
  kind: badgeKindSchema,
  awardedOn: isoDateSchema,
});

export const challengeProgressUpdatedPayload = z.strictObject({
  challengeId: idSchema,
  userId: idSchema,
  pointsDelta: z.number().int().positive(),
  /** The `ActivityCompleted` event that caused the points, for traceability and idempotency. */
  sourceEventId: idSchema,
});

export const milestoneReachedPayload = z.strictObject({
  userId: idSchema,
  kind: z.enum(['streak', 'total']),
  threshold: z.number().int().positive(),
  habitId: idSchema.optional(),
});

export const challengeJoinedPayload = z.strictObject({
  challengeId: idSchema,
  userId: idSchema,
  teamId: idSchema,
});

export const challengeCompletedPayload = z.strictObject({
  challengeId: idSchema,
  completedOn: isoDateSchema,
});

const habitSnapshot = {
  habitId: idSchema,
  ownerUserId: idSchema,
  visibility: habitVisibilitySchema,
  activityType: activityTypeSchema,
  /** Present only when the owner wants reminders. Used to schedule notifications. */
  reminder: habitReminderSchema.optional(),
};

export const habitCreatedPayload = z.strictObject(habitSnapshot);

/**
 * The habit as it is now. Consumers replace what they hold (for example the reminder schedule), so
 * clearing the reminder is an update with `reminder` absent.
 */
export const habitUpdatedPayload = z.strictObject(habitSnapshot);

export const habitArchivedPayload = z.strictObject({
  habitId: idSchema,
  ownerUserId: idSchema,
});

export const userRegisteredPayload = z.strictObject({
  userId: idSchema,
  role: roleSchema,
});

export const teamMembershipChangedPayload = z.strictObject({
  userId: idSchema,
  teamId: idSchema,
  change: z.enum(['added', 'removed']),
});

/** Right to erasure: every service removes or anonymises the user's data on receipt. */
export const userDeletedPayload = z.strictObject({
  userId: idSchema,
});
