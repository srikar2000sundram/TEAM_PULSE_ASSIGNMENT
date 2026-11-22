import type { EventHandlers } from '@teampulse/inbox';
import type { EventTrackingUseCases } from '../../application/index.js';

/**
 * What the Event Tracking Service does when it hears from other services. A thin mapping from
 * events to use cases; the rules live in the application layer, which knows nothing about queues.
 *
 * All three are idempotent and order-tolerant, as at-least-once, unordered delivery requires. A use
 * case that returns an error is rethrown, so the message is retried and eventually dead-lettered
 * instead of lost.
 */
export function buildEventTrackingEventHandlers(useCases: EventTrackingUseCases): EventHandlers {
  return {
    HabitCreated: async (event) => {
      const result = await useCases.applyHabitSnapshot.execute({
        habitId: event.payload.habitId,
        ownerUserId: event.payload.ownerUserId,
        activityType: event.payload.activityType,
        occurredAt: new Date(event.occurredAt),
      });
      if (!result.ok) throw result.error;
    },

    HabitUpdated: async (event) => {
      const result = await useCases.applyHabitSnapshot.execute({
        habitId: event.payload.habitId,
        ownerUserId: event.payload.ownerUserId,
        activityType: event.payload.activityType,
        occurredAt: new Date(event.occurredAt),
      });
      if (!result.ok) throw result.error;
    },

    HabitArchived: async (event) => {
      const result = await useCases.applyHabitArchived.execute({
        habitId: event.payload.habitId,
        ownerUserId: event.payload.ownerUserId,
        occurredAt: new Date(event.occurredAt),
      });
      if (!result.ok) throw result.error;
    },

    UserDeleted: async (event) => {
      const result = await useCases.eraseUserActivities.execute({ userId: event.payload.userId });
      if (!result.ok) throw result.error;
    },
  };
}
