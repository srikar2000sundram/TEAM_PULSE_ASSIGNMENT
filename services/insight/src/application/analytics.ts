import { requireRole, type Principal } from '@teampulse/auth';
import { err, notFoundError, ok, type AppError, type Clock, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import {
  buildPersonalReport,
  buildTeamReport,
  type PersonalReportData,
  type TeamReportData,
} from '../domain/report.js';
import { ORGANIZATION, scopeKey, scopesOfActivity } from '../domain/scope.js';
import type { AnalyticsStore, Contribution, Pseudonymizer } from './ports.js';
import type { ActivityType } from '@teampulse/contracts';

export const teamNotFound = (): AppError => notFoundError('team.not_found', 'Team not found');

const DAY_MS = 86_400_000;

export interface Period {
  readonly from: string;
  readonly to: string;
}

/**
 * `ActivityCompleted`: counts the activity for the person and for each team they were in.
 *
 * The event carries a snapshot of the person's teams at that moment, so a person who later moves
 * team does not change what was reported about the old one.
 */
export class RecordActivityAnalytics {
  constructor(
    private readonly deps: {
      store: AnalyticsStore;
      pseudonyms: Pseudonymizer;
      clock: Clock;
      logger: Logger;
      retentionDays: number;
    },
  ) {}

  async execute(input: {
    eventId: string;
    userId: string;
    teamIds: readonly string[];
    activityType: ActivityType;
    activityDate: string;
  }): Promise<Result<{ counted: boolean }>> {
    const contributions: Contribution[] = scopesOfActivity(input.teamIds).map((scope) => ({
      scopeKey: scopeKey(scope),
      participant: this.deps.pseudonyms.participant(scopeKey(scope), input.userId),
    }));

    const outcome = await this.deps.store.record({
      eventId: input.eventId,
      userId: input.userId,
      day: input.activityDate,
      activityType: input.activityType,
      contributions,
      // Kept for a fixed time after the activity itself, then deleted by the database.
      expiresAt: new Date(
        Date.parse(`${input.activityDate}T00:00:00Z`) + this.deps.retentionDays * DAY_MS,
      ),
    });
    this.deps.logger.debug({ event: 'insight.recorded', outcome }, 'activity counted');
    return ok({ counted: outcome === 'recorded' });
  }
}

/**
 * A team's numbers, with small groups hidden.
 *
 * Who may ask: members of the team, the managers of the team, and administrators. Anyone else gets
 * the same "not found" as for a team that does not exist, so team ids cannot be probed.
 */
export class GetTeamActivity {
  constructor(private readonly deps: { store: AnalyticsStore; minCohortSize: number }) {}

  async execute(input: {
    actor: Principal;
    teamId: string;
    period: Period;
  }): Promise<Result<{ report: TeamReportData; minCohortSize: number }>> {
    const { actor, teamId } = input;
    const allowed =
      actor.role === 'admin' ||
      actor.teamIds.includes(teamId) ||
      actor.managedTeamIds.includes(teamId);
    if (!allowed) return err(teamNotFound());

    const cells = await this.deps.store.readCells(
      scopeKey({ kind: 'team', teamId }),
      input.period.from,
      input.period.to,
    );
    return ok({
      report: buildTeamReport(cells, this.deps.minCohortSize),
      minCohortSize: this.deps.minCohortSize,
    });
  }
}

/** The whole organisation's numbers: administrators only. Same privacy rules as a team. */
export class GetOrganizationActivity {
  constructor(private readonly deps: { store: AnalyticsStore; minCohortSize: number }) {}

  async execute(input: {
    actor: Principal;
    period: Period;
  }): Promise<Result<{ report: TeamReportData; minCohortSize: number }>> {
    const allowed = requireRole(input.actor, 'admin');
    if (!allowed.ok) return allowed;

    const cells = await this.deps.store.readCells(
      scopeKey(ORGANIZATION),
      input.period.from,
      input.period.to,
    );
    return ok({
      report: buildTeamReport(cells, this.deps.minCohortSize),
      minCohortSize: this.deps.minCohortSize,
    });
  }
}

/** Your own numbers. There is no parameter for another person: the caller is the only subject. */
export class GetMyActivity {
  constructor(private readonly deps: { store: AnalyticsStore }) {}

  async execute(input: { actor: Principal; period: Period }): Promise<Result<PersonalReportData>> {
    const days = await this.deps.store.readPersonal(
      input.actor.userId,
      input.period.from,
      input.period.to,
    );
    return ok(buildPersonalReport(days));
  }
}

/**
 * `UserDeleted`: takes the person's activity back out of every team and organisation count, and
 * removes their personal counters. After this nothing in the Insight data refers to them.
 */
export class EraseUserAnalytics {
  constructor(
    private readonly deps: { store: AnalyticsStore; pseudonyms: Pseudonymizer; logger: Logger },
  ) {}

  async execute(input: { userId: string }): Promise<Result<{ erasedDays: number }>> {
    const days = await this.deps.store.readPersonal(input.userId, '0000-01-01', '9999-12-31');
    for (const day of days) {
      await this.deps.store.erasePersonalDay(
        input.userId,
        day,
        day.scopeKeys.map((key) => ({
          scopeKey: key,
          participant: this.deps.pseudonyms.participant(key, input.userId),
        })),
      );
    }
    this.deps.logger.info(
      { event: 'insight.user_erased', erasedDays: days.length },
      'analytics erased',
    );
    return ok({ erasedDays: days.length });
  }
}
