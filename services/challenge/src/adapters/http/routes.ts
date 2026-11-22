import { z } from 'zod';
import {
  challengeListResponseSchema,
  challengeProgressResponseSchema,
  challengeResponseSchema,
  createChallengeRequestSchema,
  idSchema,
  leaderboardQuerySchema,
  leaderboardResponseSchema,
  listChallengesQuerySchema,
  type ChallengeProgressResponse,
  type ChallengeResponse,
  type LeaderboardResponse,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type {
  ChallengeUseCases,
  ChallengeView,
  Leaderboard,
  MyProgress,
} from '../../application/index.js';

export interface ChallengeRouteOptions {
  readonly useCases: ChallengeUseCases;
}

/** Domain object in, explicit DTO out. Nothing else about the challenge leaves the service. */
export const toChallengeResponse = ({
  challenge,
  participantCount,
  joined,
}: ChallengeView): ChallengeResponse => ({
  id: challenge.id,
  name: challenge.name,
  activityType: challenge.activityType,
  teamId: challenge.teamId,
  startsOn: challenge.startsOn,
  endsOn: challenge.endsOn,
  status: challenge.status,
  badgeRules: challenge.badgeRules.map(({ id, kind, threshold }) => ({ id, kind, threshold })),
  participantCount,
  joined,
  createdAt: challenge.createdAt.toISOString(),
});

const toLeaderboardResponse = (board: Leaderboard, viewerId: string): LeaderboardResponse => ({
  challengeId: board.challengeId,
  status: board.status,
  participantCount: board.participantCount,
  entries: board.entries.map((entry) => ({
    rank: entry.rank,
    userId: entry.userId,
    points: entry.points,
    isYou: entry.userId === viewerId,
  })),
  ...(board.you === null ? {} : { you: { rank: board.you.rank, points: board.you.points } }),
});

const toProgressResponse = ({
  challengeId,
  stats,
  badges,
}: MyProgress): ChallengeProgressResponse => ({
  challengeId,
  points: stats.points,
  activeDays: stats.activeDays,
  longestStreak: stats.longestStreak,
  badges: badges.map(({ rule, awardedOn }) => ({
    badgeRuleId: rule.id,
    kind: rule.kind,
    threshold: rule.threshold,
    awardedOn,
  })),
});

const challengeIdParam = z.strictObject({ challengeId: idSchema });
const CHANGE_LIMIT = { max: 30, timeWindowMs: 60_000 } as const;

/** Every route needs a signed-in user. What a person may see or change is decided in the use cases. */
export function buildChallengeRoutes({ useCases }: ChallengeRouteOptions): Route[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/challenges',
      summary: 'Create a challenge for a team you manage (it starts as a draft)',
      tags: ['challenges'],
      auth: 'required',
      rateLimit: CHANGE_LIMIT,
      body: createChallengeRequestSchema,
      success: { status: 201, schema: challengeResponseSchema },
      handler: async ({ principal, body }) => {
        const result = await useCases.createChallenge.execute({ actor: principal, ...body });
        return result.ok ? ok(toChallengeResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/challenges',
      summary: 'List the challenges you may see, newest first',
      tags: ['challenges'],
      auth: 'required',
      query: listChallengesQuerySchema,
      success: { status: 200, schema: challengeListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listChallenges.execute({ actor: principal, ...query });
        if (!result.ok) return result;
        return ok({
          items: result.value.items.map(toChallengeResponse),
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        });
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/challenges/:challengeId',
      summary: 'Read one challenge',
      tags: ['challenges'],
      auth: 'required',
      params: challengeIdParam,
      success: { status: 200, schema: challengeResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.getChallenge.execute({
          actor: principal,
          challengeId: params.challengeId,
        });
        return result.ok ? ok(toChallengeResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/challenges/:challengeId/start',
      summary: 'Start a draft challenge now (managers of its team and administrators)',
      tags: ['challenges'],
      auth: 'required',
      rateLimit: CHANGE_LIMIT,
      params: challengeIdParam,
      success: { status: 200, schema: challengeResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.startChallenge.execute({
          actor: principal,
          challengeId: params.challengeId,
        });
        return result.ok ? ok(toChallengeResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/challenges/:challengeId/cancel',
      summary: 'Cancel a draft or active challenge (managers of its team and administrators)',
      tags: ['challenges'],
      auth: 'required',
      rateLimit: CHANGE_LIMIT,
      params: challengeIdParam,
      success: { status: 200, schema: challengeResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.cancelChallenge.execute({
          actor: principal,
          challengeId: params.challengeId,
        });
        return result.ok ? ok(toChallengeResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/challenges/:challengeId/join',
      summary: 'Join an active challenge of one of your teams (idempotent)',
      tags: ['participation'],
      auth: 'required',
      rateLimit: CHANGE_LIMIT,
      params: challengeIdParam,
      success: { status: 200, schema: challengeResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.joinChallenge.execute({
          actor: principal,
          challengeId: params.challengeId,
        });
        return result.ok ? ok(toChallengeResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/challenges/:challengeId/leaderboard',
      summary: 'The standings: for participants, managers of the team and administrators',
      tags: ['participation'],
      auth: 'required',
      params: challengeIdParam,
      query: leaderboardQuerySchema,
      success: { status: 200, schema: leaderboardResponseSchema },
      handler: async ({ principal, params, query }) => {
        const result = await useCases.getLeaderboard.execute({
          actor: principal,
          challengeId: params.challengeId,
          limit: query.limit,
        });
        return result.ok ? ok(toLeaderboardResponse(result.value, principal.userId)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/challenges/:challengeId/progress',
      summary: 'Your own points, streak and badges in a challenge',
      tags: ['participation'],
      auth: 'required',
      params: challengeIdParam,
      success: { status: 200, schema: challengeProgressResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.getMyProgress.execute({
          actor: principal,
          challengeId: params.challengeId,
        });
        return result.ok ? ok(toProgressResponse(result.value)) : result;
      },
    }),
  ];
}
