import type { Principal } from '@teampulse/auth';
import type { ActivityType } from '@teampulse/contracts';
import { FixedClock, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { HmacPseudonymizer } from '../../src/adapters/hmac-pseudonymizer.js';
import { createUseCases } from '../../src/application/index.js';
import type { AnalyticsStore } from '../../src/application/ports.js';
import { InMemoryAnalyticsStore } from './in-memory.js';

export const START = '2026-11-20T08:00:00Z';
export const KEY = 'test-pseudonym-key-test-pseudonym-key';

export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const TEAM = uuid(0x7a);
export const OTHER_TEAM = uuid(0x7b);
export const MANAGER = uuid(0xe1);
export const ADMIN = uuid(0xad);
/** People numbered 1.. in a stable way. */
export const person = (n: number): string => uuid(0xa000 + n);

export const principalOf = (
  userId: string,
  options: { role?: Principal['role']; teams?: string[]; manages?: string[] } = {},
): Principal => ({
  userId,
  role: options.role ?? 'employee',
  teamIds: options.teams ?? [],
  managedTeamIds: options.manages ?? [],
});

export const manager = principalOf(MANAGER, { role: 'manager', manages: [TEAM], teams: [TEAM] });
export const admin = principalOf(ADMIN, { role: 'admin' });

let eventCounter = 0;

/** The application wired to an in-memory store. No I/O: tests run in milliseconds. */
export function buildHarness(
  options: { minCohortSize?: number; retentionDays?: number; store?: AnalyticsStore } = {},
) {
  const clock = new FixedClock(START);
  const store = options.store ?? new InMemoryAnalyticsStore();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'insight-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });
  const pseudonyms = new HmacPseudonymizer(KEY);
  const app = createUseCases({
    store,
    pseudonyms,
    clock,
    logger,
    minCohortSize: options.minCohortSize ?? 5,
    retentionDays: options.retentionDays ?? 400,
  });

  /** Counts one activity, as an `ActivityCompleted` event would. */
  async function record(
    userId: string,
    options: {
      teams?: string[];
      type?: ActivityType;
      date?: string;
      eventId?: string;
    } = {},
  ) {
    eventCounter += 1;
    return unwrap(
      await app.recordActivity.execute({
        eventId: options.eventId ?? uuid(0x100000 + eventCounter),
        userId,
        teamIds: options.teams ?? [TEAM],
        activityType: options.type ?? 'walking',
        activityDate: options.date ?? '2026-11-20',
      }),
    );
  }

  /** `count` different people, each doing one activity of `type` on `date` in the team. */
  async function crowd(
    count: number,
    options: { type?: ActivityType; date?: string; from?: number; teams?: string[] } = {},
  ) {
    const first = options.from ?? 1;
    for (let n = first; n < first + count; n += 1) {
      await record(person(n), {
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(options.date === undefined ? {} : { date: options.date }),
        ...(options.teams === undefined ? {} : { teams: options.teams }),
      });
    }
  }

  return { app, clock, store, logLines, pseudonyms, record, crowd };
}

export type Harness = ReturnType<typeof buildHarness>;
