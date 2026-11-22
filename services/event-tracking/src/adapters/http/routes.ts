import {
  activityListResponseSchema,
  activityResponseSchema,
  listActivitiesQuerySchema,
  recordActivityRequestSchema,
  type ActivityResponse,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type { EventTrackingUseCases } from '../../application/index.js';
import type { Activity } from '../../domain/activity.js';

export interface EventTrackingRouteOptions {
  readonly useCases: EventTrackingUseCases;
}

/**
 * Domain object in, explicit DTO out. Note what is NOT here: the team snapshot and the user id.
 * They are internal to the event; a client only ever sees its own activity.
 */
export const toActivityResponse = (
  activity: Activity,
  alreadyRecorded: boolean,
): ActivityResponse => ({
  id: activity.id,
  habitId: activity.habitId,
  activityType: activity.activityType,
  activityDate: activity.activityDate,
  createdAt: activity.createdAt.toISOString(),
  alreadyRecorded,
});

export function buildEventTrackingRoutes({ useCases }: EventTrackingRouteOptions): Route[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/activities',
      summary: 'Record that you completed a habit on a day (idempotent)',
      tags: ['activities'],
      auth: 'required',
      // Marking habits done is the busiest write in the platform, but a person does not do it
      // hundreds of times a minute.
      rateLimit: { max: 120, timeWindowMs: 60_000 },
      body: recordActivityRequestSchema,
      success: { status: 201, schema: activityResponseSchema },
      handler: async ({ principal, body }) => {
        const result = await useCases.recordActivity.execute({ actor: principal, ...body });
        return result.ok
          ? ok(toActivityResponse(result.value.activity, !result.value.created))
          : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/activities',
      summary: 'List your recorded activities',
      tags: ['activities'],
      auth: 'required',
      query: listActivitiesQuerySchema,
      success: { status: 200, schema: activityListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listActivities.execute({ actor: principal, ...query });
        if (!result.ok) return result;
        return ok({
          items: result.value.items.map((activity) => toActivityResponse(activity, false)),
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        });
      },
    }),
  ];
}
