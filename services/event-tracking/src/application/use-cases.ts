import type { Clock, IdGenerator } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { EventFactory } from '@teampulse/outbox';
import type { DatePolicy } from '../domain/activity.js';
import { ListActivities, RecordActivity } from './activities.js';
import type { UnitOfWork } from './ports.js';
import { ApplyHabitArchived, ApplyHabitSnapshot, EraseUserActivities } from './reactions.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly datePolicy: DatePolicy;
}

export type EventTrackingUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production and the
 * tests both call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, clock, ids, logger, datePolicy } = deps;
  const events = new EventFactory(clock, ids);

  return {
    recordActivity: new RecordActivity({ uow, clock, ids, events, logger, datePolicy }),
    listActivities: new ListActivities({ uow }),
    // Reactions to events from other services (see reactions.ts).
    applyHabitSnapshot: new ApplyHabitSnapshot({ uow }),
    applyHabitArchived: new ApplyHabitArchived({ uow }),
    eraseUserActivities: new EraseUserActivities({ uow, logger }),
  };
}
