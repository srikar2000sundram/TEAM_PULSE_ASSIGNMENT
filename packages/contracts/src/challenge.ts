import { z } from 'zod';
import {
  activityTypeSchema,
  badgeKindSchema,
  challengeStatusSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
} from './common.js';

export const CHALLENGE_NAME_MAX_LENGTH = 80;
export const MAX_CHALLENGE_DAYS = 366;
export const MAX_BADGE_RULES = 10;
export const MAX_BADGE_THRESHOLD = 1000;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * What a badge measures, inside one challenge:
 * - `streak`: the longest run of consecutive days with a qualifying activity;
 * - `total`: the number of qualifying activities;
 * - `milestone`: the number of different days on which the person took part.
 */
export const badgeRuleInputSchema = z.strictObject({
  kind: badgeKindSchema,
  threshold: z.number().int().min(1).max(MAX_BADGE_THRESHOLD),
});
export type BadgeRuleInput = z.infer<typeof badgeRuleInputSchema>;

export const createChallengeRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(CHALLENGE_NAME_MAX_LENGTH),
    /** Only activities of this type score. */
    activityType: activityTypeSchema,
    /** The team that may take part. */
    teamId: idSchema,
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    badgeRules: z.array(badgeRuleInputSchema).max(MAX_BADGE_RULES).default([]),
  })
  .superRefine((value, context) => {
    if (value.startsOn > value.endsOn) {
      context.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: 'Must not be before startsOn',
      });
    } else if (daysBetween(value.startsOn, value.endsOn) > MAX_CHALLENGE_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: `A challenge may last at most ${MAX_CHALLENGE_DAYS} days`,
      });
    }
    const keys = value.badgeRules.map((rule) => `${rule.kind}:${rule.threshold}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', path: ['badgeRules'], message: 'Rules must not repeat' });
    }
  });
export type CreateChallengeRequest = z.infer<typeof createChallengeRequestSchema>;

export const badgeRuleResponseSchema = z.strictObject({
  id: idSchema,
  kind: badgeKindSchema,
  threshold: z.number().int().positive(),
});

export const challengeResponseSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  activityType: activityTypeSchema,
  teamId: idSchema,
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  status: challengeStatusSchema,
  badgeRules: z.array(badgeRuleResponseSchema),
  participantCount: z.number().int().min(0),
  /** Whether you are taking part. */
  joined: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const listChallengesQuerySchema = z.strictObject({
  status: challengeStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListChallengesQuery = z.infer<typeof listChallengesQuerySchema>;

export const challengeListResponseSchema = z.strictObject({
  items: z.array(challengeResponseSchema),
  /** Opaque. Pass it back as `cursor`; absent on the last page. */
  nextCursor: z.string().optional(),
});
export type ChallengeListResponse = z.infer<typeof challengeListResponseSchema>;

export const leaderboardQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const leaderboardEntrySchema = z.strictObject({
  /** Equal points share a rank, and the next rank is skipped (1, 2, 2, 4). */
  rank: z.number().int().positive(),
  userId: idSchema,
  points: z.number().int().min(0),
  isYou: z.boolean(),
});

export const leaderboardResponseSchema = z.strictObject({
  challengeId: idSchema,
  status: challengeStatusSchema,
  participantCount: z.number().int().min(0),
  entries: z.array(leaderboardEntrySchema),
  /** Your place, also when you are not among the entries shown. Absent if you are not taking part. */
  you: z
    .strictObject({ rank: z.number().int().positive(), points: z.number().int().min(0) })
    .optional(),
});
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;

export const challengeProgressResponseSchema = z.strictObject({
  challengeId: idSchema,
  points: z.number().int().min(0),
  activeDays: z.number().int().min(0),
  longestStreak: z.number().int().min(0),
  badges: z.array(
    z.strictObject({
      badgeRuleId: idSchema,
      kind: badgeKindSchema,
      threshold: z.number().int().positive(),
      awardedOn: isoDateSchema,
    }),
  ),
});
export type ChallengeProgressResponse = z.infer<typeof challengeProgressResponseSchema>;
