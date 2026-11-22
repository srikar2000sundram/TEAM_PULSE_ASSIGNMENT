import { describe, expect, it } from 'vitest';
import { unwrap, type Result } from '@teampulse/kernel';
import { Challenge, type BadgeRule, type Viewer } from '../../src/domain/challenge.js';
import { addDays, dateOf, daysInclusive } from '../../src/domain/dates.js';
import { rankStandings, satisfiedRules, statsOf } from '../../src/domain/progress.js';
import { ALICE, MANAGER, OTHER_TEAM, TEAM, uuid } from '../support/harness.js';

const NOW = new Date('2026-11-20T08:00:00Z');
const errorCode = (result: Result<unknown>) => (result.ok ? undefined : result.error.code);

const make = (overrides: Partial<Parameters<typeof Challenge.create>[0]> = {}) =>
  Challenge.create({
    id: uuid(1),
    name: 'Walk the world',
    activityType: 'walking',
    teamId: TEAM,
    startsOn: '2026-11-20',
    endsOn: '2026-11-30',
    badgeRules: [],
    createdByUserId: MANAGER,
    now: NOW,
    ...overrides,
  });

const viewer = (
  userId: string,
  options: Partial<Pick<Viewer, 'role' | 'teamIds' | 'managedTeamIds'>> = {},
): Viewer => ({ userId, role: 'employee', teamIds: [], managedTeamIds: [], ...options });

describe('dates', () => {
  it('adds days across month and year ends and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-20', -20)).toBe('2026-10-31');
  });

  it('counts days inclusively and takes the UTC date of an instant', () => {
    expect(daysInclusive('2026-11-20', '2026-11-20')).toBe(1);
    expect(daysInclusive('2026-11-20', '2026-11-30')).toBe(11);
    expect(dateOf(new Date('2026-11-20T23:59:59Z'))).toBe('2026-11-20');
  });
});

describe('Challenge.create', () => {
  it('makes a draft', () => {
    const challenge = unwrap(make());
    expect(challenge).toMatchObject({ status: 'draft', completedOn: null, name: 'Walk the world' });
  });

  it('trims the name and rejects an empty or too long one', () => {
    expect(unwrap(make({ name: '  Steps  ' })).name).toBe('Steps');
    expect(errorCode(make({ name: '   ' }))).toBe('challenge.name_invalid');
    expect(errorCode(make({ name: 'x'.repeat(81) }))).toBe('challenge.name_invalid');
  });

  it('rejects reversed dates, a challenge over a year long, and one already over', () => {
    expect(errorCode(make({ startsOn: '2026-12-01', endsOn: '2026-11-30' }))).toBe(
      'challenge.dates_invalid',
    );
    expect(errorCode(make({ startsOn: '2026-01-01', endsOn: '2027-06-01' }))).toBe(
      'challenge.too_long',
    );
    expect(errorCode(make({ startsOn: '2026-10-01', endsOn: '2026-11-19' }))).toBe(
      'challenge.in_the_past',
    );
    // The last day may be today.
    expect(make({ startsOn: '2026-11-01', endsOn: '2026-11-20' }).ok).toBe(true);
  });

  it('rejects repeated, out-of-range and too many badge rules', () => {
    const rule = (kind: BadgeRule['kind'], threshold: number, n = 1): BadgeRule => ({
      id: uuid(100 + n),
      kind,
      threshold,
    });
    expect(errorCode(make({ badgeRules: [rule('streak', 3, 1), rule('streak', 3, 2)] }))).toBe(
      'challenge.badges_repeat',
    );
    expect(errorCode(make({ badgeRules: [rule('total', 0)] }))).toBe(
      'challenge.badge_threshold_invalid',
    );
    expect(errorCode(make({ badgeRules: [rule('total', 1001)] }))).toBe(
      'challenge.badge_threshold_invalid',
    );
    expect(errorCode(make({ badgeRules: [rule('total', 1.5)] }))).toBe(
      'challenge.badge_threshold_invalid',
    );
    expect(
      errorCode(
        make({ badgeRules: Array.from({ length: 11 }, (_, i) => rule('total', i + 1, i)) }),
      ),
    ).toBe('challenge.too_many_badges');
    // The same threshold for different kinds is fine.
    expect(make({ badgeRules: [rule('streak', 3, 1), rule('total', 3, 2)] }).ok).toBe(true);
  });
});

describe('lifecycle', () => {
  const draft = () => unwrap(make());

  it('draft -> active -> completed, and the completion date is the last day', () => {
    const active = unwrap(draft().start(NOW));
    expect(active.status).toBe('active');
    const done = unwrap(active.complete(new Date('2026-12-02T00:00:00Z')));
    expect(done).toMatchObject({ status: 'completed', completedOn: '2026-11-30' });
  });

  it('can be started before its start date (a manual start)', () => {
    const future = unwrap(make({ startsOn: '2026-12-01', endsOn: '2026-12-31' }));
    expect(future.start(NOW).ok).toBe(true);
  });

  it('cannot be started once its last day has passed', () => {
    const old = unwrap(make({ startsOn: '2026-11-01', endsOn: '2026-11-20' }));
    expect(errorCode(old.start(new Date('2026-11-21T00:00:00Z')))).toBe('challenge.in_the_past');
  });

  it.each([
    ['a draft cannot be completed', () => draft().complete(NOW)],
    ['an active challenge cannot be started again', () => unwrap(draft().start(NOW)).start(NOW)],
    [
      'a completed challenge cannot be cancelled',
      () => unwrap(unwrap(draft().start(NOW)).complete(NOW)).cancel(NOW),
    ],
    ['a cancelled challenge cannot be started', () => unwrap(draft().cancel(NOW)).start(NOW)],
    [
      'a cancelled challenge cannot be cancelled again',
      () => unwrap(draft().cancel(NOW)).cancel(NOW),
    ],
    ['a cancelled challenge cannot be completed', () => unwrap(draft().cancel(NOW)).complete(NOW)],
  ])('%s', (_name, attempt) => {
    expect(errorCode(attempt())).toBe('challenge.invalid_state');
  });

  it('a draft and an active challenge can be cancelled', () => {
    expect(unwrap(draft().cancel(NOW)).status).toBe('cancelled');
    expect(unwrap(unwrap(draft().start(NOW)).cancel(NOW)).status).toBe('cancelled');
  });

  it('never changes the object it was called on', () => {
    const original = draft();
    original.start(NOW);
    expect(original.status).toBe('draft');
  });
});

describe('joining and scoring windows', () => {
  const active = unwrap(unwrap(make()).start(NOW));

  it('is joinable while active and up to its last day', () => {
    expect(active.canJoinOn('2026-11-20')).toBe(true);
    expect(active.canJoinOn('2026-11-30')).toBe(true);
    expect(active.canJoinOn('2026-12-01')).toBe(false);
    expect(unwrap(make()).canJoinOn('2026-11-20')).toBe(false); // a draft
  });

  it('scores only an active challenge and only on its days', () => {
    expect(active.scoresOn('2026-11-19')).toBe(false);
    expect(active.scoresOn('2026-11-20')).toBe(true);
    expect(active.scoresOn('2026-11-30')).toBe(true);
    expect(active.scoresOn('2026-12-01')).toBe(false);
    expect(unwrap(make()).scoresOn('2026-11-25')).toBe(false);
    expect(unwrap(active.cancel(NOW)).scoresOn('2026-11-25')).toBe(false);
  });
});

describe('who may see and manage a challenge', () => {
  const draft = unwrap(make());
  const active = unwrap(draft.start(NOW));
  const people = {
    creator: viewer(MANAGER),
    teamManager: viewer(uuid(0xe5), { role: 'manager', managedTeamIds: [TEAM], teamIds: [TEAM] }),
    otherManager: viewer(uuid(0xe6), {
      role: 'manager',
      managedTeamIds: [OTHER_TEAM],
      teamIds: [OTHER_TEAM],
    }),
    teamMember: viewer(ALICE, { teamIds: [TEAM] }),
    outsider: viewer(uuid(0xff), { teamIds: [OTHER_TEAM] }),
    admin: viewer(uuid(0xad), { role: 'admin' }),
  };

  it('shows a draft only to those who manage it, its creator and administrators', () => {
    expect(
      Object.fromEntries(Object.entries(people).map(([k, v]) => [k, draft.canBeSeenBy(v)])),
    ).toEqual({
      creator: true,
      teamManager: true,
      otherManager: false,
      teamMember: false,
      outsider: false,
      admin: true,
    });
  });

  it('shows an active challenge to the team as well, never to other teams', () => {
    expect(
      Object.fromEntries(Object.entries(people).map(([k, v]) => [k, active.canBeSeenBy(v)])),
    ).toEqual({
      creator: true,
      teamManager: true,
      otherManager: false,
      teamMember: true,
      outsider: false,
      admin: true,
    });
  });

  it('lets only managers of the team and administrators manage it', () => {
    expect(
      Object.fromEntries(Object.entries(people).map(([k, v]) => [k, active.canBeManagedBy(v)])),
    ).toEqual({
      creator: false, // a creator who no longer manages the team has no say
      teamManager: true,
      otherManager: false,
      teamMember: false,
      outsider: false,
      admin: true,
    });
  });
});

describe('statsOf', () => {
  it('counts points, different days and the longest run of consecutive days', () => {
    expect(statsOf([])).toEqual({ points: 0, activeDays: 0, longestStreak: 0 });
    expect(statsOf(['2026-11-20'])).toEqual({ points: 1, activeDays: 1, longestStreak: 1 });
    expect(
      statsOf(['2026-11-20', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']),
    ).toEqual({ points: 6, activeDays: 5, longestStreak: 3 });
  });

  it('does not depend on the order the dates arrive in', () => {
    const dates = ['2026-11-25', '2026-11-20', '2026-11-24', '2026-11-21', '2026-11-23'];
    expect(statsOf(dates)).toEqual(statsOf([...dates].reverse()));
    expect(statsOf(dates).longestStreak).toBe(3);
  });

  it('runs across month ends', () => {
    expect(statsOf(['2026-11-29', '2026-11-30', '2026-12-01']).longestStreak).toBe(3);
  });
});

describe('satisfiedRules', () => {
  const rules: BadgeRule[] = [
    { id: uuid(1), kind: 'streak', threshold: 3 },
    { id: uuid(2), kind: 'total', threshold: 5 },
    { id: uuid(3), kind: 'milestone', threshold: 2 },
  ];

  it('checks each kind against its own statistic', () => {
    expect(
      satisfiedRules(rules, { points: 5, activeDays: 1, longestStreak: 1 }).map((r) => r.kind),
    ).toEqual(['total']);
    expect(
      satisfiedRules(rules, { points: 2, activeDays: 2, longestStreak: 2 }).map((r) => r.kind),
    ).toEqual(['milestone']);
    expect(
      satisfiedRules(rules, { points: 3, activeDays: 3, longestStreak: 3 }).map((r) => r.kind),
    ).toEqual(['streak', 'milestone']);
    expect(satisfiedRules(rules, { points: 0, activeDays: 0, longestStreak: 0 })).toEqual([]);
  });

  it('is satisfied at exactly the threshold and beyond', () => {
    const [streak] = rules;
    expect(satisfiedRules([streak!], { points: 3, activeDays: 3, longestStreak: 2 })).toEqual([]);
    expect(satisfiedRules([streak!], { points: 3, activeDays: 3, longestStreak: 3 })).toHaveLength(
      1,
    );
    expect(satisfiedRules([streak!], { points: 9, activeDays: 9, longestStreak: 9 })).toHaveLength(
      1,
    );
  });
});

describe('rankStandings', () => {
  it('gives equal points a shared rank and skips the next one (1, 2, 2, 4)', () => {
    const ranked = rankStandings([
      { userId: 'd', points: 1 },
      { userId: 'b', points: 5 },
      { userId: 'c', points: 5 },
      { userId: 'a', points: 9 },
    ]);
    expect(ranked.map((s) => [s.userId, s.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 2],
      ['d', 4],
    ]);
  });

  it('is stable for ties and handles nobody and everybody tied', () => {
    expect(rankStandings([])).toEqual([]);
    expect(
      rankStandings([
        { userId: 'z', points: 0 },
        { userId: 'a', points: 0 },
      ]).map((s) => [s.userId, s.rank]),
    ).toEqual([
      ['a', 1],
      ['z', 1],
    ]);
  });
});
