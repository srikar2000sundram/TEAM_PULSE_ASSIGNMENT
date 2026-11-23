import { z } from 'zod';
import {
  decideRecommendationRequestSchema,
  decisionResponseSchema,
  idSchema,
  listRecommendationsQuerySchema,
  recommendationListResponseSchema,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type { RecommendationUseCases } from '../../application/index.js';

export interface RecommendationRouteOptions {
  readonly useCases: RecommendationUseCases;
}

const habitParam = z.strictObject({ habitId: idSchema });

/** Every route needs a signed-in user and only ever touches that user's own history. */
export function buildRecommendationRoutes({ useCases }: RecommendationRouteOptions): Route[] {
  const decide = (decision: 'accepted' | 'dismissed') =>
    defineRoute({
      method: 'POST',
      path:
        decision === 'accepted'
          ? '/recommendations/:habitId/accept'
          : '/recommendations/:habitId/dismiss',
      summary:
        decision === 'accepted'
          ? 'Accept a timing recommendation (idempotent)'
          : 'Dismiss a timing recommendation (idempotent)',
      tags: ['recommendations'],
      auth: 'required',
      rateLimit: { max: 60, timeWindowMs: 60_000 },
      params: habitParam,
      body: decideRecommendationRequestSchema,
      success: { status: 200, schema: decisionResponseSchema },
      handler: async ({ principal, params, body }) => {
        const result = await useCases.decideRecommendation.execute({
          actor: principal,
          habitId: params.habitId,
          suggestedTime: body.suggestedTime,
          timeZone: body.timeZone,
          decision,
        });
        return result.ok ? ok(result.value) : result;
      },
    });

  return [
    defineRoute({
      method: 'GET',
      path: '/recommendations',
      summary: 'Your personalised timing recommendations, strongest evidence first',
      tags: ['recommendations'],
      auth: 'required',
      query: listRecommendationsQuerySchema,
      success: { status: 200, schema: recommendationListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listRecommendations.execute({
          actor: principal,
          timeZone: query.timeZone,
        });
        return result.ok ? ok({ items: [...result.value] }) : result;
      },
    }),
    decide('accepted'),
    decide('dismissed'),
  ];
}
