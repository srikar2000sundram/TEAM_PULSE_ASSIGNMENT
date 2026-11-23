import { z } from 'zod';
import { idSchema, isValidTimeZone, timeOfDaySchema } from './common.js';

/**
 * Timing recommendations: when in the day a person usually does a habit, so a reminder can be set for
 * the time that suits them. Only ever about the signed-in person's own habits (see ADR-0023).
 */

/** An IANA zone name such as `Europe/Berlin`. The recommendation is computed in this zone. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Unknown time zone, use an IANA name such as Europe/Berlin');

export const recommendationStatuses = ['pending', 'accepted', 'dismissed'] as const;
export const recommendationStatusSchema = z.enum(recommendationStatuses);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

/** How strongly the person's history points at one time. Low is shown but flagged as tentative. */
export const recommendationConfidences = ['low', 'medium', 'high'] as const;
export const recommendationConfidenceSchema = z.enum(recommendationConfidences);
export type RecommendationConfidence = z.infer<typeof recommendationConfidenceSchema>;

export const listRecommendationsQuerySchema = z.strictObject({
  timeZone: timeZoneSchema,
});
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsQuerySchema>;

export const recommendationResponseSchema = z.strictObject({
  habitId: idSchema,
  /** The start of the hour the person most often does this habit, in their time zone. */
  suggestedTime: timeOfDaySchema,
  timeZone: timeZoneSchema,
  /** How many completions of this habit the recommendation looked at. */
  sampleSize: z.number().int().positive(),
  /** How many of those fall in the suggested hour. */
  matching: z.number().int().positive(),
  confidence: recommendationConfidenceSchema,
  status: recommendationStatusSchema,
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export const recommendationListResponseSchema = z.strictObject({
  items: z.array(recommendationResponseSchema),
});
export type RecommendationListResponse = z.infer<typeof recommendationListResponseSchema>;

/**
 * Accept or dismiss a recommendation. The time and zone are sent back so the decision is about
 * exactly the suggestion the person saw, even if a newer one has appeared since.
 */
export const decideRecommendationRequestSchema = z.strictObject({
  suggestedTime: timeOfDaySchema,
  timeZone: timeZoneSchema,
});
export type DecideRecommendationRequest = z.infer<typeof decideRecommendationRequestSchema>;

export const decisionResponseSchema = z.strictObject({
  habitId: idSchema,
  suggestedTime: timeOfDaySchema,
  timeZone: timeZoneSchema,
  status: z.enum(['accepted', 'dismissed']),
});
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
