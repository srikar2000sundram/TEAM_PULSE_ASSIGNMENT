import type { NotificationPreferences } from '@teampulse/contracts';
import type {
  NotificationListQuery,
  NotificationRepository,
  ParticipantRepository,
  PreferenceRepository,
  ReminderRepository,
  StoredReminder,
  Transaction,
  UnitOfWork,
} from '../../src/application/ports.js';
import type { Notification } from '../../src/domain/notification.js';
import type { ReminderSchedule } from '../../src/domain/reminder.js';

interface StoredReminderRow {
  habitId: string;
  userId: string;
  schedule: ReminderSchedule | null;
  archived: boolean;
  lastEventAt: Date;
}

/**
 * In-memory adapters used by unit tests. They implement the same rules as the SQL (one
 * notification per person and source, order-tolerant reminders), and the shared repository contract
 * suite runs against both this and PostgreSQL, so the two cannot drift.
 */
export class InMemoryStore {
  notifications = new Map<string, Notification>();
  preferences = new Map<string, { value: NotificationPreferences; updatedAt: Date }>();
  reminders = new Map<string, StoredReminderRow>();
  occurrences = new Map<string, Date>();
  participants = new Set<string>();

  snapshot() {
    return {
      notifications: new Map(this.notifications),
      preferences: new Map(this.preferences),
      reminders: new Map(this.reminders),
      occurrences: new Map(this.occurrences),
      participants: new Set(this.participants),
    };
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>): void {
    this.notifications = snapshot.notifications;
    this.preferences = snapshot.preferences;
    this.reminders = snapshot.reminders;
    this.occurrences = snapshot.occurrences;
    this.participants = snapshot.participants;
  }
}

class InMemoryNotifications implements NotificationRepository {
  constructor(private readonly store: InMemoryStore) {}

  insertMany(notifications: readonly Notification[]) {
    let inserted = 0;
    for (const n of notifications) {
      const duplicate = [...this.store.notifications.values()].some(
        (existing) => existing.userId === n.userId && existing.sourceId === n.sourceId,
      );
      if (!duplicate) {
        this.store.notifications.set(n.id, n);
        inserted += 1;
      }
    }
    return Promise.resolve(inserted);
  }

  list(query: NotificationListQuery) {
    const rows = [...this.store.notifications.values()]
      .filter((n) => n.userId === query.userId && (!query.unreadOnly || !n.isRead))
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .filter((n) => {
        if (query.after === undefined) return true;
        const time = n.createdAt.getTime();
        const afterTime = query.after.createdAt.getTime();
        return time < afterTime || (time === afterTime && n.id < query.after.id);
      });
    return Promise.resolve(rows.slice(0, query.limit));
  }

  unreadCount(userId: string) {
    return Promise.resolve(
      [...this.store.notifications.values()].filter((n) => n.userId === userId && !n.isRead).length,
    );
  }

  markRead(userId: string, id: string, now: Date) {
    const existing = this.store.notifications.get(id);
    if (existing === undefined || existing.userId !== userId) return Promise.resolve(null);
    const read = existing.markRead(now);
    this.store.notifications.set(id, read);
    return Promise.resolve(read);
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const n of [...this.store.notifications.values()]) {
      if (n.userId === userId) {
        this.store.notifications.delete(n.id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryPreferences implements PreferenceRepository {
  constructor(private readonly store: InMemoryStore) {}

  find(userId: string) {
    return Promise.resolve(this.store.preferences.get(userId)?.value ?? null);
  }

  findMany(userIds: readonly string[]) {
    const found = new Map<string, NotificationPreferences>();
    for (const id of userIds) {
      const row = this.store.preferences.get(id);
      if (row !== undefined) found.set(id, row.value);
    }
    return Promise.resolve(found);
  }

  save(userId: string, preferences: NotificationPreferences, now: Date) {
    this.store.preferences.set(userId, { value: preferences, updatedAt: now });
    return Promise.resolve();
  }

  deleteForUser(userId: string) {
    return Promise.resolve(this.store.preferences.delete(userId) ? 1 : 0);
  }
}

class InMemoryReminders implements ReminderRepository {
  constructor(private readonly store: InMemoryStore) {}

  applySnapshot(reminder: {
    habitId: string;
    userId: string;
    schedule: ReminderSchedule | null;
    at: Date;
  }) {
    const existing = this.store.reminders.get(reminder.habitId);
    if (existing === undefined) {
      this.store.reminders.set(reminder.habitId, {
        habitId: reminder.habitId,
        userId: reminder.userId,
        schedule: reminder.schedule,
        archived: false,
        lastEventAt: reminder.at,
      });
    } else {
      const newer = reminder.at.getTime() >= existing.lastEventAt.getTime();
      this.store.reminders.set(reminder.habitId, {
        ...existing,
        schedule: newer ? reminder.schedule : existing.schedule,
        lastEventAt: newer ? reminder.at : existing.lastEventAt,
      });
    }
    return Promise.resolve();
  }

  applyArchived(reminder: { habitId: string; userId: string; at: Date }) {
    const existing = this.store.reminders.get(reminder.habitId);
    this.store.reminders.set(
      reminder.habitId,
      existing === undefined
        ? {
            habitId: reminder.habitId,
            userId: reminder.userId,
            schedule: null,
            archived: true,
            lastEventAt: reminder.at,
          }
        : {
            ...existing,
            archived: true,
            lastEventAt:
              reminder.at.getTime() > existing.lastEventAt.getTime()
                ? reminder.at
                : existing.lastEventAt,
          },
    );
    return Promise.resolve();
  }

  listActive() {
    const active: StoredReminder[] = [];
    for (const row of this.store.reminders.values()) {
      if (!row.archived && row.schedule !== null) {
        active.push({ habitId: row.habitId, userId: row.userId, schedule: row.schedule });
      }
    }
    return Promise.resolve(active);
  }

  claimOccurrence(habitId: string, localDate: string, now: Date) {
    const key = `${habitId}|${localDate}`;
    if (this.store.occurrences.has(key)) return Promise.resolve(false);
    this.store.occurrences.set(key, now);
    return Promise.resolve(true);
  }

  purgeOccurrences(before: Date) {
    let removed = 0;
    for (const [key, createdAt] of [...this.store.occurrences]) {
      if (createdAt.getTime() < before.getTime()) {
        this.store.occurrences.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const row of [...this.store.reminders.values()]) {
      if (row.userId === userId) {
        this.store.reminders.delete(row.habitId);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryParticipants implements ParticipantRepository {
  constructor(private readonly store: InMemoryStore) {}

  add(challengeId: string, userId: string) {
    this.store.participants.add(`${challengeId}|${userId}`);
    return Promise.resolve();
  }

  usersOf(challengeId: string) {
    return Promise.resolve(
      [...this.store.participants]
        .filter((key) => key.startsWith(`${challengeId}|`))
        .map((key) => key.split('|')[1] ?? '')
        .sort(),
    );
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const key of [...this.store.participants]) {
      if (key.endsWith(`|${userId}`)) {
        this.store.participants.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store: InMemoryStore = new InMemoryStore()) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    const tx: Transaction = {
      notifications: new InMemoryNotifications(this.store),
      preferences: new InMemoryPreferences(this.store),
      reminders: new InMemoryReminders(this.store),
      participants: new InMemoryParticipants(this.store),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.store.restore(before); // roll back only when the work throws
      throw error;
    }
  }
}
