import type { Clock, IdGenerator } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import {
  GetPreferences,
  ListNotifications,
  MarkNotificationRead,
  NotifyChallengeCompleted,
  NotifyUser,
  PurgeReminderOccurrences,
  RecordParticipant,
  SendDueReminders,
  UpdatePreferences,
} from './notifications.js';
import type { UnitOfWork } from './ports.js';
import { ApplyHabitArchived, ApplyHabitReminder, EraseUserNotifications } from './reactions.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** How long after its time a reminder may still be sent. */
  readonly reminderWindowMinutes: number;
}

export type NotificationUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production and the
 * tests both call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, clock, ids, logger } = deps;
  const base = { uow, clock, ids, logger };

  return {
    // For people (HTTP).
    listNotifications: new ListNotifications({ uow }),
    markNotificationRead: new MarkNotificationRead({ uow, clock }),
    getPreferences: new GetPreferences({ uow }),
    updatePreferences: new UpdatePreferences({ uow, clock }),
    // Reactions to events from other services.
    notifyUser: new NotifyUser(base),
    recordParticipant: new RecordParticipant({ uow }),
    notifyChallengeCompleted: new NotifyChallengeCompleted(base),
    applyHabitReminder: new ApplyHabitReminder({ uow }),
    applyHabitArchived: new ApplyHabitArchived({ uow }),
    eraseUserNotifications: new EraseUserNotifications({ uow, logger }),
    // Run on a timer.
    purgeReminderOccurrences: new PurgeReminderOccurrences({ uow, clock, retentionDays: 14 }),
    sendDueReminders: new SendDueReminders({ ...base, windowMinutes: deps.reminderWindowMinutes }),
  };
}
