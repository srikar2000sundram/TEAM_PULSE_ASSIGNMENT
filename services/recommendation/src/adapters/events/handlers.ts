import type { EventHandlers } from '@teampulse/inbox';
import type { Result } from '@teampulse/kernel';
import type { RecommendationUseCases } from '../../application/index.js';

/** An error result becomes a thrown error, so the message is retried and eventually dead-lettered. */
const orThrow = (result: Result<unknown>): void => {
  if (!result.ok) throw result.error;
};

/**
 * What the Recommendation Service does when it hears from other services. Both handlers are
 * idempotent: a completion is stored once per event, and erasure can be repeated.
 */
export function buildRecommendationEventHandlers(useCases: RecommendationUseCases): EventHandlers {
  return {
    ActivityCompleted: async (event) =>
      orThrow(
        await useCases.recordActivityTime.execute({
          eventId: event.eventId,
          userId: event.payload.userId,
          habitId: event.payload.habitId,
          occurredAt: new Date(event.occurredAt),
        }),
      ),

    UserDeleted: async (event) =>
      orThrow(await useCases.eraseUserRecommendations.execute({ userId: event.payload.userId })),
  };
}
