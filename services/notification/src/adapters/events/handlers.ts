import type { EventHandlers } from '@teampulse/inbox';
import type { Result } from '@teampulse/kernel';
import type { NotificationUseCases } from '../../application/index.js';

/** An error result becomes a thrown error, so the message is retried and eventually dead-lettered. */
const orThrow = (result: Result<unknown>): void => {
  if (!result.ok) throw result.error;
};

/**
 * What the Notification Service does when it hears from other services. A thin mapping from events
 * to use cases; the rules live in the application layer, which knows nothing about queues.
 *
 * Every handler is idempotent and order-tolerant, as at-least-once, unordered delivery requires:
 * a notification is keyed by (person, event), reminder schedules follow the newest event, and
 * archiving is permanent.
 */
export function buildNotificationEventHandlers(useCases: NotificationUseCases): EventHandlers {
  return {
    MilestoneReached: async (event) =>
      orThrow(
        await useCases.notifyUser.execute({
          userId: event.payload.userId,
          sourceId: event.eventId,
          content: {
            kind: 'milestone',
            milestoneKind: event.payload.kind,
            threshold: event.payload.threshold,
          },
        }),
      ),

    BadgeAwarded: async (event) =>
      orThrow(
        await useCases.notifyUser.execute({
          userId: event.payload.userId,
          sourceId: event.eventId,
          content: { kind: 'badge', badgeKind: event.payload.kind },
        }),
      ),

    ChallengeJoined: async (event) =>
      orThrow(
        await useCases.recordParticipant.execute({
          challengeId: event.payload.challengeId,
          userId: event.payload.userId,
        }),
      ),

    ChallengeCompleted: async (event) =>
      orThrow(
        await useCases.notifyChallengeCompleted.execute({
          challengeId: event.payload.challengeId,
          sourceId: event.eventId,
        }),
      ),

    HabitCreated: async (event) =>
      orThrow(
        await useCases.applyHabitReminder.execute({
          habitId: event.payload.habitId,
          ownerUserId: event.payload.ownerUserId,
          reminder: event.payload.reminder,
          occurredAt: new Date(event.occurredAt),
        }),
      ),

    HabitUpdated: async (event) =>
      orThrow(
        await useCases.applyHabitReminder.execute({
          habitId: event.payload.habitId,
          ownerUserId: event.payload.ownerUserId,
          reminder: event.payload.reminder,
          occurredAt: new Date(event.occurredAt),
        }),
      ),

    HabitArchived: async (event) =>
      orThrow(
        await useCases.applyHabitArchived.execute({
          habitId: event.payload.habitId,
          ownerUserId: event.payload.ownerUserId,
          occurredAt: new Date(event.occurredAt),
        }),
      ),

    UserDeleted: async (event) =>
      orThrow(await useCases.eraseUserNotifications.execute({ userId: event.payload.userId })),
  };
}
