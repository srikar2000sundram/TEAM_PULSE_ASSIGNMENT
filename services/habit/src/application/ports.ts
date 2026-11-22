import type { ActivityType } from '@teampulse/contracts';
import type { Cursor } from '@teampulse/kernel';
import type { Outbox } from '@teampulse/outbox';
import type { Habit, Viewer } from '../domain/habit.js';

export interface HabitListQuery {
  readonly viewer: Viewer;
  /** `mine`: the viewer's own habits. `team`: other people's habits shared with the viewer's teams. */
  readonly scope: 'mine' | 'team';
  readonly status: 'active' | 'archived';
  readonly activityType?: ActivityType;
  /** Only meaningful for scope `team`; teams the viewer does not belong to yield nothing. */
  readonly teamId?: string;
  readonly limit: number;
  readonly after?: Cursor;
}

export interface HabitRepository {
  insert(habit: Habit): Promise<void>;

  /**
   * Loads a habit **only if the viewer may see it** (see `Habit.isVisibleTo`). Visibility is part
   * of the query, not a check afterwards: a habit the viewer may not see is never loaded, and
   * looks exactly like one that does not exist. `lock` takes a row lock for read-modify-write.
   */
  findVisible(id: string, viewer: Viewer, options?: { lock?: boolean }): Promise<Habit | null>;

  update(habit: Habit): Promise<void>;
  countActiveOwnedBy(ownerUserId: string): Promise<number>;

  /** Newest first, ordered by (createdAt, id); the visibility rules are applied in the query. */
  list(query: HabitListQuery): Promise<readonly Habit[]>;

  /** Makes the owner's habits shared with `teamId` private. Returns the habits it changed. */
  withdrawFromTeam(ownerUserId: string, teamId: string, now: Date): Promise<readonly Habit[]>;

  /** Right to erasure. Returns how many habits were removed. */
  deleteAllOwnedBy(ownerUserId: string): Promise<number>;
}

export interface Transaction {
  readonly habits: HabitRepository;
  readonly outbox: Outbox;
}

/** Runs `work` atomically: commits when it returns, rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
