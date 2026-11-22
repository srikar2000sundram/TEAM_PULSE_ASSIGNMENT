import { z } from 'zod';
import { activityTypeSchema, idSchema, isoDateSchema } from './common.js';

/** The longest period one analytics request may cover. */
export const MAX_INSIGHT_DAYS = 92;

const DAY_MS = 86_400_000;

/** Number of calendar days from `from` to `to`, both included. Both must be valid `YYYY-MM-DD`. */
export function daysInPeriod(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** `from` and `to` are calendar days, both included. */
export const insightPeriodQuerySchema = z
  .strictObject({
    from: isoDateSchema,
    to: isoDateSchema,
  })
  .superRefine((value, context) => {
    if (value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'Must not be before from' });
    } else if (daysInPeriod(value.from, value.to) > MAX_INSIGHT_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `The period may cover at most ${MAX_INSIGHT_DAYS} days`,
      });
    }
  });
export type InsightPeriodQuery = z.infer<typeof insightPeriodQuerySchema>;

/**
 * One number about a group. When too few people stand behind it the number is withheld, and so is
 * the size of the group: either would help to identify someone (ADR-0005).
 */
export const releasedCellSchema = z.discriminatedUnion('suppressed', [
  z.strictObject({
    suppressed: z.literal(false),
    completions: z.number().int().min(0),
    /** How many different people did them. Always at least the configured minimum. */
    participants: z.number().int().min(1),
  }),
  z.strictObject({
    suppressed: z.literal(true),
    /** `cohort_too_small`: fewer people than the minimum. `complementary`: hidden so that another hidden number cannot be worked out by subtraction. */
    reason: z.enum(['cohort_too_small', 'complementary']),
  }),
]);
export type ReleasedCell = z.infer<typeof releasedCellSchema>;

export const teamActivityReportSchema = z.strictObject({
  scope: z.enum(['team', 'organization']),
  /** Present for a team report. */
  teamId: idSchema.optional(),
  from: isoDateSchema,
  to: isoDateSchema,
  /** The smallest group that may be shown, so the interface can explain a hidden number. */
  minCohortSize: z.number().int().min(3),
  total: releasedCellSchema,
  /** Only activity types with data appear. */
  byActivityType: z.partialRecord(activityTypeSchema, releasedCellSchema),
  /** Only days with data appear, oldest first. */
  byDay: z.array(z.strictObject({ date: isoDateSchema, cell: releasedCellSchema })),
});
export type TeamActivityReport = z.infer<typeof teamActivityReportSchema>;

/** Your own numbers. They are about one person, so nothing is hidden. */
export const myActivityReportSchema = z.strictObject({
  from: isoDateSchema,
  to: isoDateSchema,
  total: z.number().int().min(0),
  byActivityType: z.partialRecord(activityTypeSchema, z.number().int().min(1)),
  byDay: z.array(z.strictObject({ date: isoDateSchema, completions: z.number().int().min(1) })),
});
export type MyActivityReport = z.infer<typeof myActivityReportSchema>;
