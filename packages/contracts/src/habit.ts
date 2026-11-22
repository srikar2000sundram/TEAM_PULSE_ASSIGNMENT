import { z } from 'zod';
import {
  activityTypeSchema,
  habitReminderSchema,
  habitVisibilitySchema,
  idSchema,
  isoDateTimeSchema,
} from './common.js';

export const HABIT_TITLE_MAX_LENGTH = 80;
export const HABIT_DESCRIPTION_MAX_LENGTH = 500;

const titleSchema = z.string().trim().min(1).max(HABIT_TITLE_MAX_LENGTH);
const descriptionSchema = z.string().trim().max(HABIT_DESCRIPTION_MAX_LENGTH);

export const createHabitRequestSchema = z
  .strictObject({
    title: titleSchema,
    description: descriptionSchema.optional(),
    activityType: activityTypeSchema,
    /** Habits are private unless the owner explicitly shares them. */
    visibility: habitVisibilitySchema.default('private'),
    /** The team the habit is shared with. Required for `team`, not allowed for `private`. */
    teamId: idSchema.optional(),
    reminder: habitReminderSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.visibility === 'team' && value.teamId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Required when visibility is team',
      });
    }
    if (value.visibility === 'private' && value.teamId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Not allowed when visibility is private',
      });
    }
  });
export type CreateHabitRequest = z.infer<typeof createHabitRequestSchema>;

/**
 * Partial update (PATCH). `null` clears an optional field; an absent field is left alone.
 * Changing sharing always states both fields, so there is no ambiguity about the intended result.
 */
export const updateHabitRequestSchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    activityType: activityTypeSchema.optional(),
    visibility: habitVisibilitySchema.optional(),
    teamId: idSchema.optional(),
    reminder: habitReminderSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (Object.values(value).every((field) => field === undefined)) {
      context.addIssue({ code: 'custom', message: 'Provide at least one field to change' });
    }
    if (value.visibility === 'team' && value.teamId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Required when visibility is team',
      });
    }
    if (value.visibility !== 'team' && value.teamId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Only allowed together with visibility team',
      });
    }
  });
export type UpdateHabitRequest = z.infer<typeof updateHabitRequestSchema>;

export const habitResponseSchema = z.strictObject({
  id: idSchema,
  ownerUserId: idSchema,
  /** True when the caller owns the habit (only the owner can change or archive it). */
  isOwner: z.boolean(),
  title: z.string(),
  description: z.string().optional(),
  activityType: activityTypeSchema,
  visibility: habitVisibilitySchema,
  teamId: idSchema.optional(),
  reminder: habitReminderSchema.optional(),
  archivedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type HabitResponse = z.infer<typeof habitResponseSchema>;

export const listHabitsQuerySchema = z
  .strictObject({
    /** `mine`: your own habits. `team`: habits other people shared with your teams. */
    scope: z.enum(['mine', 'team']).default('mine'),
    /** Archived habits are visible to their owner only. */
    status: z.enum(['active', 'archived']).default('active'),
    activityType: activityTypeSchema.optional(),
    /** Narrow `team` scope to one of your teams. */
    teamId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, context) => {
    if (value.scope === 'team' && value.status === 'archived') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Archived habits are visible to their owner only',
      });
    }
    if (value.scope === 'mine' && value.teamId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Only allowed with scope team',
      });
    }
  });
export type ListHabitsQuery = z.infer<typeof listHabitsQuerySchema>;

export const habitListResponseSchema = z.strictObject({
  items: z.array(habitResponseSchema),
  /** Opaque. Pass it back as `cursor` to get the next page; absent on the last page. */
  nextCursor: z.string().optional(),
});
export type HabitListResponse = z.infer<typeof habitListResponseSchema>;
