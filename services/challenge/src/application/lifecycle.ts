import { ok, type Clock, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventFactory } from '@teampulse/outbox';
import { addDays, dateOf } from '../domain/dates.js';
import type { UnitOfWork } from './ports.js';

/**
 * Moves challenges through their calendar: a draft whose start date has come becomes active, and an
 * active challenge whose end date (plus a grace period) has passed becomes completed, which
 * announces `ChallengeCompleted`. Run on a timer by every instance.
 *
 * Several instances may run it at once. Each change is conditional on the status that was read, so
 * only one of them wins, and only the winner publishes the event.
 *
 * The grace period matters because an activity is dated by the person's own calendar day, which can
 * be a day behind UTC: someone in the Americas finishing a walk on the last day may record it after
 * UTC midnight. Without grace that activity would arrive after the challenge closed.
 */
export class AdvanceChallenges {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      events: EventFactory;
      logger: Logger;
      /** Days after the end date during which activities for the last day still count. */
      graceDays: number;
    },
  ) {}

  execute(): Promise<Result<{ started: number; completed: number }>> {
    const now = this.deps.clock.now();
    const today = dateOf(now);
    return this.deps.uow.run(async (tx) => {
      let started = 0;
      for (const draft of await tx.challenges.listDraftsDue(today)) {
        const active = draft.start(now);
        if (active.ok && (await tx.challenges.transition(active.value, 'draft'))) started += 1;
      }

      let completed = 0;
      for (const active of await tx.challenges.listActiveEndedBefore(
        addDays(today, -this.deps.graceDays),
      )) {
        const done = active.complete(now);
        if (!done.ok || !(await tx.challenges.transition(done.value, 'active'))) continue;
        completed += 1;
        await tx.outbox.append(
          this.deps.events.create('ChallengeCompleted', {
            challengeId: active.id,
            completedOn: active.endsOn,
          }),
        );
      }

      if (started + completed > 0) {
        this.deps.logger.info(
          { event: 'challenge.advanced', started, completed },
          'challenges advanced',
        );
      }
      return ok({ started, completed });
    });
  }
}
