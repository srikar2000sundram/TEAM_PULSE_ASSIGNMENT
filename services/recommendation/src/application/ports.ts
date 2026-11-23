export interface ActivityTime {
  readonly habitId: string;
  readonly occurredAt: Date;
}

/** When each person completed each habit. Only instants and identifiers, never content. */
export interface ActivityTimeRepository {
  /**
   * Stores one completion unless this event was already stored. This is what makes handling an event
   * twice harmless. Returns true when it was new.
   */
  record(entry: {
    eventId: string;
    userId: string;
    habitId: string;
    occurredAt: Date;
  }): Promise<boolean>;
  /** Only ever the given person's completions, from `since` onwards. */
  listSince(userId: string, since: Date): Promise<readonly ActivityTime[]>;
  /** Housekeeping: forget completions older than the look-back window. */
  purgeBefore(before: Date): Promise<number>;
  deleteAllForUser(userId: string): Promise<number>;
}

export type Decision = 'accepted' | 'dismissed';

export interface StoredDecision {
  readonly userId: string;
  readonly habitId: string;
  readonly suggestedTime: string;
  readonly timeZone: string;
  readonly decision: Decision;
}

/** What the person decided about a particular suggestion. Deciding again replaces the earlier decision. */
export interface DecisionRepository {
  save(decision: StoredDecision, now: Date): Promise<void>;
  listForUser(userId: string): Promise<readonly StoredDecision[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface Transaction {
  readonly activityTimes: ActivityTimeRepository;
  readonly decisions: DecisionRepository;
}

/** Runs `work` atomically: commits when it returns, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
