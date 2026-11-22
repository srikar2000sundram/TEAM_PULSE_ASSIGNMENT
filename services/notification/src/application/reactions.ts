import type { HabitReminder } from '@teampulse/contracts';
import { ok, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { toSchedule } from '../domain/reminder.js';
import type { UnitOfWork } from './ports.js';

/**
 * Reactions to events from other services. Each is idempotent and tolerant of reordering, because
 * delivery is at-least-once and unordered.
 */

/** `HabitCreated` and `HabitUpdated`: replace the habit's reminder schedule (or clear it). */
export class ApplyHabitReminder {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    habitId: string;
    ownerUserId: string;
    reminder: HabitReminder | undefined;
    occurredAt: Date;
  }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      await tx.reminders.applySnapshot({
        habitId: input.habitId,
        userId: input.ownerUserId,
        schedule: input.reminder === undefined ? null : toSchedule(input.reminder),
        at: input.occurredAt,
      });
      return ok(undefined);
    });
  }
}

/** `HabitArchived`: the reminder stops, permanently. */
export class ApplyHabitArchived {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    habitId: string;
    ownerUserId: string;
    occurredAt: Date;
  }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      await tx.reminders.applyArchived({
        habitId: input.habitId,
        userId: input.ownerUserId,
        at: input.occurredAt,
      });
      return ok(undefined);
    });
  }
}

/** `UserDeleted`: right to erasure of everything held about the person. */
export class EraseUserNotifications {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      const notifications = await tx.notifications.deleteAllForUser(input.userId);
      await tx.preferences.deleteForUser(input.userId);
      const reminders = await tx.reminders.deleteAllForUser(input.userId);
      await tx.participants.deleteAllForUser(input.userId);
      this.deps.logger.info(
        { event: 'notification.erased', userId: input.userId, notifications, reminders },
        'notification data erased',
      );
      return ok(undefined);
    });
  }
}
