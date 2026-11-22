import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { deterministicUuid, type Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventPublisher } from '@teampulse/outbox';
import {
  DEFAULT_STREAK_MILESTONES,
  DEFAULT_TOTAL_MILESTONES,
  milestoneReached,
} from '../domain/milestones.js';
import { publishOrThrow } from './publish.js';

export interface AwardMilestonesDeps {
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly milestones?: readonly number[];
}

/**
 * Handles `StreakUpdated`: announces `MilestoneReached` when the streak has just hit a milestone.
 *
 * It keeps no state, so it needs no database. It is still safe to run twice for the same event:
 * the published event id is derived from the triggering event id, so a retry publishes the *same*
 * event and consumers see a duplicate, not a second achievement.
 */
export class AwardMilestones {
  constructor(private readonly deps: AwardMilestonesDeps) {}

  async execute(source: TeamPulseEvent<'StreakUpdated'>): Promise<void> {
    const { userId, habitId, currentStreak } = source.payload;
    const threshold = milestoneReached(
      currentStreak,
      this.deps.milestones ?? DEFAULT_STREAK_MILESTONES,
    );
    if (threshold === null) return;

    await publishOrThrow(
      this.deps.publisher,
      createEvent('MilestoneReached', {
        eventId: deterministicUuid(`MilestoneReached:${source.eventId}:${threshold}`),
        occurredAt: this.deps.clock.now(),
        correlationId: source.correlationId,
        payload: { userId, kind: 'streak', threshold, habitId },
      }),
    );
    this.deps.logger.info({ event: 'badge.milestone', threshold, habitId }, 'milestone reached');
  }
}

/**
 * Handles `ActivityCompleted`: announces a "total activities" milestone (10, 25, 50, ...).
 *
 * The event carries the user's running total as counted by Event Tracking inside the transaction
 * that stored the activity, so this function needs no counter of its own and no database.
 *
 * The published id is derived from the person and the threshold, not from the source event: if two
 * activities were stored at the same moment and both saw the same total, both announcements are the
 * *same* event, and the Notification Service (one notification per person and event) shows one.
 */
export class AwardTotalMilestones {
  constructor(private readonly deps: AwardMilestonesDeps) {}

  async execute(source: TeamPulseEvent<'ActivityCompleted'>): Promise<void> {
    const { userId, totalCompleted } = source.payload;
    const threshold = milestoneReached(
      totalCompleted,
      this.deps.milestones ?? DEFAULT_TOTAL_MILESTONES,
    );
    if (threshold === null) return;

    await publishOrThrow(
      this.deps.publisher,
      createEvent('MilestoneReached', {
        eventId: deterministicUuid(`MilestoneReached:total:${userId}:${threshold}`),
        occurredAt: this.deps.clock.now(),
        correlationId: source.correlationId,
        payload: { userId, kind: 'total', threshold },
      }),
    );
    this.deps.logger.info({ event: 'badge.total_milestone', threshold }, 'total milestone reached');
  }
}
