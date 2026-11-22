import { createEvent, type EventPayload, type TeamPulseEvent } from '@teampulse/contracts';
import { deterministicUuid, type Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventPublisher } from '@teampulse/outbox';
import { applyActivity, type StreakState } from '../domain/streak.js';

/** Port: where streak state lives (DynamoDB in production). */
export interface StreakStore {
  get(userId: string, habitId: string): Promise<StreakState | null>;
  /**
   * Stores `state` only if the stored version is still `expectedVersion` (null: nothing stored yet).
   * Returns false when another writer got there first. This conditional write is what makes
   * concurrent invocations safe.
   */
  save(state: StreakState, expectedVersion: number | null): Promise<boolean>;
}

export interface UpdateStreakDeps {
  readonly store: StreakStore;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Attempts when another invocation changes the same streak at the same moment. */
  readonly maxAttempts?: number;
}

/**
 * Handles `ActivityCompleted`: updates the streak and publishes `StreakUpdated`.
 *
 * Safe to run more than once for the same event (the bus delivers at least once, and Lambda retries
 * failures):
 * - the streak depends on the activity date, so a repeat changes nothing;
 * - the published event id is derived from the triggering event id, so a repeat publishes the
 *   *same* event and downstream consumers see a duplicate, not a new streak update;
 * - a repeat of an already counted day still publishes. That covers a crash after the state was
 *   saved but before the event went out: the retry sends it. (A back-dated activity changes nothing
 *   and publishes nothing.)
 */
export class UpdateStreak {
  private readonly maxAttempts: number;

  constructor(private readonly deps: UpdateStreakDeps) {
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  async execute(source: TeamPulseEvent<'ActivityCompleted'>): Promise<void> {
    const { userId, habitId, activityDate } = source.payload;
    const { publisher, logger } = this.deps;

    const result = await this.applyAndSave({ userId, habitId, activityDate });

    logger.info(
      {
        event: 'streak.processed',
        outcome: result.outcome,
        habitId,
        currentStreak: result.state.currentStreak,
      },
      'streak processed',
    );

    // A back-dated activity changed nothing and was ignored, so there is no update to announce.
    // Announcing the unchanged streak would make a consumer think it had just been reached again
    // (for example a 7 day milestone awarded twice).
    if (result.outcome === 'backdated') return;

    const payload: EventPayload<'StreakUpdated'> = {
      userId,
      habitId,
      currentStreak: result.state.currentStreak,
      longestStreak: result.state.longestStreak,
      activityDate,
    };
    const event = createEvent('StreakUpdated', {
      // Same source event, same id: a retry cannot create a second, different update.
      eventId: deterministicUuid(`StreakUpdated:${source.eventId}`),
      occurredAt: this.deps.clock.now(),
      correlationId: source.correlationId,
      payload,
    });

    const [outcome] = await publisher.publish([event]);
    if (outcome?.error !== undefined) {
      // Failing the invocation makes Lambda retry it, which is the retry we want.
      throw new Error(`StreakUpdated was not published: ${outcome.error}`);
    }
  }

  /**
   * Read, apply the rules, save conditionally. If another invocation changed the same streak in
   * between, the conditional save fails and the whole step is redone on fresh state.
   */
  private async applyAndSave(activity: {
    userId: string;
    habitId: string;
    activityDate: string;
  }): Promise<ReturnType<typeof applyActivity>> {
    const { store } = this.deps;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const previous = await store.get(activity.userId, activity.habitId);
      const result = applyActivity(previous, activity);
      // Nothing changed, so there is nothing to store.
      if (result.outcome === 'repeated' || result.outcome === 'backdated') return result;
      if (await store.save(result.state, previous?.version ?? null)) return result;
    }
    throw new Error(`streak update kept conflicting after ${this.maxAttempts} attempts`);
  }
}
