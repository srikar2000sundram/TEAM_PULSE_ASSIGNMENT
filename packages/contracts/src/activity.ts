import { z } from 'zod';
import { activityTypeSchema, idSchema, isoDateSchema, isoDateTimeSchema } from './common.js';

/**
 * Record that the signed-in user completed a habit on a day. The user, the activity type and the
 * team snapshot come from the token and from the habit itself, never from the request, so a client
 * cannot claim someone else's activity.
 */
export const recordActivityRequestSchema = z.strictObject({
  habitId: idSchema,
  /** The calendar day the habit was done, for example `2026-11-20`. */
  activityDate: isoDateSchema,
});
export type RecordActivityRequest = z.infer<typeof recordActivityRequestSchema>;

export const activityResponseSchema = z.strictObject({
  id: idSchema,
  habitId: idSchema,
  activityType: activityTypeSchema,
  activityDate: isoDateSchema,
  createdAt: isoDateTimeSchema,
  /**
   * True when this habit was already recorded for this day, so nothing new was stored and no event
   * was published. Retrying a request is therefore always safe.
   */
  alreadyRecorded: z.boolean(),
});
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

export const listActivitiesQuerySchema = z
  .strictObject({
    /** First day to include. */
    from: isoDateSchema.optional(),
    /** Last day to include. */
    to: isoDateSchema.optional(),
    habitId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, context) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'Must not be before from' });
    }
  });
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;

export const activityListResponseSchema = z.strictObject({
  items: z.array(activityResponseSchema),
  /** Opaque. Pass it back as `cursor`; absent on the last page. */
  nextCursor: z.string().optional(),
});
export type ActivityListResponse = z.infer<typeof activityListResponseSchema>;
