import { ok, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { UnitOfWork } from './ports.js';

/**
 * `UserDeleted`: removes everything held about the person (participation, scoring ledger, badges)
 * and unlinks them from challenges they created, which stay for the team. Safe to repeat.
 */
export class EraseUserChallenges {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string }): Promise<Result<{ participations: number }>> {
    return this.deps.uow.run(async (tx) => {
      await tx.badges.deleteAllForUser(input.userId);
      await tx.progress.deleteAllForUser(input.userId);
      const participations = await tx.participations.deleteAllForUser(input.userId);
      await tx.challenges.detachCreator(input.userId);
      this.deps.logger.info({ event: 'challenge.user_erased', participations }, 'user erased');
      return ok({ participations });
    });
  }
}

/**
 * `TeamMembershipChanged` (removed): the person leaves the unfinished challenges of that team,
 * together with the points they scored there. Finished challenges keep their final standings.
 * Badges already earned stay earned. Safe to repeat.
 */
export class WithdrawFromTeamChallenges {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string; teamId: string }): Promise<Result<{ left: number }>> {
    return this.deps.uow.run(async (tx) => {
      const challengeIds = await tx.participations.withdrawFromTeam(input.userId, input.teamId);
      await tx.progress.deleteForUserIn(input.userId, challengeIds);
      if (challengeIds.length > 0) {
        this.deps.logger.info(
          { event: 'challenge.left_team', left: challengeIds.length },
          'left challenges of a team',
        );
      }
      return ok({ left: challengeIds.length });
    });
  }
}
