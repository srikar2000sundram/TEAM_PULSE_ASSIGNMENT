import type { EventHandlers } from '@teampulse/inbox';
import type { HabitUseCases } from '../../application/index.js';

/**
 * What the Habit Service does when it hears from the Identity Service. A thin mapping from events
 * to use cases (the rules live in the application layer, which knows nothing about queues).
 *
 * Both use cases are idempotent, as at-least-once delivery requires. A use case that returns an
 * error is rethrown, so the message is retried and eventually dead-lettered instead of lost.
 */
export function buildHabitEventHandlers(useCases: HabitUseCases): EventHandlers {
  return {
    UserDeleted: async (event) => {
      const result = await useCases.eraseUserHabits.execute({ userId: event.payload.userId });
      if (!result.ok) throw result.error;
    },

    TeamMembershipChanged: async (event) => {
      // Joining a team changes nothing here: habits are shared by their owner's choice.
      if (event.payload.change !== 'removed') return;
      const result = await useCases.withdrawHabitsFromTeam.execute({
        userId: event.payload.userId,
        teamId: event.payload.teamId,
      });
      if (!result.ok) throw result.error;
    },
  };
}
