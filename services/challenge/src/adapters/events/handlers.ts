import type { EventHandlers } from '@teampulse/inbox';
import type { Result } from '@teampulse/kernel';
import type { ChallengeUseCases } from '../../application/index.js';

/** An error result becomes a thrown error, so the message is retried and eventually dead-lettered. */
const orThrow = (result: Result<unknown>): void => {
  if (!result.ok) throw result.error;
};

/**
 * What the Challenge Service does when it hears from other services. A thin mapping from events to
 * use cases; the rules live in the application layer, which knows nothing about queues.
 *
 * Every handler is idempotent and order-tolerant, as at-least-once, unordered delivery requires:
 * an activity scores once per (challenge, event), progress is derived from the scoring ledger, and
 * leaving or erasing twice finds nothing left to remove.
 */
export function buildChallengeEventHandlers(useCases: ChallengeUseCases): EventHandlers {
  return {
    ActivityCompleted: async (event) =>
      orThrow(
        await useCases.recordProgress.execute({
          sourceEventId: event.eventId,
          userId: event.payload.userId,
          activityType: event.payload.activityType,
          activityDate: event.payload.activityDate,
        }),
      ),

    TeamMembershipChanged: async (event) => {
      // Being added to a team changes nothing here: joining a challenge is the person's own choice.
      if (event.payload.change !== 'removed') return;
      orThrow(
        await useCases.withdrawFromTeam.execute({
          userId: event.payload.userId,
          teamId: event.payload.teamId,
        }),
      );
    },

    UserDeleted: async (event) =>
      orThrow(await useCases.eraseUserChallenges.execute({ userId: event.payload.userId })),
  };
}
