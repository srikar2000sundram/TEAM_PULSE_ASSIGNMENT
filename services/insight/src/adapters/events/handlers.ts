import type { EventHandlers } from '@teampulse/inbox';
import type { Result } from '@teampulse/kernel';
import type { InsightUseCases } from '../../application/index.js';

/** An error result becomes a thrown error, so the message is retried and eventually dead-lettered. */
const orThrow = (result: Result<unknown>): void => {
  if (!result.ok) throw result.error;
};

/**
 * What the Insight Service does when it hears from other services. A thin mapping from events to
 * use cases. Both handlers are idempotent: an activity is counted once per event id, and erasing
 * twice finds nothing left to erase.
 */
export function buildInsightEventHandlers(useCases: InsightUseCases): EventHandlers {
  return {
    ActivityCompleted: async (event) =>
      orThrow(
        await useCases.recordActivity.execute({
          eventId: event.eventId,
          userId: event.payload.userId,
          teamIds: event.payload.teamIds,
          activityType: event.payload.activityType,
          activityDate: event.payload.activityDate,
        }),
      ),

    UserDeleted: async (event) =>
      orThrow(await useCases.eraseUserAnalytics.execute({ userId: event.payload.userId })),
  };
}
