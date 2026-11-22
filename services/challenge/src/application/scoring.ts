import type { ActivityType } from '@teampulse/contracts';
import { ok, type Clock, type Result } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { EventFactory } from '@teampulse/outbox';
import { dateOf } from '../domain/dates.js';
import { satisfiedRules, statsOf } from '../domain/progress.js';
import type { UnitOfWork } from './ports.js';

/**
 * `ActivityCompleted`: scores the activity in every challenge where it counts, then awards the
 * badges the new total earns. Everything happens in one transaction with the events it publishes.
 *
 * Safe to run twice for the same event: the ledger row is keyed by (challenge, event), so a repeat
 * finds it already there and changes and publishes nothing. Safe in any order: progress is derived
 * from the ledger, so it depends on which activities were scored, never on when they arrived.
 */
export class RecordChallengeProgress {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      events: EventFactory;
      logger: Logger;
    },
  ) {}

  execute(input: {
    sourceEventId: string;
    userId: string;
    activityType: ActivityType;
    activityDate: string;
  }): Promise<Result<{ scored: number; badges: number }>> {
    const today = dateOf(this.deps.clock.now());
    return this.deps.uow.run(async (tx) => {
      const challenges = await tx.challenges.findScoring(
        input.userId,
        input.activityType,
        input.activityDate,
      );

      let scored = 0;
      let badges = 0;
      for (const challenge of challenges) {
        const isNew = await tx.progress.record({
          challengeId: challenge.id,
          sourceEventId: input.sourceEventId,
          userId: input.userId,
          activityDate: input.activityDate,
        });
        if (!isNew) continue;

        scored += 1;
        await tx.participations.addPoint(challenge.id, input.userId);
        await tx.outbox.append(
          this.deps.events.create('ChallengeProgressUpdated', {
            challengeId: challenge.id,
            userId: input.userId,
            pointsDelta: 1,
            sourceEventId: input.sourceEventId,
          }),
        );

        const stats = statsOf(await tx.progress.dates(challenge.id, input.userId));
        for (const rule of satisfiedRules(challenge.badgeRules, stats)) {
          const awarded = await tx.badges.award({
            challengeId: challenge.id,
            userId: input.userId,
            badgeRuleId: rule.id,
            awardedOn: today,
          });
          if (!awarded) continue; // already held: a badge is awarded once
          badges += 1;
          await tx.outbox.append(
            this.deps.events.create('BadgeAwarded', {
              userId: input.userId,
              challengeId: challenge.id,
              badgeRuleId: rule.id,
              kind: rule.kind,
              awardedOn: today,
            }),
          );
        }
      }
      if (scored > 0) {
        this.deps.logger.info(
          { event: 'challenge.scored', scored, badges },
          'activity scored in challenges',
        );
      }
      return ok({ scored, badges });
    });
  }
}
