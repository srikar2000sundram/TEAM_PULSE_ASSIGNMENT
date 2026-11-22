import type { ActivityType, ChallengeStatus } from '@teampulse/contracts';
import type { Cursor } from '@teampulse/kernel';
import type { Outbox } from '@teampulse/outbox';
import type { Challenge, Viewer } from '../domain/challenge.js';
import type { RankedStanding } from '../domain/progress.js';

export interface ChallengeListQuery {
  readonly viewer: Viewer;
  readonly status?: ChallengeStatus;
  readonly limit: number;
  readonly after?: Cursor;
}

export interface ChallengeRepository {
  insert(challenge: Challenge): Promise<void>;

  /**
   * Loads a challenge **only if the viewer may see it** (see `Challenge.canBeSeenBy`). Visibility is
   * part of the query: a challenge the viewer may not see is never loaded and looks exactly like one
   * that does not exist.
   */
  findVisible(id: string, viewer: Viewer): Promise<Challenge | null>;

  /**
   * Stores a state change, but only if the stored status is still `from`. Returns false when
   * someone else moved the challenge first, so two simultaneous requests cannot both succeed.
   */
  transition(challenge: Challenge, from: ChallengeStatus): Promise<boolean>;

  /** Newest first, ordered by (createdAt, id); the visibility rules are applied in the query. */
  list(query: ChallengeListQuery): Promise<readonly Challenge[]>;

  /**
   * The active challenges in which this person's activity of this type on this day scores: they
   * take part, had joined by that day, the type matches and the day is inside the challenge.
   */
  findScoring(
    userId: string,
    activityType: ActivityType,
    activityDate: string,
  ): Promise<readonly Challenge[]>;

  /** Drafts whose start date has come and whose end date has not passed. */
  listDraftsDue(today: string): Promise<readonly Challenge[]>;

  /** Active challenges whose last day is before `cutoff`. */
  listActiveEndedBefore(cutoff: string): Promise<readonly Challenge[]>;

  /** Right to erasure: challenges the person created stay, without the link to them. */
  detachCreator(userId: string): Promise<number>;
}

export interface Participation {
  readonly challengeId: string;
  readonly userId: string;
  readonly joinedOn: string;
  readonly points: number;
}

export interface ParticipationRepository {
  /** False when the person already takes part. */
  add(input: {
    challengeId: string;
    userId: string;
    teamId: string;
    joinedOn: string;
  }): Promise<boolean>;
  find(challengeId: string, userId: string): Promise<Participation | null>;
  /** How many take part in each challenge. Challenges without participants map to zero. */
  countFor(challengeIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Which of these challenges the person takes part in. */
  joinedAmong(userId: string, challengeIds: readonly string[]): Promise<ReadonlySet<string>>;
  addPoint(challengeId: string, userId: string): Promise<void>;
  /** Highest points first; equal points share a rank (1, 2, 2, 4). */
  leaderboard(challengeId: string, limit: number): Promise<readonly RankedStanding[]>;
  rankOf(challengeId: string, userId: string): Promise<RankedStanding | null>;
  /** Removes the person from the unfinished challenges of a team. Returns those challenge ids. */
  withdrawFromTeam(userId: string, teamId: string): Promise<readonly string[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

/**
 * The scoring ledger: one row per qualifying activity, keyed by the event that caused it. It is the
 * source of truth for progress, and its key is what makes scoring idempotent.
 */
export interface ProgressLedger {
  /** False when this event was already scored for this challenge. */
  record(entry: {
    challengeId: string;
    sourceEventId: string;
    userId: string;
    activityDate: string;
  }): Promise<boolean>;
  /** The dates of all of a person's qualifying activities in a challenge, oldest first. */
  dates(challengeId: string, userId: string): Promise<readonly string[]>;
  deleteForUserIn(userId: string, challengeIds: readonly string[]): Promise<number>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface AwardedBadge {
  readonly challengeId: string;
  readonly userId: string;
  readonly badgeRuleId: string;
  readonly awardedOn: string;
}

export interface BadgeRepository {
  /** False when this person already holds this badge. */
  award(badge: AwardedBadge): Promise<boolean>;
  listFor(challengeId: string, userId: string): Promise<readonly AwardedBadge[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface Transaction {
  readonly challenges: ChallengeRepository;
  readonly participations: ParticipationRepository;
  readonly progress: ProgressLedger;
  readonly badges: BadgeRepository;
  readonly outbox: Outbox;
}

/** Runs `work` atomically: commits when it returns, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
