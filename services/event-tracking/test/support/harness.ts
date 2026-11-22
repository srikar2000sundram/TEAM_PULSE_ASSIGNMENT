import type { Principal } from '@teampulse/auth';
import type { ActivityType } from '@teampulse/contracts';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createUseCases } from '../../src/application/index.js';
import { DEFAULT_DATE_POLICY } from '../../src/domain/activity.js';
import { InMemoryUnitOfWork } from './in-memory.js';

/** 2026-11-20, 08:00 UTC. */
export const START = '2026-11-20T08:00:00Z';
export const TODAY = '2026-11-20';

/** Deterministic ids for people, teams and habits, readable in assertions. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ALICE = uuid(0xa1);
export const BOB = uuid(0xb1);
export const PLATFORM = uuid(0x71);
export const DATA = uuid(0x72);
export const HABIT = uuid(0x51);
export const OTHER_HABIT = uuid(0x52);

/** What a verified access token would carry. */
export function principal(userId: string, options: { teams?: readonly string[] } = {}): Principal {
  return { userId, role: 'employee', teamIds: options.teams ?? [], managedTeamIds: [] };
}

/** The whole application wired to in-memory adapters. No I/O, so tests run in milliseconds. */
export function buildHarness(options: { backfillDays?: number } = {}) {
  const clock = new FixedClock(START);
  const ids = new SequentialIdGenerator();
  const uow = new InMemoryUnitOfWork();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'event-tracking-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });

  const app = createUseCases({
    uow,
    clock,
    ids,
    logger,
    datePolicy: { ...DEFAULT_DATE_POLICY, backfillDays: options.backfillDays ?? 7 },
  });

  /** Tells the service about a habit, as a HabitCreated event would. */
  async function knowHabit(
    ownerUserId: string,
    habitId = HABIT,
    activityType: ActivityType = 'walking',
  ) {
    unwrap(
      await app.applyHabitSnapshot.execute({
        habitId,
        ownerUserId,
        activityType,
        occurredAt: new Date('2026-11-01T08:00:00Z'),
      }),
    );
  }

  const record = (actor: Principal, activityDate = TODAY, habitId = HABIT) =>
    app.recordActivity.execute({ actor, habitId, activityDate });

  return {
    app,
    clock,
    uow,
    logLines,
    knowHabit,
    record,
    outbox: () => uow.store.outbox,
    clearOutbox: () => {
      uow.store.outbox = [];
    },
  };
}

export type Harness = ReturnType<typeof buildHarness>;
