import type { Principal } from '@teampulse/auth';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createUseCases } from '../../src/application/index.js';
import type { ReminderSchedule } from '../../src/domain/reminder.js';
import { InMemoryUnitOfWork } from './in-memory.js';

/** Friday 2026-11-20, 08:00 UTC. */
export const START = '2026-11-20T08:00:00Z';

/** Deterministic ids for people, habits and challenges, readable in assertions. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ALICE = uuid(0xa1);
export const BOB = uuid(0xb1);
export const HABIT = uuid(0x51);
export const OTHER_HABIT = uuid(0x52);
export const CHALLENGE = uuid(0xc0);

export const principal = (userId: string): Principal => ({
  userId,
  role: 'employee',
  teamIds: [],
  managedTeamIds: [],
});

/** 09:00 in Berlin on Fridays (= 08:00 UTC in November). */
export const FRIDAY_NINE_BERLIN: ReminderSchedule = {
  daysOfWeek: ['fri'],
  remindAt: '09:00',
  timeZone: 'Europe/Berlin',
};

/** The whole application wired to in-memory adapters. No I/O, so tests run in milliseconds. */
export function buildHarness(options: { windowMinutes?: number } = {}) {
  const clock = new FixedClock(START);
  const ids = new SequentialIdGenerator();
  const uow = new InMemoryUnitOfWork();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'notification-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });

  const app = createUseCases({
    uow,
    clock,
    ids,
    logger,
    reminderWindowMinutes: options.windowMinutes ?? 15,
  });

  /** Sets a habit's reminder, as a HabitCreated event would. */
  async function scheduleReminder(
    userId: string,
    habitId = HABIT,
    schedule: ReminderSchedule = FRIDAY_NINE_BERLIN,
    at = '2026-11-01T08:00:00Z',
  ) {
    unwrap(
      await app.applyHabitReminder.execute({
        habitId,
        ownerUserId: userId,
        reminder: { ...schedule, daysOfWeek: [...schedule.daysOfWeek] },
        occurredAt: new Date(at),
      }),
    );
  }

  const list = async (userId: string, options: { unreadOnly?: boolean } = {}) =>
    unwrap(
      await app.listNotifications.execute({
        actor: principal(userId),
        unreadOnly: options.unreadOnly ?? false,
        limit: 50,
      }),
    );

  return { app, clock, uow, logLines, scheduleReminder, list };
}

export type Harness = ReturnType<typeof buildHarness>;
