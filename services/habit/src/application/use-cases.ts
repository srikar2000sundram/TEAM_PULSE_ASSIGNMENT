import type { Clock, IdGenerator } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { EventFactory } from '@teampulse/outbox';
import { ArchiveHabit, CreateHabit, GetHabit, ListHabits, UpdateHabit } from './habits.js';
import type { UnitOfWork } from './ports.js';
import { EraseUserHabits, WithdrawHabitsFromTeam } from './reactions.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly maxActiveHabits: number;
}

export type HabitUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production and the
 * tests both call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, clock, ids, logger } = deps;
  const events = new EventFactory(clock, ids);

  return {
    createHabit: new CreateHabit({
      uow,
      clock,
      ids,
      events,
      logger,
      maxActiveHabits: deps.maxActiveHabits,
    }),
    getHabit: new GetHabit({ uow }),
    listHabits: new ListHabits({ uow }),
    updateHabit: new UpdateHabit({ uow, clock, events, logger }),
    archiveHabit: new ArchiveHabit({ uow, clock, events, logger }),
    // Reactions to Identity events (see reactions.ts).
    eraseUserHabits: new EraseUserHabits({ uow, logger }),
    withdrawHabitsFromTeam: new WithdrawHabitsFromTeam({ uow, clock, events, logger }),
  };
}
