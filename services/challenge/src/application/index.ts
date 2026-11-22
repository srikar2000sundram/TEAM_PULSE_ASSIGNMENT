import type { Clock, IdGenerator } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { EventFactory } from '@teampulse/outbox';
import {
  CancelChallenge,
  CreateChallenge,
  GetChallenge,
  JoinChallenge,
  ListChallenges,
  StartChallenge,
} from './challenges.js';
import { AdvanceChallenges } from './lifecycle.js';
import type { UnitOfWork } from './ports.js';
import { EraseUserChallenges, WithdrawFromTeamChallenges } from './reactions.js';
import { RecordChallengeProgress } from './scoring.js';
import { GetLeaderboard, GetMyProgress } from './standings.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Days after a challenge's end date during which activities for its last day still count. */
  readonly graceDays: number;
}

export type ChallengeUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production and the
 * tests both call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, clock, ids, logger } = deps;
  const events = new EventFactory(clock, ids);

  return {
    // For people (HTTP).
    createChallenge: new CreateChallenge({ uow, clock, ids, logger }),
    getChallenge: new GetChallenge({ uow }),
    listChallenges: new ListChallenges({ uow }),
    startChallenge: new StartChallenge({ uow, clock, logger }),
    cancelChallenge: new CancelChallenge({ uow, clock, logger }),
    joinChallenge: new JoinChallenge({ uow, clock, events, logger }),
    getLeaderboard: new GetLeaderboard({ uow }),
    getMyProgress: new GetMyProgress({ uow }),
    // Reactions to events from other services.
    recordProgress: new RecordChallengeProgress({ uow, clock, events, logger }),
    eraseUserChallenges: new EraseUserChallenges({ uow, logger }),
    withdrawFromTeam: new WithdrawFromTeamChallenges({ uow, logger }),
    // Run on a timer.
    advanceChallenges: new AdvanceChallenges({
      uow,
      clock,
      events,
      logger,
      graceDays: deps.graceDays,
    }),
  };
}

export * from './challenges.js';
export * from './errors.js';
export * from './ports.js';
export * from './standings.js';
