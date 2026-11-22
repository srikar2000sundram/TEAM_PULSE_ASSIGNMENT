import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/** What a notification is about. The text is rendered from the kind and its parameters. */
export const notificationKinds = ['milestone', 'badge', 'challenge_completed', 'reminder'] as const;
export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** The categories a person can switch off. Several kinds can share a category. */
export const notificationPreferenceKeys = [
  'milestones',
  'badges',
  'challenges',
  'reminders',
] as const;

export const notificationPreferencesSchema = z.strictObject({
  milestones: z.boolean(),
  badges: z.boolean(),
  challenges: z.boolean(),
  reminders: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Partial update: only the categories given change. */
export const updateNotificationPreferencesRequestSchema = z
  .strictObject({
    milestones: z.boolean().optional(),
    badges: z.boolean().optional(),
    challenges: z.boolean().optional(),
    reminders: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one preference to change',
  });
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;

export const notificationResponseSchema = z.strictObject({
  id: idSchema,
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string(),
  createdAt: isoDateTimeSchema,
  /** Absent while unread. */
  readAt: isoDateTimeSchema.optional(),
});
export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const listNotificationsQuerySchema = z.strictObject({
  /** `true` lists only unread notifications. */
  unread: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationListResponseSchema = z.strictObject({
  items: z.array(notificationResponseSchema),
  /** How many unread notifications there are in total, not only on this page. */
  unreadCount: z.number().int().min(0),
  /** Opaque. Pass it back as `cursor`; absent on the last page. */
  nextCursor: z.string().optional(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
