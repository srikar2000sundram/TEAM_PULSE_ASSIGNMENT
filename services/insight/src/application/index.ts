import type { Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import {
  EraseUserAnalytics,
  GetMyActivity,
  GetOrganizationActivity,
  GetTeamActivity,
  RecordActivityAnalytics,
} from './analytics.js';
import type { AnalyticsStore, Pseudonymizer } from './ports.js';

export interface ApplicationDeps {
  readonly store: AnalyticsStore;
  readonly pseudonyms: Pseudonymizer;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Groups smaller than this are never shown (ADR-0005). */
  readonly minCohortSize: number;
  /** How long counters are kept after the day they describe. */
  readonly retentionDays: number;
}

export type InsightUseCases = ReturnType<typeof createUseCases>;

/** The single place where use cases are assembled. Production and tests both call it. */
export function createUseCases(deps: ApplicationDeps) {
  const { store, pseudonyms, clock, logger } = deps;
  return {
    // For people (HTTP).
    getTeamActivity: new GetTeamActivity({ store, minCohortSize: deps.minCohortSize }),
    getOrganizationActivity: new GetOrganizationActivity({
      store,
      minCohortSize: deps.minCohortSize,
    }),
    getMyActivity: new GetMyActivity({ store }),
    // Reactions to events from other services.
    recordActivity: new RecordActivityAnalytics({
      store,
      pseudonyms,
      clock,
      logger,
      retentionDays: deps.retentionDays,
    }),
    eraseUserAnalytics: new EraseUserAnalytics({ store, pseudonyms, logger }),
  };
}

export * from './analytics.js';
export * from './ports.js';
