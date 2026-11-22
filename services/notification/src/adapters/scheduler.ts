import { startPeriodicTask, type PeriodicTask } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { NotificationUseCases } from '../application/index.js';

const HOUR_MS = 3_600_000;

/**
 * Ticks that send due reminders, and once an hour forgets old occurrences.
 *
 * Every instance of the service ticks. That is safe: each occurrence is claimed in the database
 * (habit and local date), so exactly one instance sends it. A failing tick is logged and the loop
 * carries on, because the next tick is still inside the reminder window.
 */
export function startReminderScheduler(options: {
  useCases: NotificationUseCases;
  logger: Logger;
  tickSeconds: number;
}): PeriodicTask {
  const { useCases, logger } = options;
  let lastPurge = 0;
  return startPeriodicTask({
    intervalMs: options.tickSeconds * 1000,
    run: async () => {
      await useCases.sendDueReminders.execute();
      if (Date.now() - lastPurge > HOUR_MS) {
        lastPurge = Date.now();
        await useCases.purgeReminderOccurrences.execute();
      }
    },
    onError: (error) =>
      logger.error({ event: 'reminder.tick_failed', err: error }, 'reminder tick failed'),
    onStart: () =>
      logger.info({ event: 'reminder.scheduler_started' }, 'reminder scheduler started'),
    onStop: () =>
      logger.info({ event: 'reminder.scheduler_stopped' }, 'reminder scheduler stopped'),
  });
}
