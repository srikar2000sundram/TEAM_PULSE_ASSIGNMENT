import { startPeriodicTask, type PeriodicTask } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { ChallengeUseCases } from '../application/index.js';

/**
 * Ticks that move challenges through their calendar: drafts start on their start date and finished
 * challenges complete (announcing `ChallengeCompleted`).
 *
 * Every instance ticks. That is safe: each change is conditional on the status that was read, so one
 * instance wins and only the winner publishes. A failing tick is logged and the loop carries on;
 * a late tick only delays the change.
 */
export function startChallengeScheduler(options: {
  useCases: ChallengeUseCases;
  logger: Logger;
  tickSeconds: number;
}): PeriodicTask {
  const { useCases, logger } = options;
  return startPeriodicTask({
    intervalMs: options.tickSeconds * 1000,
    run: async () => void (await useCases.advanceChallenges.execute()),
    onError: (error) =>
      logger.error({ event: 'challenge.tick_failed', err: error }, 'challenge tick failed'),
    onStart: () =>
      logger.info({ event: 'challenge.scheduler_started' }, 'challenge scheduler started'),
    onStop: () =>
      logger.info({ event: 'challenge.scheduler_stopped' }, 'challenge scheduler stopped'),
  });
}
