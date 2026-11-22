import { z } from 'zod';
import {
  idSchema,
  listNotificationsQuerySchema,
  notificationListResponseSchema,
  notificationPreferencesSchema,
  notificationResponseSchema,
  updateNotificationPreferencesRequestSchema,
  type NotificationResponse,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type { NotificationUseCases } from '../../application/index.js';
import { render, type Notification } from '../../domain/notification.js';

export interface NotificationRouteOptions {
  readonly useCases: NotificationUseCases;
}

/**
 * Domain object in, explicit DTO out. The text is rendered here from the stored kind and numbers,
 * so it can change without touching stored data.
 */
export const toNotificationResponse = (notification: Notification): NotificationResponse => ({
  id: notification.id,
  kind: notification.kind,
  ...render(notification.content),
  createdAt: notification.createdAt.toISOString(),
  ...(notification.readAt === null ? {} : { readAt: notification.readAt.toISOString() }),
});

const notificationIdParam = z.strictObject({ notificationId: idSchema });

/** Every route needs a signed-in user and only ever touches that user's own data. */
export function buildNotificationRoutes({ useCases }: NotificationRouteOptions): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/notifications',
      summary: 'List your notifications, newest first',
      tags: ['notifications'],
      auth: 'required',
      query: listNotificationsQuerySchema,
      success: { status: 200, schema: notificationListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listNotifications.execute({
          actor: principal,
          unreadOnly: query.unread,
          limit: query.limit,
          cursor: query.cursor,
        });
        if (!result.ok) return result;
        return ok({
          items: result.value.items.map(toNotificationResponse),
          unreadCount: result.value.unreadCount,
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        });
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/notifications/:notificationId/read',
      summary: 'Mark one of your notifications as read (idempotent)',
      tags: ['notifications'],
      auth: 'required',
      rateLimit: { max: 120, timeWindowMs: 60_000 },
      params: notificationIdParam,
      success: { status: 200, schema: notificationResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.markNotificationRead.execute({
          actor: principal,
          notificationId: params.notificationId,
        });
        return result.ok ? ok(toNotificationResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/preferences',
      summary: 'Which kinds of notification you receive',
      tags: ['preferences'],
      auth: 'required',
      success: { status: 200, schema: notificationPreferencesSchema },
      handler: async ({ principal }) => useCases.getPreferences.execute({ actor: principal }),
    }),

    defineRoute({
      method: 'PATCH',
      path: '/preferences',
      summary: 'Switch kinds of notification on or off',
      tags: ['preferences'],
      auth: 'required',
      rateLimit: { max: 30, timeWindowMs: 60_000 },
      body: updateNotificationPreferencesRequestSchema,
      success: { status: 200, schema: notificationPreferencesSchema },
      handler: async ({ principal, body }) =>
        useCases.updatePreferences.execute({
          actor: principal,
          changes: Object.fromEntries(
            Object.entries(body).filter(([, value]) => value !== undefined),
          ),
        }),
    }),
  ];
}
