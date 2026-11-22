import { z } from 'zod';
import {
  idSchema,
  insightPeriodQuerySchema,
  myActivityReportSchema,
  teamActivityReportSchema,
  type ReleasedCell,
  type TeamActivityReport,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { ok } from '@teampulse/kernel';
import type { Released } from '@teampulse/privacy';
import type { InsightUseCases } from '../../application/index.js';
import type { TeamReportData } from '../../domain/report.js';

export interface InsightRouteOptions {
  readonly useCases: InsightUseCases;
}

/** Maps what the privacy package releases to the wire shape. A hidden cell carries no number. */
const toCell = (released: Released): ReleasedCell =>
  released.suppressed
    ? { suppressed: true, reason: released.reason }
    : { suppressed: false, completions: released.value, participants: released.cohortSize };

const toTeamReport = (
  scope: { scope: 'team'; teamId: string } | { scope: 'organization' },
  period: { from: string; to: string },
  data: TeamReportData,
  minCohortSize: number,
): TeamActivityReport => ({
  ...scope,
  ...period,
  minCohortSize,
  total: toCell(data.total),
  byActivityType: Object.fromEntries(
    Object.entries(data.byActivityType).map(([type, released]) => [type, toCell(released)]),
  ),
  byDay: data.byDay.map(({ date, cell }) => ({ date, cell: toCell(cell) })),
});

const teamParam = z.strictObject({ teamId: idSchema });

/** Every route needs a signed-in user. What a person may see is decided in the use cases. */
export function buildInsightRoutes({ useCases }: InsightRouteOptions): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/teams/:teamId/activity',
      summary: 'Activity of a team, with small groups hidden',
      tags: ['team analytics'],
      auth: 'required',
      rateLimit: { max: 60, timeWindowMs: 60_000 },
      params: teamParam,
      query: insightPeriodQuerySchema,
      success: { status: 200, schema: teamActivityReportSchema },
      handler: async ({ principal, params, query }) => {
        const result = await useCases.getTeamActivity.execute({
          actor: principal,
          teamId: params.teamId,
          period: query,
        });
        return result.ok
          ? ok(
              toTeamReport(
                { scope: 'team', teamId: params.teamId },
                query,
                result.value.report,
                result.value.minCohortSize,
              ),
            )
          : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/organization/activity',
      summary: 'Activity of the whole organisation (administrators), with small groups hidden',
      tags: ['team analytics'],
      auth: 'required',
      rateLimit: { max: 60, timeWindowMs: 60_000 },
      query: insightPeriodQuerySchema,
      success: { status: 200, schema: teamActivityReportSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.getOrganizationActivity.execute({
          actor: principal,
          period: query,
        });
        return result.ok
          ? ok(
              toTeamReport(
                { scope: 'organization' },
                query,
                result.value.report,
                result.value.minCohortSize,
              ),
            )
          : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/me/activity',
      summary: 'Your own activity',
      tags: ['personal analytics'],
      auth: 'required',
      rateLimit: { max: 120, timeWindowMs: 60_000 },
      query: insightPeriodQuerySchema,
      success: { status: 200, schema: myActivityReportSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.getMyActivity.execute({ actor: principal, period: query });
        return result.ok
          ? ok({ ...query, ...result.value, byDay: [...result.value.byDay] })
          : result;
      },
    }),
  ];
}
