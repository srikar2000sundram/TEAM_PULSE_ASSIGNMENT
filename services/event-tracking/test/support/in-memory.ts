import type { ActivityType, TeamPulseEvent } from '@teampulse/contracts';
import type { Outbox } from '@teampulse/outbox';
import type {
  ActivityListQuery,
  ActivityRepository,
  HabitDirectory,
  KnownHabit,
  Transaction,
  UnitOfWork,
} from '../../src/application/ports.js';
import type { Activity } from '../../src/domain/activity.js';

interface StoredHabit extends KnownHabit {
  lastEventAt: Date;
}

/**
 * In-memory adapters used by unit tests. They implement the same rules as the SQL (unique key per
 * user, habit and day; order-tolerant habit directory), and the shared repository contract suite
 * runs against both this and PostgreSQL, so the two cannot drift.
 */
export class InMemoryStore {
  activities = new Map<string, Activity>();
  habits = new Map<string, StoredHabit>();
  outbox: TeamPulseEvent[] = [];

  snapshot() {
    return {
      activities: new Map(this.activities),
      habits: new Map(this.habits),
      outbox: [...this.outbox],
    };
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>): void {
    this.activities = snapshot.activities;
    this.habits = snapshot.habits;
    this.outbox = snapshot.outbox;
  }
}

const dayKey = (a: { userId: string; habitId: string; activityDate: string }) =>
  `${a.userId}|${a.habitId}|${a.activityDate}`;

class InMemoryActivities implements ActivityRepository {
  constructor(private readonly store: InMemoryStore) {}

  insertIfAbsent(activity: Activity) {
    const existing = [...this.store.activities.values()].find(
      (a) => dayKey(a) === dayKey(activity),
    );
    if (existing !== undefined) return Promise.resolve({ activity: existing, created: false });
    this.store.activities.set(activity.id, activity);
    return Promise.resolve({ activity, created: true });
  }

  list(query: ActivityListQuery) {
    const rows = [...this.store.activities.values()]
      .filter(
        (a) =>
          a.userId === query.userId &&
          (query.from === undefined || a.activityDate >= query.from) &&
          (query.to === undefined || a.activityDate <= query.to) &&
          (query.habitId === undefined || a.habitId === query.habitId),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .filter((a) => {
        if (query.after === undefined) return true;
        const time = a.createdAt.getTime();
        const afterTime = query.after.createdAt.getTime();
        return time < afterTime || (time === afterTime && a.id < query.after.id);
      });
    return Promise.resolve(rows.slice(0, query.limit));
  }

  countForUser(userId: string) {
    return Promise.resolve(
      [...this.store.activities.values()].filter((a) => a.userId === userId).length,
    );
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const activity of [...this.store.activities.values()]) {
      if (activity.userId === userId) {
        this.store.activities.delete(activity.id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryHabitDirectory implements HabitDirectory {
  constructor(private readonly store: InMemoryStore) {}

  find(habitId: string) {
    const stored = this.store.habits.get(habitId);
    if (stored === undefined) return Promise.resolve(null);
    const { lastEventAt: _ignored, ...habit } = stored;
    return Promise.resolve(habit);
  }

  applySnapshot(habit: {
    habitId: string;
    ownerUserId: string;
    activityType: ActivityType;
    at: Date;
  }) {
    const existing = this.store.habits.get(habit.habitId);
    if (existing === undefined) {
      this.store.habits.set(habit.habitId, {
        habitId: habit.habitId,
        ownerUserId: habit.ownerUserId,
        activityType: habit.activityType,
        archived: false,
        lastEventAt: habit.at,
      });
    } else {
      const newer = habit.at.getTime() >= existing.lastEventAt.getTime();
      this.store.habits.set(habit.habitId, {
        ...existing,
        activityType:
          existing.activityType === null || newer ? habit.activityType : existing.activityType,
        lastEventAt: newer ? habit.at : existing.lastEventAt,
      });
    }
    return Promise.resolve();
  }

  applyArchived(habit: { habitId: string; ownerUserId: string; at: Date }) {
    const existing = this.store.habits.get(habit.habitId);
    this.store.habits.set(
      habit.habitId,
      existing === undefined
        ? {
            habitId: habit.habitId,
            ownerUserId: habit.ownerUserId,
            activityType: null,
            archived: true,
            lastEventAt: habit.at,
          }
        : {
            ...existing,
            archived: true,
            lastEventAt:
              habit.at.getTime() > existing.lastEventAt.getTime() ? habit.at : existing.lastEventAt,
          },
    );
    return Promise.resolve();
  }

  deleteAllOwnedBy(ownerUserId: string) {
    let removed = 0;
    for (const habit of [...this.store.habits.values()]) {
      if (habit.ownerUserId === ownerUserId) {
        this.store.habits.delete(habit.habitId);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryOutbox implements Outbox {
  constructor(private readonly store: InMemoryStore) {}
  append(event: TeamPulseEvent) {
    this.store.outbox.push(event);
    return Promise.resolve();
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store: InMemoryStore = new InMemoryStore()) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    const tx: Transaction = {
      activities: new InMemoryActivities(this.store),
      habits: new InMemoryHabitDirectory(this.store),
      outbox: new InMemoryOutbox(this.store),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.store.restore(before); // roll back only when the work throws
      throw error;
    }
  }
}
