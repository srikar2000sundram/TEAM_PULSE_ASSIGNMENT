import type { Principal } from '@teampulse/auth';
import type { ChallengeStatus } from '@teampulse/contracts';
import { err, ok, type Result } from '@teampulse/kernel';
import { statsOf, type ProgressStats, type RankedStanding } from '../domain/progress.js';
import { challengeNotFound, notParticipant } from './errors.js';
import type { AwardedBadge, UnitOfWork } from './ports.js';
import type { BadgeRule } from '../domain/challenge.js';

export interface Leaderboard {
  readonly challengeId: string;
  readonly status: ChallengeStatus;
  readonly participantCount: number;
  readonly entries: readonly RankedStanding[];
  /** The caller's place, also when they are not among the entries shown. */
  readonly you: RankedStanding | null;
}

/**
 * The standings of a challenge. Visible to the people taking part, to the managers of the team and
 * to administrators. Another member of the team can see that the challenge exists but not who is
 * winning; anyone outside the team cannot see the challenge at all.
 */
export class GetLeaderboard {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    challengeId: string;
    limit: number;
  }): Promise<Result<Leaderboard>> {
    return this.deps.uow.run(async (tx) => {
      const challenge = await tx.challenges.findVisible(input.challengeId, input.actor);
      if (challenge === null) return err(challengeNotFound());

      const you = await tx.participations.rankOf(challenge.id, input.actor.userId);
      if (you === null && !challenge.canBeManagedBy(input.actor)) return err(notParticipant());

      const [entries, counts] = await Promise.all([
        tx.participations.leaderboard(challenge.id, input.limit),
        tx.participations.countFor([challenge.id]),
      ]);
      return ok({
        challengeId: challenge.id,
        status: challenge.status,
        participantCount: counts.get(challenge.id) ?? 0,
        entries,
        you,
      });
    });
  }
}

export interface BadgeEarned {
  readonly rule: BadgeRule;
  readonly awardedOn: string;
}

export interface MyProgress {
  readonly challengeId: string;
  readonly stats: ProgressStats;
  readonly badges: readonly BadgeEarned[];
}

/** Your own progress in a challenge: points, active days, longest streak and the badges you hold. */
export class GetMyProgress {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal; challengeId: string }): Promise<Result<MyProgress>> {
    return this.deps.uow.run(async (tx) => {
      const challenge = await tx.challenges.findVisible(input.challengeId, input.actor);
      if (challenge === null) return err(challengeNotFound());
      if ((await tx.participations.find(challenge.id, input.actor.userId)) === null) {
        return err(notParticipant());
      }

      const [dates, awarded] = await Promise.all([
        tx.progress.dates(challenge.id, input.actor.userId),
        tx.badges.listFor(challenge.id, input.actor.userId),
      ]);
      const byRule = new Map(challenge.badgeRules.map((rule) => [rule.id, rule]));
      const badges = awarded.flatMap((badge: AwardedBadge): BadgeEarned[] => {
        const rule = byRule.get(badge.badgeRuleId);
        return rule === undefined ? [] : [{ rule, awardedOn: badge.awardedOn }];
      });
      return ok({ challengeId: challenge.id, stats: statsOf(dates), badges });
    });
  }
}
