import type { Principal } from '@teampulse/auth';
import type { ActivityType, BadgeKind, Role } from '@teampulse/contracts';
import { FixedClock, SequentialIdGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createUseCases } from '../../src/application/index.js';
import { InMemoryUnitOfWork } from './in-memory.js';

/** Friday 2026-11-20, 08:00 UTC. */
export const START = '2026-11-20T08:00:00Z';
export const TODAY = '2026-11-20';

/** Deterministic ids for people and teams, readable in assertions. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ALICE = uuid(0xa1);
export const BOB = uuid(0xb1);
export const CAROL = uuid(0xc1);
export const MANAGER = uuid(0xe1);
export const OTHER_MANAGER = uuid(0xe2);
export const ADMIN = uuid(0xad);
export const TEAM = uuid(0x71);
export const OTHER_TEAM = uuid(0x72);
export const person = (n: number): string => uuid(0xa000 + n);

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

/** A member of TEAM. */
export const member = (userId: string) => principal(userId, { teams: [TEAM] });
export const manager = principal(MANAGER, { role: 'manager', teams: [TEAM], manages: [TEAM] });
export const otherManager = principal(OTHER_MANAGER, {
  role: 'manager',
  teams: [OTHER_TEAM],
  manages: [OTHER_TEAM],
});
export const admin = principal(ADMIN, { role: 'admin' });

export interface NewChallenge {
  name?: string;
  activityType?: ActivityType;
  teamId?: string;
  startsOn?: string;
  endsOn?: string;
  badgeRules?: { kind: BadgeKind; threshold: number }[];
}

/** The whole application wired to in-memory adapters. No I/O, so tests run in milliseconds. */
export function buildHarness(options: { graceDays?: number } = {}) {
  const clock = new FixedClock(START);
  const ids = new SequentialIdGenerator();
  const uow = new InMemoryUnitOfWork();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'challenge-test',
    level: 'debug',
    write: (line) => logLines.push(line),
    now: () => clock.now(),
  });
  const app = createUseCases({ uow, clock, ids, logger, graceDays: options.graceDays ?? 1 });

  /** Creates a draft for TEAM (walking, this week by default) as the team's manager. */
  async function create(overrides: NewChallenge = {}, actor: Principal = manager) {
    return unwrap(
      await app.createChallenge.execute({
        actor,
        name: overrides.name ?? 'Walk the world',
        activityType: overrides.activityType ?? 'walking',
        teamId: overrides.teamId ?? TEAM,
        startsOn: overrides.startsOn ?? '2026-11-20',
        endsOn: overrides.endsOn ?? '2026-11-30',
        badgeRules: overrides.badgeRules ?? [],
      }),
    );
  }

  /** A started challenge. */
  async function createActive(overrides: NewChallenge = {}) {
    const { challenge } = await create(overrides);
    unwrap(await app.startChallenge.execute({ actor: manager, challengeId: challenge.id }));
    return challenge;
  }

  const join = async (challengeId: string, userId: string) =>
    unwrap(await app.joinChallenge.execute({ actor: member(userId), challengeId }));

  /** Scores an activity as an `ActivityCompleted` event would. */
  async function score(
    userId: string,
    options: { eventId: string; type?: ActivityType; date?: string },
  ) {
    return unwrap(
      await app.recordProgress.execute({
        sourceEventId: options.eventId,
        userId,
        activityType: options.type ?? 'walking',
        activityDate: options.date ?? TODAY,
      }),
    );
  }

  const events = () => uow.store.outbox;
  const eventsOf = (type: string) => events().filter((event) => event.eventType === type);

  return { app, clock, uow, logLines, create, createActive, join, score, events, eventsOf };
}

export type Harness = ReturnType<typeof buildHarness>;
