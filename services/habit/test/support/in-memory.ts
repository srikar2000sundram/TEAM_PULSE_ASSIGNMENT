import type { TeamPulseEvent } from '@teampulse/contracts';
import type { Outbox } from '@teampulse/outbox';
import type {
  HabitListQuery,
  HabitRepository,
  Transaction,
  UnitOfWork,
} from '../../src/application/ports.js';
import type { Habit, Viewer } from '../../src/domain/habit.js';

/**
 * In-memory adapters used by unit tests. They apply the same visibility rule as the SQL queries
 * (`Habit.isVisibleTo`), and the shared repository contract suite runs against both this and
 * PostgreSQL, so the two cannot drift.
 */
export class InMemoryStore {
  habits = new Map<string, Habit>();
  outbox: TeamPulseEvent[] = [];

  snapshot() {
    return { habits: new Map(this.habits), outbox: [...this.outbox] };
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>): void {
    this.habits = snapshot.habits;
    this.outbox = snapshot.outbox;
  }
}

/** Newest first; ties broken by id, exactly like `ORDER BY created_at DESC, id DESC`. */
const newestFirst = (a: Habit, b: Habit): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

class InMemoryHabits implements HabitRepository {
  constructor(private readonly store: InMemoryStore) {}

  insert(habit: Habit) {
    this.store.habits.set(habit.id, habit);
    return Promise.resolve();
  }

  findVisible(id: string, viewer: Viewer) {
    const habit = this.store.habits.get(id);
    return Promise.resolve(habit !== undefined && habit.isVisibleTo(viewer) ? habit : null);
  }

  update(habit: Habit) {
    this.store.habits.set(habit.id, habit);
    return Promise.resolve();
  }

  countActiveOwnedBy(ownerUserId: string) {
    return Promise.resolve(
      [...this.store.habits.values()].filter((h) => h.isOwnedBy(ownerUserId) && !h.isArchived)
        .length,
    );
  }

  list(query: HabitListQuery) {
    const { viewer } = query;
    const matches = [...this.store.habits.values()]
      .filter((habit) => {
        if (query.scope === 'mine') {
          if (!habit.isOwnedBy(viewer.userId)) return false;
          if (habit.isArchived !== (query.status === 'archived')) return false;
        } else {
          if (habit.isOwnedBy(viewer.userId) || !habit.isVisibleTo(viewer)) return false;
          if (query.teamId !== undefined && habit.teamId !== query.teamId) return false;
        }
        return query.activityType === undefined || habit.activityType === query.activityType;
      })
      .sort(newestFirst)
      .filter((habit) => {
        if (query.after === undefined) return true;
        const time = habit.createdAt.getTime();
        const afterTime = query.after.createdAt.getTime();
        return time < afterTime || (time === afterTime && habit.id < query.after.id);
      });
    return Promise.resolve(matches.slice(0, query.limit));
  }

  withdrawFromTeam(ownerUserId: string, teamId: string, now: Date) {
    const changed: Habit[] = [];
    for (const habit of this.store.habits.values()) {
      if (habit.isOwnedBy(ownerUserId) && habit.teamId === teamId) {
        const withdrawn = habit.makePrivate(now);
        this.store.habits.set(habit.id, withdrawn);
        changed.push(withdrawn);
      }
    }
    return Promise.resolve(changed);
  }

  deleteAllOwnedBy(ownerUserId: string) {
    let removed = 0;
    for (const habit of [...this.store.habits.values()]) {
      if (habit.isOwnedBy(ownerUserId)) {
        this.store.habits.delete(habit.id);
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
      habits: new InMemoryHabits(this.store),
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
