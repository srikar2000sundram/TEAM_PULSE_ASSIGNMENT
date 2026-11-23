import type { Principal } from '@teampulse/auth';
import type { RecommendationResponse } from '@teampulse/contracts';
import { ok, type Clock, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { LOOKBACK_DAYS, suggestTime } from '../domain/timing.js';
import type { Decision, UnitOfWork } from './ports.js';

const DAY_MS = 86_400_000;

/** `ActivityCompleted`: remember when the person did the habit. Idempotent per event. */
export class RecordActivityTime {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    eventId: string;
    userId: string;
    habitId: string;
    occurredAt: Date;
  }): Promise<Result<{ stored: boolean }>> {
    return this.deps.uow.run(async (tx) => ok({ stored: await tx.activityTimes.record(input) }));
  }
}

/**
 * The signed-in person's timing recommendations: one per habit with a clear pattern, minus the ones
 * they already accepted or dismissed. Computed from their own history on demand, so there is no
 * stored recommendation to go stale.
 */
export class ListRecommendations {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  execute(input: {
    actor: Principal;
    timeZone: string;
  }): Promise<Result<readonly RecommendationResponse[]>> {
    const since = new Date(this.deps.clock.now().getTime() - LOOKBACK_DAYS * DAY_MS);
    return this.deps.uow.run(async (tx) => {
      // Always the caller's own history: there is no way to ask for anyone else's.
      const times = await tx.activityTimes.listSince(input.actor.userId, since);
      const decisions = await tx.decisions.listForUser(input.actor.userId);

      const byHabit = new Map<string, Date[]>();
      for (const entry of times) {
        const list = byHabit.get(entry.habitId) ?? [];
        list.push(entry.occurredAt);
        byHabit.set(entry.habitId, list);
      }

      const items: RecommendationResponse[] = [];
      for (const [habitId, completions] of byHabit) {
        const suggestion = suggestTime(completions, input.timeZone);
        if (suggestion === null) continue;
        const decided = decisions.find(
          (entry) =>
            entry.habitId === habitId &&
            entry.suggestedTime === suggestion.suggestedTime &&
            entry.timeZone === input.timeZone,
        );
        items.push({
          habitId,
          suggestedTime: suggestion.suggestedTime,
          timeZone: input.timeZone,
          sampleSize: suggestion.sampleSize,
          matching: suggestion.matching,
          confidence: suggestion.confidence,
          status: decided === undefined ? 'pending' : decided.decision,
        });
      }
      // Stable order: strongest evidence first, then by habit id.
      items.sort((a, b) => b.matching - a.matching || a.habitId.localeCompare(b.habitId));
      return ok(items);
    });
  }
}

/** Accept or dismiss a suggestion. Idempotent: deciding the same way twice changes nothing. */
export class DecideRecommendation {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  execute(input: {
    actor: Principal;
    habitId: string;
    suggestedTime: string;
    timeZone: string;
    decision: Decision;
  }): Promise<
    Result<{ habitId: string; suggestedTime: string; timeZone: string; status: Decision }>
  > {
    return this.deps.uow.run(async (tx) => {
      await tx.decisions.save(
        {
          userId: input.actor.userId,
          habitId: input.habitId,
          suggestedTime: input.suggestedTime,
          timeZone: input.timeZone,
          decision: input.decision,
        },
        this.deps.clock.now(),
      );
      return ok({
        habitId: input.habitId,
        suggestedTime: input.suggestedTime,
        timeZone: input.timeZone,
        status: input.decision,
      });
    });
  }
}

/** `UserDeleted`: forget everything about the person (erasure). */
export class EraseUserRecommendations {
  constructor(private readonly deps: { uow: UnitOfWork; logger: Logger }) {}

  execute(input: { userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      const times = await tx.activityTimes.deleteAllForUser(input.userId);
      const decisions = await tx.decisions.deleteAllForUser(input.userId);
      this.deps.logger.info(
        { event: 'recommendation.erased', userId: input.userId, times, decisions },
        'recommendation data erased',
      );
      return ok(undefined);
    });
  }
}

/** Run on a timer: completions older than the look-back window can never matter again. */
export class PurgeOldActivityTimes {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  execute(): Promise<Result<{ purged: number }>> {
    const before = new Date(this.deps.clock.now().getTime() - LOOKBACK_DAYS * DAY_MS);
    return this.deps.uow.run(async (tx) =>
      ok({ purged: await tx.activityTimes.purgeBefore(before) }),
    );
  }
}
