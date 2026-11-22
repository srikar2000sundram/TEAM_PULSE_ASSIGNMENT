import { ok, type Clock, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventFactory } from '@teampulse/outbox';
import type { UnitOfWork } from './ports.js';
import { habitSnapshot } from './support.js';

/**
 * Reactions to events from the Identity Service. Each is idempotent: events are delivered at least
 * once, so handling the same one twice must leave the same result as handling it once.
 *
 * Note: wiring them to the event bus is part of the event-consumer work (roadmap step 5), which
 * adds the queue subscription. Until then they are plain use cases, covered by tests.
 */

/** `UserDeleted`: right to erasure. Removes every habit the user owned. */
export class EraseUserHabits {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string }): Promise<Result<{ removed: number }>> {
    return this.deps.uow.run(async (tx) => {
      const removed = await tx.habits.deleteAllOwnedBy(input.userId);
      this.deps.logger.info(
        { event: 'habit.erased', userId: input.userId, removed },
        'habits erased',
      );
      return ok({ removed });
    });
  }
}

/**
 * `TeamMembershipChanged` with `change: removed`. Someone who leaves a team must stop sharing
 * habits with it: otherwise the remaining members would keep seeing a former colleague's habits.
 * The habits become private; the owner can share them again with a team they belong to.
 */
export class WithdrawHabitsFromTeam {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; events: EventFactory; logger: Logger },
  ) {}

  execute(input: { userId: string; teamId: string }): Promise<Result<{ withdrawn: number }>> {
    return this.deps.uow.run(async (tx) => {
      const changed = await tx.habits.withdrawFromTeam(
        input.userId,
        input.teamId,
        this.deps.clock.now(),
      );
      // Archived habits were already invisible to the team, so nobody needs to hear about them.
      for (const habit of changed.filter((candidate) => !candidate.isArchived)) {
        await tx.outbox.append(this.deps.events.create('HabitUpdated', habitSnapshot(habit)));
      }
      this.deps.logger.info(
        {
          event: 'habit.withdrawn_from_team',
          userId: input.userId,
          teamId: input.teamId,
          count: changed.length,
        },
        'habits withdrawn from team',
      );
      return ok({ withdrawn: changed.length });
    });
  }
}
