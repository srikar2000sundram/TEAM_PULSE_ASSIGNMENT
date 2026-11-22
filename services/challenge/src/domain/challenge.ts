import {
  CHALLENGE_NAME_MAX_LENGTH,
  MAX_BADGE_RULES,
  MAX_BADGE_THRESHOLD,
  MAX_CHALLENGE_DAYS,
  type ActivityType,
  type BadgeKind,
  type ChallengeStatus,
  type Role,
} from '@teampulse/contracts';
import { conflictError, err, ok, validationError, type Result } from '@teampulse/kernel';
import { dateOf, daysInclusive } from './dates.js';

/** Who is asking. A verified token's claims; a `Principal` has exactly this shape. */
export interface Viewer {
  readonly userId: string;
  readonly role: Role;
  readonly teamIds: readonly string[];
  readonly managedTeamIds: readonly string[];
}

export interface BadgeRule {
  readonly id: string;
  readonly kind: BadgeKind;
  readonly threshold: number;
}

export interface ChallengeData {
  readonly id: string;
  readonly name: string;
  readonly activityType: ActivityType;
  /** The one team whose members may take part. */
  readonly teamId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: ChallengeStatus;
  readonly badgeRules: readonly BadgeRule[];
  /** Null after the creator's account was deleted (right to erasure). */
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Set when the challenge completed. */
  readonly completedOn: string | null;
}

const invalidState = (action: string, status: ChallengeStatus) =>
  err(
    conflictError('challenge.invalid_state', `A ${status} challenge cannot be ${action}`, {
      status,
    }),
  );

/**
 * A challenge and the rules that follow from its state. Pure: no clock, no storage; callers pass in
 * the current time or day.
 *
 * ```text
 * draft --start--> active --(end date + grace passed)--> completed
 *   |                |
 *   +----cancel------+--> cancelled
 * ```
 */
export class Challenge implements ChallengeData {
  readonly id: string;
  readonly name: string;
  readonly activityType: ActivityType;
  readonly teamId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: ChallengeStatus;
  readonly badgeRules: readonly BadgeRule[];
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedOn: string | null;

  private constructor(data: ChallengeData) {
    this.id = data.id;
    this.name = data.name;
    this.activityType = data.activityType;
    this.teamId = data.teamId;
    this.startsOn = data.startsOn;
    this.endsOn = data.endsOn;
    this.status = data.status;
    this.badgeRules = data.badgeRules;
    this.createdByUserId = data.createdByUserId;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.completedOn = data.completedOn;
  }

  /** Rebuilds a challenge from storage. Stored data was validated when it was written. */
  static restore(data: ChallengeData): Challenge {
    return new Challenge(data);
  }

  /**
   * A new challenge, always a draft. Checks everything itself: the HTTP schema validates input too,
   * but the domain does not rely on that.
   */
  static create(input: {
    id: string;
    name: string;
    activityType: ActivityType;
    teamId: string;
    startsOn: string;
    endsOn: string;
    badgeRules: readonly BadgeRule[];
    createdByUserId: string;
    now: Date;
  }): Result<Challenge> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > CHALLENGE_NAME_MAX_LENGTH) {
      return err(
        validationError(
          'challenge.name_invalid',
          `The name must have 1 to ${CHALLENGE_NAME_MAX_LENGTH} characters`,
        ),
      );
    }
    if (input.startsOn > input.endsOn) {
      return err(
        validationError('challenge.dates_invalid', 'The end date is before the start date'),
      );
    }
    if (daysInclusive(input.startsOn, input.endsOn) > MAX_CHALLENGE_DAYS) {
      return err(
        validationError(
          'challenge.too_long',
          `A challenge may last at most ${MAX_CHALLENGE_DAYS} days`,
        ),
      );
    }
    if (input.endsOn < dateOf(input.now)) {
      return err(validationError('challenge.in_the_past', 'The challenge would already be over'));
    }
    if (input.badgeRules.length > MAX_BADGE_RULES) {
      return err(
        validationError('challenge.too_many_badges', `At most ${MAX_BADGE_RULES} badge rules`),
      );
    }
    const keys = input.badgeRules.map((rule) => `${rule.kind}:${rule.threshold}`);
    if (new Set(keys).size !== keys.length) {
      return err(validationError('challenge.badges_repeat', 'Badge rules must not repeat'));
    }
    if (
      input.badgeRules.some(
        (rule) =>
          !Number.isInteger(rule.threshold) ||
          rule.threshold < 1 ||
          rule.threshold > MAX_BADGE_THRESHOLD,
      )
    ) {
      return err(
        validationError(
          'challenge.badge_threshold_invalid',
          `A badge threshold must be a whole number from 1 to ${MAX_BADGE_THRESHOLD}`,
        ),
      );
    }
    return ok(
      new Challenge({
        id: input.id,
        name,
        activityType: input.activityType,
        teamId: input.teamId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        status: 'draft',
        badgeRules: input.badgeRules,
        createdByUserId: input.createdByUserId,
        createdAt: input.now,
        updatedAt: input.now,
        completedOn: null,
      }),
    );
  }

  private with(changes: Partial<ChallengeData>): Challenge {
    return new Challenge({ ...this, ...changes });
  }

  /** draft -> active. Starting is allowed before the start date (manual start), not after the end. */
  start(now: Date): Result<Challenge> {
    if (this.status !== 'draft') return invalidState('started', this.status);
    if (this.endsOn < dateOf(now)) {
      return err(validationError('challenge.in_the_past', 'The challenge would already be over'));
    }
    return ok(this.with({ status: 'active', updatedAt: now }));
  }

  /** draft or active -> cancelled. */
  cancel(now: Date): Result<Challenge> {
    if (this.status !== 'draft' && this.status !== 'active') {
      return invalidState('cancelled', this.status);
    }
    return ok(this.with({ status: 'cancelled', updatedAt: now }));
  }

  /** active -> completed. Done by the system once the end date and the grace period have passed. */
  complete(now: Date): Result<Challenge> {
    if (this.status !== 'active') return invalidState('completed', this.status);
    return ok(this.with({ status: 'completed', completedOn: this.endsOn, updatedAt: now }));
  }

  /** Joining is possible while the challenge is active and its last day has not passed. */
  canJoinOn(today: string): boolean {
    return this.status === 'active' && today <= this.endsOn;
  }

  /** An activity scores only in an active challenge, on one of its days. */
  scoresOn(activityDate: string): boolean {
    return this.status === 'active' && this.startsOn <= activityDate && activityDate <= this.endsOn;
  }

  /** Administrators, and managers of the challenge's team. */
  canBeManagedBy(viewer: Viewer): boolean {
    return viewer.role === 'admin' || viewer.managedTeamIds.includes(this.teamId);
  }

  /**
   * Who may know this challenge exists. A draft is visible to those who manage it (and its creator);
   * once started, also to the members of its team. Everybody else gets "not found".
   */
  canBeSeenBy(viewer: Viewer): boolean {
    if (this.canBeManagedBy(viewer) || this.createdByUserId === viewer.userId) return true;
    return this.status !== 'draft' && viewer.teamIds.includes(this.teamId);
  }

  isMemberTeam(viewer: Viewer): boolean {
    return viewer.teamIds.includes(this.teamId);
  }
}
