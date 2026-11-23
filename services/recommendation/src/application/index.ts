import type { Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { UnitOfWork } from './ports.js';
import {
  DecideRecommendation,
  EraseUserRecommendations,
  ListRecommendations,
  PurgeOldActivityTimes,
  RecordActivityTime,
} from './recommendations.js';

export * from './ports.js';
export * from './recommendations.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type RecommendationUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production and the
 * tests both call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, clock, logger } = deps;
  return {
    // For people (HTTP).
    listRecommendations: new ListRecommendations({ uow, clock }),
    decideRecommendation: new DecideRecommendation({ uow, clock }),
    // Reactions to events from other services.
    recordActivityTime: new RecordActivityTime({ uow }),
    eraseUserRecommendations: new EraseUserRecommendations({ uow, logger }),
    // Run on a timer.
    purgeOldActivityTimes: new PurgeOldActivityTimes({ uow, clock }),
  };
}
