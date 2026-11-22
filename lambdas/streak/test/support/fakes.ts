import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import type { EventPublisher, PublishOutcome } from '@teampulse/outbox';
import { UpdateStreak, type StreakStore } from '../../src/application/update-streak.js';
import type { StreakState } from '../../src/domain/streak.js';

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const USER = id(0xa1);
export const HABIT = id(0x51);

/** Same conditional-write semantics as DynamoDB: save only if the stored version matches. */
export class InMemoryStreakStore implements StreakStore {
  readonly items = new Map<string, StreakState>();
  /** Simulates another invocation winning the race on the next N saves. */
  conflictsToInject = 0;
  saveCalls = 0;

  private key = (userId: string, habitId: string) => `${userId}|${habitId}`;

  get(userId: string, habitId: string) {
    return Promise.resolve(this.items.get(this.key(userId, habitId)) ?? null);
  }

  save(state: StreakState, expectedVersion: number | null) {
    this.saveCalls += 1;
    const key = this.key(state.userId, state.habitId);
    if (this.conflictsToInject > 0) {
      this.conflictsToInject -= 1;
      // The competitor writes first, so our expected version is now stale.
      const current = this.items.get(key);
      this.items.set(
        key,
        current === undefined
          ? { ...state, currentStreak: 1, longestStreak: 1, version: 1 }
          : { ...current, version: current.version + 1 },
      );
    }
    const stored = this.items.get(key);
    if ((stored?.version ?? null) !== expectedVersion) return Promise.resolve(false);
    this.items.set(key, state);
    return Promise.resolve(true);
  }
}

export class RecordingPublisher implements EventPublisher {
  readonly published: TeamPulseEvent[] = [];
  /** Fail this many publish calls before succeeding. */
  failures = 0;
  /** Outcome to report instead of throwing. */
  rejectWith: string | undefined;

  publish(events: readonly TeamPulseEvent[]): Promise<readonly PublishOutcome[]> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('bus unreachable'));
    }
    if (this.rejectWith !== undefined) {
      const error = this.rejectWith;
      return Promise.resolve(events.map((e) => ({ eventId: e.eventId, error })));
    }
    this.published.push(...events);
    return Promise.resolve(events.map((e) => ({ eventId: e.eventId })));
  }
}

let counter = 0;
export function activity(
  date: string,
  overrides: { userId?: string; habitId?: string; eventId?: string } = {},
): TeamPulseEvent<'ActivityCompleted'> {
  counter += 1;
  return createEvent('ActivityCompleted', {
    eventId: overrides.eventId ?? id(0x1000 + counter),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: id(0x2000 + counter),
    payload: {
      userId: overrides.userId ?? USER,
      habitId: overrides.habitId ?? HABIT,
      teamIds: [],
      activityType: 'walking',
      activityDate: date,
      totalCompleted: 1,
    },
  });
}

export function setup(options: { maxAttempts?: number } = {}) {
  const store = new InMemoryStreakStore();
  const publisher = new RecordingPublisher();
  const logs: string[] = [];
  const update = new UpdateStreak({
    store,
    publisher,
    clock: new FixedClock('2026-11-20T09:00:00Z'),
    logger: createLogger({ service: 'streak-test', level: 'debug', write: (l) => logs.push(l) }),
    ...options,
  });
  const state = () => store.items.get(`${USER}|${HABIT}`);
  return { store, publisher, logs, update, state };
}
