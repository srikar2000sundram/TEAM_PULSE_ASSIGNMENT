import type { ActivityType } from '@teampulse/contracts';
import { ok, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { UnitOfWork } from './ports.js';

/**
 * Reactions to events from other services. Each is idempotent and tolerant of reordering, because
 * delivery is at-least-once and unordered.
 */

/** `HabitCreated` and `HabitUpdated`: remember the owner and the current activity type. */
export class ApplyHabitSnapshot {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    habitId: string;
    ownerUserId: string;
    activityType: ActivityType;
    occurredAt: Date;
  }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      await tx.habits.applySnapshot({
        habitId: input.habitId,
        ownerUserId: input.ownerUserId,
        activityType: input.activityType,
        at: input.occurredAt,
      });
      return ok(undefined);
    });
  }
}

/** `HabitArchived`: from now on no activity can be recorded for the habit. */
export class ApplyHabitArchived {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    habitId: string;
    ownerUserId: string;
    occurredAt: Date;
  }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      await tx.habits.applyArchived({
        habitId: input.habitId,
        ownerUserId: input.ownerUserId,
        at: input.occurredAt,
      });
      return ok(undefined);
    });
  }
}

/** `UserDeleted`: right to erasure of the user's recorded activities and habit facts. */
export class EraseUserActivities {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string }): Promise<Result<{ activities: number; habits: number }>> {
    return this.deps.uow.run(async (tx) => {
      const activities = await tx.activities.deleteAllForUser(input.userId);
      const habits = await tx.habits.deleteAllOwnedBy(input.userId);
      this.deps.logger.info(
        { event: 'activity.erased', userId: input.userId, activities, habits },
        'activities erased',
      );
      return ok({ activities, habits });
    });
  }
}
