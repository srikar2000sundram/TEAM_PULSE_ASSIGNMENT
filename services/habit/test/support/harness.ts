import type { Principal } from '@teampulse/auth';
import type { ActivityType, HabitReminder, Role } from '@teampulse/contracts';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createUseCases } from '../../src/application/index.js';
import { InMemoryUnitOfWork } from './in-memory.js';

export const START = '2026-11-20T08:00:00Z';

/** Deterministic ids for people and teams, readable in assertions. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ALICE = uuid(0xa1);
export const BOB = uuid(0xb1);
export const CAROL = uuid(0xc1);
export const DAVE = uuid(0xd1);
export const PLATFORM = uuid(0x71);
export const DATA = uuid(0x72);

/** What a verified access token would carry. */
export function principal(
  userId: string,
  options: { role?: Role; teams?: readonly string[]; manages?: readonly string[] } = {},
): Principal {
  return {
    userId,
    role: options.role ?? 'employee',
    teamIds: options.teams ?? [],
    managedTeamIds: options.manages ?? [],
  };
}

export const REMINDER: HabitReminder = {
  daysOfWeek: ['wed', 'mon'],
  remindAt: '07:30',
  timeZone: 'Europe/Berlin',
};

/** The whole application wired to in-memory adapters. No I/O, so tests run in milliseconds. */
export function buildHarness(options: { maxActiveHabits?: number } = {}) {
  const clock = new FixedClock(START);
  const ids = new SequentialIdGenerator();
  const uow = new InMemoryUnitOfWork();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'habit-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });

  const app = createUseCases({
    uow,
    clock,
    ids,
    logger,
    maxActiveHabits: options.maxActiveHabits ?? 50,
  });

  /** Creates a habit through the real use case and returns it (failing the test if it cannot). */
  async function createHabit(
    actor: Principal,
    overrides: {
      title?: string;
      description?: string;
      activityType?: ActivityType;
      visibility?: 'private' | 'team';
      teamId?: string;
      reminder?: HabitReminder;
    } = {},
  ) {
    return unwrap(
      await app.createHabit.execute({
        actor,
        title: overrides.title ?? 'Morning walk',
        activityType: overrides.activityType ?? 'walking',
        visibility: overrides.visibility ?? 'private',
        ...(overrides.description === undefined ? {} : { description: overrides.description }),
        ...(overrides.teamId === undefined ? {} : { teamId: overrides.teamId }),
        ...(overrides.reminder === undefined ? {} : { reminder: overrides.reminder }),
      }),
    );
  }

  return {
    app,
    clock,
    uow,
    logLines,
    createHabit,
    outbox: () => uow.store.outbox,
    clearOutbox: () => {
      uow.store.outbox = [];
    },
  };
}

export type Harness = ReturnType<typeof buildHarness>;
