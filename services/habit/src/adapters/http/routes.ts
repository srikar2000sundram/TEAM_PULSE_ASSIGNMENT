import { z } from 'zod';
import {
  createHabitRequestSchema,
  habitListResponseSchema,
  habitResponseSchema,
  idSchema,
  listHabitsQuerySchema,
  updateHabitRequestSchema,
  type HabitResponse,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type { HabitUseCases } from '../../application/index.js';
import type { Habit } from '../../domain/habit.js';

export interface HabitRouteOptions {
  readonly useCases: HabitUseCases;
}

/**
 * Domain object in, explicit DTO out. A field leaves the service only if it is written here AND
 * declared in the (strict) response schema.
 */
export const toHabitResponse = (habit: Habit, viewerUserId: string): HabitResponse => ({
  id: habit.id,
  ownerUserId: habit.ownerUserId,
  isOwner: habit.isOwnedBy(viewerUserId),
  title: habit.title,
  ...(habit.description === null ? {} : { description: habit.description }),
  activityType: habit.activityType,
  visibility: habit.visibility,
  ...(habit.teamId === null ? {} : { teamId: habit.teamId }),
  ...(habit.reminder === null ? {} : { reminder: habit.reminder }),
  ...(habit.archivedAt === null ? {} : { archivedAt: habit.archivedAt.toISOString() }),
  createdAt: habit.createdAt.toISOString(),
  updatedAt: habit.updatedAt.toISOString(),
});

const habitIdParam = z.strictObject({ habitId: idSchema });

/** Every route needs a signed-in user. Roles grant no extra habit access (see `isVisibleTo`). */
export function buildHabitRoutes({ useCases }: HabitRouteOptions): Route[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/habits',
      summary: 'Create a habit',
      tags: ['habits'],
      auth: 'required',
      rateLimit: { max: 30, timeWindowMs: 60_000 },
      body: createHabitRequestSchema,
      success: { status: 201, schema: habitResponseSchema },
      handler: async ({ principal, body }) => {
        const result = await useCases.createHabit.execute({ actor: principal, ...body });
        return result.ok ? ok(toHabitResponse(result.value, principal.userId)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/habits',
      summary: 'List your habits, or habits teammates shared with your teams',
      tags: ['habits'],
      auth: 'required',
      query: listHabitsQuerySchema,
      success: { status: 200, schema: habitListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listHabits.execute({ actor: principal, ...query });
        if (!result.ok) return result;
        return ok({
          items: result.value.items.map((habit) => toHabitResponse(habit, principal.userId)),
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        });
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/habits/:habitId',
      summary: 'Get one habit you may see',
      tags: ['habits'],
      auth: 'required',
      params: habitIdParam,
      success: { status: 200, schema: habitResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.getHabit.execute({
          actor: principal,
          habitId: params.habitId,
        });
        return result.ok ? ok(toHabitResponse(result.value, principal.userId)) : result;
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/habits/:habitId',
      summary: 'Change your habit: details, sharing or reminder',
      tags: ['habits'],
      auth: 'required',
      rateLimit: { max: 60, timeWindowMs: 60_000 },
      params: habitIdParam,
      body: updateHabitRequestSchema,
      success: { status: 200, schema: habitResponseSchema },
      handler: async ({ principal, params, body }) => {
        const result = await useCases.updateHabit.execute({
          actor: principal,
          habitId: params.habitId,
          ...body,
        });
        return result.ok ? ok(toHabitResponse(result.value, principal.userId)) : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/habits/:habitId/archive',
      summary: 'Archive your habit (idempotent)',
      tags: ['habits'],
      auth: 'required',
      rateLimit: { max: 60, timeWindowMs: 60_000 },
      params: habitIdParam,
      success: { status: 200, schema: habitResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.archiveHabit.execute({
          actor: principal,
          habitId: params.habitId,
        });
        return result.ok ? ok(toHabitResponse(result.value, principal.userId)) : result;
      },
    }),
  ];
}
