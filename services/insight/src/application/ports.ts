import type { ActivityType } from '@teampulse/contracts';
import type { CellData, PersonalDay } from '../domain/report.js';

/** One scope an activity counts in, and the pseudonym of the person within that scope. */
export interface Contribution {
  readonly scopeKey: string;
  readonly participant: string;
}

/** Everything the store needs to count one `ActivityCompleted`. */
export interface ActivityObservation {
  /** Identifies the event, so a redelivered one is recognised and counted once. */
  readonly eventId: string;
  readonly userId: string;
  readonly day: string;
  readonly activityType: ActivityType;
  readonly contributions: readonly Contribution[];
  /** When the stored counters may be deleted by the database (data retention). */
  readonly expiresAt: Date;
}

/**
 * Where aggregates are kept. DynamoDB in production, an in-memory fake in tests.
 *
 * Two kinds of data, deliberately in separate tables with separate permissions:
 * - **cells**: per scope, day and type: a completion counter and pseudonymous participants. No
 *   user ids. This is all that manager and administrator requests can ever read;
 * - **personal days**: per user, day and type: a counter, for "my activity". Only that user reads it.
 */
export interface AnalyticsStore {
  /**
   * Counts the activity in the personal counters and in every contribution's cell, **atomically**
   * and **once per event**: a second call with the same `eventId` changes nothing and returns
   * `duplicate`.
   */
  record(observation: ActivityObservation): Promise<'recorded' | 'duplicate'>;

  /** The cells of one scope between two days (inclusive). Cells with no data are not returned. */
  readCells(scopeKey: string, from: string, to: string): Promise<readonly CellData[]>;

  /** One person's counters between two days (inclusive). */
  readPersonal(userId: string, from: string, to: string): Promise<readonly PersonalDay[]>;

  /**
   * Takes one personal day back out of the personal counters and of every given cell, atomically.
   * Safe to repeat: when the personal day is already gone nothing happens.
   */
  erasePersonalDay(
    userId: string,
    day: PersonalDay,
    contributions: readonly Contribution[],
  ): Promise<void>;

  /** Cheap round trip, for the readiness probe. */
  ping(): Promise<void>;
}

/**
 * Turns a user id into a stable, meaningless token within one scope. The same person in two
 * scopes gets two unrelated tokens, so cells cannot be joined to follow a person around.
 */
export interface Pseudonymizer {
  participant(scopeKey: string, userId: string): string;
}
