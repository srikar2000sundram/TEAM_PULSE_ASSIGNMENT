import type { Principal } from '@teampulse/auth';
import {
  conflictError,
  decodeCursor,
  err,
  notFoundError,
  ok,
  pageOf,
  type AppError,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventFactory } from '@teampulse/outbox';
import { Activity, checkActivityDate, type DatePolicy } from '../domain/activity.js';
import type { UnitOfWork } from './ports.js';

/**
 * The same answer for "no such habit", "someone else's habit" and "not known to us yet", so the
 * response reveals nothing about other people's habits.
 */
export const habitNotFound = (): AppError => notFoundError('habit.not_found', 'Habit not found');

export const habitArchived = (): AppError =>
  conflictError('habit.archived', 'This habit is archived, so activities cannot be recorded');

export interface RecordedActivity {
  readonly activity: Activity;
  /** False when this habit was already recorded for this day. */
  readonly created: boolean;
}

export class RecordActivity {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      events: EventFactory;
      logger: Logger;
      datePolicy: DatePolicy;
    },
  ) {}

  execute(input: {
    actor: Principal;
    habitId: string;
    activityDate: string;
  }): Promise<Result<RecordedActivity>> {
    const now = this.deps.clock.now();
    const date = checkActivityDate(input.activityDate, now, this.deps.datePolicy);
    if (!date.ok) return Promise.resolve(date);

    return this.deps.uow.run(async (tx) => {
      const habit = await tx.habits.find(input.habitId);
      // Someone else's habit looks exactly like a missing one. A habit whose creation event has not
      // arrived yet is "missing" too: a retry a moment later succeeds.
      if (
        habit === null ||
        habit.ownerUserId !== input.actor.userId ||
        habit.activityType === null
      ) {
        return err(habitNotFound());
      }
      if (habit.archived) return err(habitArchived());

      const { activity, created } = await tx.activities.insertIfAbsent(
        Activity.record({
          id: this.deps.ids.next(),
          userId: input.actor.userId,
          habitId: habit.habitId,
          activityType: habit.activityType,
          activityDate: date.value,
          teamIds: input.actor.teamIds,
          now,
        }),
      );

      // Written with the activity, in the same transaction, only when something new was stored: a
      // retried request must not make the streak count the day twice.
      if (created) {
        const totalCompleted = await tx.activities.countForUser(activity.userId);
        await tx.outbox.append(
          this.deps.events.create('ActivityCompleted', {
            userId: activity.userId,
            habitId: activity.habitId,
            teamIds: [...activity.teamIds],
            activityType: activity.activityType,
            activityDate: activity.activityDate,
            totalCompleted,
          }),
        );
        this.deps.logger.info(
          { event: 'activity.recorded', userId: activity.userId, habitId: activity.habitId },
          'activity recorded',
        );
      }
      return ok({ activity, created });
    });
  }
}

export class ListActivities {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    from?: string | undefined;
    to?: string | undefined;
    habitId?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Result<{ items: readonly Activity[]; nextCursor: string | undefined }>> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (after !== undefined && !after.ok) return Promise.resolve(after);

    return this.deps.uow.run(async (tx) => {
      const rows = await tx.activities.list({
        // Always the caller's own: there is no way to ask for another user's activities.
        userId: input.actor.userId,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.habitId === undefined ? {} : { habitId: input.habitId }),
        // One extra row tells us whether another page exists without a count query.
        limit: input.limit + 1,
        ...(after === undefined ? {} : { after: after.value }),
      });
      return ok(pageOf(rows, input.limit));
    });
  }
}
