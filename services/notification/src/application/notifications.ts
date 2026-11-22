import type { Principal } from '@teampulse/auth';
import type { NotificationPreferences } from '@teampulse/contracts';
import {
  decodeCursor,
  deterministicUuid,
  err,
  notFoundError,
  ok,
  pageOf,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import {
  DEFAULT_PREFERENCES,
  Notification,
  isEnabled,
  type NotificationContent,
} from '../domain/notification.js';
import { dueOccurrence } from '../domain/reminder.js';
import type { UnitOfWork } from './ports.js';

export const notificationNotFound = () =>
  notFoundError('notification.not_found', 'Notification not found');

interface Deps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** Creates a notification for one person unless they switched that category off. */
export class NotifyUser {
  constructor(private readonly deps: Deps) {}

  execute(input: {
    userId: string;
    content: NotificationContent;
    /** The event that caused it. The same event for the same person never notifies twice. */
    sourceId: string;
  }): Promise<Result<{ created: boolean }>> {
    return this.deps.uow.run(async (tx) => {
      const preferences = (await tx.preferences.find(input.userId)) ?? DEFAULT_PREFERENCES;
      if (!isEnabled(preferences, input.content.kind)) return ok({ created: false });

      const created = await tx.notifications.insertMany([
        Notification.create({
          id: this.deps.ids.next(),
          userId: input.userId,
          content: input.content,
          sourceId: input.sourceId,
          now: this.deps.clock.now(),
        }),
      ]);
      return ok({ created: created === 1 });
    });
  }
}

/** `ChallengeJoined`: remember who is taking part. */
export class RecordParticipant {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { challengeId: string; userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      await tx.participants.add(input.challengeId, input.userId);
      return ok(undefined);
    });
  }
}

/** `ChallengeCompleted`: tell everyone who joined. The event itself names nobody. */
export class NotifyChallengeCompleted {
  constructor(private readonly deps: Deps) {}

  execute(input: { challengeId: string; sourceId: string }): Promise<Result<{ notified: number }>> {
    return this.deps.uow.run(async (tx) => {
      const users = await tx.participants.usersOf(input.challengeId);
      const preferences = await tx.preferences.findMany(users);
      const now = this.deps.clock.now();

      const notifications = users
        .filter((userId) =>
          isEnabled(preferences.get(userId) ?? DEFAULT_PREFERENCES, 'challenge_completed'),
        )
        .map((userId) =>
          Notification.create({
            id: this.deps.ids.next(),
            userId,
            content: { kind: 'challenge_completed' },
            sourceId: input.sourceId,
            now,
          }),
        );
      return ok({ notified: await tx.notifications.insertMany(notifications) });
    });
  }
}

/**
 * Sends the reminders that are due. Called on a timer.
 *
 * Each occurrence (habit and local date) is claimed first, then notified, in one transaction, so
 * two instances ticking at once, or a tick repeated after a failure, cannot send it twice. An
 * occurrence whose owner switched reminders off is still claimed so it is not reconsidered.
 */
export class SendDueReminders {
  constructor(
    private readonly deps: Deps & {
      /** How long after its time a reminder may still be sent. */
      windowMinutes: number;
    },
  ) {}

  execute(): Promise<Result<{ sent: number }>> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(async (tx) => {
      const due = (await tx.reminders.listActive()).flatMap((reminder) => {
        const occurrence = dueOccurrence(reminder.schedule, now, this.deps.windowMinutes);
        return occurrence === null ? [] : [{ reminder, localDate: occurrence.localDate }];
      });
      if (due.length === 0) return ok({ sent: 0 });

      const preferences = await tx.preferences.findMany(due.map((d) => d.reminder.userId));
      let sent = 0;
      for (const { reminder, localDate } of due) {
        if (!(await tx.reminders.claimOccurrence(reminder.habitId, localDate, now))) continue;
        if (!isEnabled(preferences.get(reminder.userId) ?? DEFAULT_PREFERENCES, 'reminder'))
          continue;
        sent += await tx.notifications.insertMany([
          Notification.create({
            id: this.deps.ids.next(),
            userId: reminder.userId,
            content: { kind: 'reminder' },
            // Stable for this habit and day: a replay produces the same source.
            sourceId: deterministicUuid(`reminder:${reminder.habitId}:${localDate}`),
            now,
          }),
        ]);
      }
      if (sent > 0) this.deps.logger.info({ event: 'reminder.sent', sent }, 'reminders sent');
      return ok({ sent });
    });
  }
}

/** Housekeeping: occurrences older than the reminder window can never matter again. */
export class PurgeReminderOccurrences {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; retentionDays: number }) {}

  execute(): Promise<Result<{ removed: number }>> {
    const before = new Date(this.deps.clock.now().getTime() - this.deps.retentionDays * 86_400_000);
    return this.deps.uow.run(async (tx) =>
      ok({ removed: await tx.reminders.purgeOccurrences(before) }),
    );
  }
}

export class ListNotifications {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    unreadOnly: boolean;
    limit: number;
    cursor?: string | undefined;
  }): Promise<
    Result<{ items: readonly Notification[]; unreadCount: number; nextCursor: string | undefined }>
  > {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (after !== undefined && !after.ok) return Promise.resolve(after);

    return this.deps.uow.run(async (tx) => {
      const rows = await tx.notifications.list({
        // Always the caller's own: there is no way to ask for another person's notifications.
        userId: input.actor.userId,
        unreadOnly: input.unreadOnly,
        // One extra row tells us whether another page exists without a count query.
        limit: input.limit + 1,
        ...(after === undefined ? {} : { after: after.value }),
      });
      return ok({
        ...pageOf(rows, input.limit),
        unreadCount: await tx.notifications.unreadCount(input.actor.userId),
      });
    });
  }
}

export class MarkNotificationRead {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  execute(input: { actor: Principal; notificationId: string }): Promise<Result<Notification>> {
    return this.deps.uow.run(async (tx) => {
      const notification = await tx.notifications.markRead(
        input.actor.userId,
        input.notificationId,
        this.deps.clock.now(),
      );
      // Someone else's notification looks exactly like one that does not exist.
      return notification === null ? err(notificationNotFound()) : ok(notification);
    });
  }
}

export class GetPreferences {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal }): Promise<Result<NotificationPreferences>> {
    return this.deps.uow.run(async (tx) =>
      ok((await tx.preferences.find(input.actor.userId)) ?? DEFAULT_PREFERENCES),
    );
  }
}

export class UpdatePreferences {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  execute(input: {
    actor: Principal;
    changes: Partial<NotificationPreferences>;
  }): Promise<Result<NotificationPreferences>> {
    return this.deps.uow.run(async (tx) => {
      const current = (await tx.preferences.find(input.actor.userId)) ?? DEFAULT_PREFERENCES;
      const defined = Object.entries(input.changes).filter(([, value]) => value !== undefined);
      const next: NotificationPreferences = { ...current, ...Object.fromEntries(defined) };
      await tx.preferences.save(input.actor.userId, next, this.deps.clock.now());
      return ok(next);
    });
  }
}
