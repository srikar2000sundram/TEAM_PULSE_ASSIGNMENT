import type {
  ChallengeResponse,
  HabitResponse,
  LeaderboardResponse,
  TeamActivityReport,
} from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http.js';
import type { ActivityApi, ChallengeApi, HabitApi, IdentityApi, InsightApi } from '../api/index.js';
import { AsyncValue } from '../async.svelte.js';
import { TeamAnalytics } from './analytics.svelte.js';
import { ChallengeDetail, ChallengeFilters, ChallengesState } from './challenges.svelte.js';
import { HabitsState } from './habits.svelte.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-11-20T08:00:00.000Z';

const habit = (n: number, title = `Habit ${n}`): HabitResponse => ({
  id: id(n),
  ownerUserId: id(0xa1),
  isOwner: true,
  title,
  activityType: 'walking',
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
});

const challenge = (n: number, overrides: Partial<ChallengeResponse> = {}): ChallengeResponse => ({
  id: id(n),
  name: `Challenge ${n}`,
  activityType: 'walking',
  teamId: id(0x71),
  startsOn: '2026-11-20',
  endsOn: '2026-11-30',
  status: 'active',
  badgeRules: [],
  participantCount: 0,
  joined: false,
  createdAt: NOW,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe('AsyncValue', () => {
  it('tracks loading, the value and an error', async () => {
    const value = new AsyncValue<number>();
    const pending = deferred<number>();
    const loading = value.load(() => pending.promise);
    expect(value.loading).toBe(true);
    pending.resolve(5);
    await loading;
    expect(value).toMatchObject({ value: 5, loading: false, error: null });

    await value.load(() => Promise.reject(new ApiError(503, 'x', 'Try again later')));
    expect(value).toMatchObject({ error: 'Try again later', loading: false, value: 5 });
  });

  it('latest wins: a slow early answer cannot overwrite a newer one', async () => {
    const value = new AsyncValue<string>();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const first = value.load(() => slow.promise);
    const second = value.load(() => fast.promise);
    fast.resolve('new');
    await second;
    slow.resolve('old');
    await first;
    expect(value.value).toBe('new');
    expect(value.loading).toBe(false);
  });

  it('latest wins for errors too, and hides internals of unexpected errors', async () => {
    const value = new AsyncValue<string>();
    const slow = deferred<string>();
    const first = value.load(() => slow.promise);
    await value.load(() => Promise.resolve('ok'));
    slow.reject(new ApiError(500, 'x', 'late failure'));
    await first;
    expect(value).toMatchObject({ value: 'ok', error: null });

    await value.load(() => Promise.reject(new TypeError('Cannot read properties of undefined')));
    expect(value.error).toBe('Something went wrong. Please try again.');
  });
});

describe('HabitsState', () => {
  function setup(overrides: { record?: ActivityApi['record'] } = {}) {
    const habits = [habit(1), habit(2)];
    const calls: string[] = [];
    const habitApi: HabitApi = {
      list: () => Promise.resolve({ items: habits }),
      create: (request) => {
        calls.push(`create:${request.title}:${request.visibility}`);
        habits.push(habit(3, request.title));
        return Promise.resolve(habit(3, request.title));
      },
      archive: (habitId) => {
        calls.push(`archive:${habitId}`);
        habits.splice(0, 1);
        return Promise.resolve(habit(1));
      },
      update: () => Promise.resolve(habit(1)),
    };
    const activityApi: ActivityApi = {
      record:
        overrides.record ??
        ((habitId, date) => {
          calls.push(`record:${habitId}:${date}`);
          return Promise.resolve({
            id: id(99),
            habitId,
            activityType: 'walking',
            activityDate: date,
            createdAt: NOW,
            alreadyRecorded: false,
          });
        }),
    };
    return { state: new HabitsState(habitApi, activityApi, () => '2026-11-20'), calls };
  }

  it('loads active habits', async () => {
    const { state } = setup();
    await state.load();
    expect(state.habits.value?.map((h) => h.title)).toEqual(['Habit 1', 'Habit 2']);
  });

  it('marks a habit done for today and remembers it', async () => {
    const { state, calls } = setup();
    await state.load();
    await state.markDone(state.habits.value![0]!);
    expect(calls).toEqual([`record:${id(1)}:2026-11-20`]);
    expect(state.done.has(id(1))).toBe(true);
    expect(state.notice).toEqual({ kind: 'ok', text: 'Nice work! Recorded for today.' });
    expect(state.busy).toBe(false);
  });

  it('says so when it was already recorded', async () => {
    const { state } = setup({
      record: (habitId, date) =>
        Promise.resolve({
          id: id(9),
          habitId,
          activityType: 'walking',
          activityDate: date,
          createdAt: NOW,
          alreadyRecorded: true,
        }),
    });
    await state.load();
    await state.markDone(state.habits.value![0]!);
    expect(state.notice?.text).toBe('Already recorded for today.');
  });

  it('shows a friendly error and does not mark it done when recording fails', async () => {
    const { state } = setup({
      record: () => Promise.reject(new ApiError(409, 'habit.archived', 'This habit is archived')),
    });
    await state.load();
    await state.markDone(state.habits.value![0]!);
    expect(state.notice).toEqual({ kind: 'error', text: 'This habit is archived' });
    expect(state.done.size).toBe(0);
    expect(state.busy).toBe(false);
  });

  it('creates private habits and reloads the list; archiving reloads too', async () => {
    const { state, calls } = setup();
    await state.load();
    await state.create({ title: 'Stretch', activityType: 'yoga' });
    expect(calls).toContain('create:Stretch:private');
    expect(state.habits.value).toHaveLength(3);
    await state.archive(state.habits.value![0]!);
    expect(state.habits.value).toHaveLength(2);
    expect(state.notice?.text).toBe('Habit archived.');
  });
});

describe('ChallengeFilters', () => {
  const valid = { types: ['walking', 'yoga'], statuses: ['draft', 'active'] };

  it('keeps defaults out of the address and writes only what is set', () => {
    const filters = new ChallengeFilters();
    expect(filters.params).toEqual({});
    filters.activityType = 'yoga';
    filters.from = '2026-11-01';
    expect(filters.params).toEqual({ type: 'yoga', from: '2026-11-01' });
  });

  it('reads the address back and ignores anything unknown or malformed', () => {
    const filters = ChallengeFilters.fromParams(
      new URLSearchParams('type=yoga&status=bogus&from=2026-11-01&to=not-a-date'),
      valid,
    );
    expect(filters.activityType).toBe('yoga');
    expect(filters.status).toBe('all');
    expect(filters.from).toBe('2026-11-01');
    expect(filters.to).toBe('');
    expect(
      ChallengeFilters.fromParams(new URLSearchParams('type=<script>'), valid).activityType,
    ).toBe('all');
  });

  it('keeps challenges that match the type and status and overlap the dates', () => {
    const filters = new ChallengeFilters();
    filters.activityType = 'walking';
    filters.status = 'active';
    filters.from = '2026-11-25';
    filters.to = '2026-12-05';
    expect(filters.matches(challenge(1))).toBe(true);
    expect(filters.matches(challenge(2, { activityType: 'yoga' }))).toBe(false);
    expect(filters.matches(challenge(3, { status: 'draft' }))).toBe(false);
    expect(filters.matches(challenge(4, { endsOn: '2026-11-24' }))).toBe(false);
    expect(filters.matches(challenge(5, { startsOn: '2026-12-06', endsOn: '2026-12-10' }))).toBe(
      false,
    );
    expect(filters.matches(challenge(6, { startsOn: '2026-12-05', endsOn: '2026-12-10' }))).toBe(
      true,
    );
  });
});

describe('ChallengesState', () => {
  function setup(joinError?: ApiError) {
    const items = [challenge(1), challenge(2, { activityType: 'yoga' })];
    const calls: string[] = [];
    const api = {
      list: () => Promise.resolve({ items }),
      join: (challengeId: string) => {
        calls.push(`join:${challengeId}`);
        if (joinError) return Promise.reject(joinError);
        items[0] = challenge(1, { joined: true, participantCount: 1 });
        return Promise.resolve(items[0]);
      },
      create: (request: { name: string }) => {
        calls.push(`create:${request.name}`);
        return Promise.resolve(challenge(3));
      },
    } as unknown as ChallengeApi;
    return { state: new ChallengesState(api), calls };
  }

  it('shows what the filters allow, and updates when they change', async () => {
    const { state } = setup();
    await state.load();
    expect(state.visible).toHaveLength(2);
    state.filters.activityType = 'yoga';
    expect(state.visible.map((c) => c.id)).toEqual([id(2)]);
  });

  it('joins and reloads so the card shows the new state', async () => {
    const { state, calls } = setup();
    await state.load();
    await state.join(state.list.value![0]!);
    expect(calls).toEqual([`join:${id(1)}`]);
    expect(state.list.value![0]).toMatchObject({ joined: true, participantCount: 1 });
    expect(state.notice).toEqual({ kind: 'ok', text: 'You joined Challenge 1.' });
  });

  it('reports a failed join in words', async () => {
    const { state } = setup(
      new ApiError(409, 'challenge.not_joinable', 'This challenge is not open for joining'),
    );
    await state.load();
    await state.join(state.list.value![0]!);
    expect(state.notice).toEqual({ kind: 'error', text: 'This challenge is not open for joining' });
  });

  it('create reports success or failure as a boolean', async () => {
    const { state } = setup();
    expect(
      await state.create({
        name: 'New',
        activityType: 'walking',
        teamId: id(0x71),
        startsOn: '2026-11-20',
        endsOn: '2026-11-30',
        badgeRules: [],
      }),
    ).toBe(true);
  });
});

describe('ChallengeDetail', () => {
  const board = (): LeaderboardResponse => ({
    challengeId: id(1),
    status: 'active',
    participantCount: 2,
    entries: [
      { rank: 1, userId: id(0xa1), points: 5, isYou: false },
      { rank: 2, userId: id(0xb1), points: 3, isYou: true },
    ],
    you: { rank: 2, points: 3 },
  });

  function setup(options: { joined?: boolean; boardError?: ApiError; rosterError?: boolean } = {}) {
    const calls: string[] = [];
    const challenges = {
      get: () => Promise.resolve(challenge(1, { joined: options.joined ?? true })),
      leaderboard: () =>
        options.boardError ? Promise.reject(options.boardError) : Promise.resolve(board()),
      progress: () => {
        calls.push('progress');
        return Promise.resolve({
          challengeId: id(1),
          points: 3,
          activeDays: 2,
          longestStreak: 2,
          badges: [],
        });
      },
      start: () => (calls.push('start'), Promise.resolve(challenge(1))),
    } as unknown as ChallengeApi;
    const identity = {
      teamMembers: () =>
        options.rosterError
          ? Promise.reject(new ApiError(403, 'x', 'no'))
          : Promise.resolve({ items: [{ id: id(0xa1), displayName: 'Ada' }] }),
    } as unknown as IdentityApi;
    return { detail: new ChallengeDetail(challenges, identity, id(1)), calls };
  }

  it('puts names on the standings from the team roster and calls the rest "A teammate"', async () => {
    const { detail } = setup();
    await detail.load();
    expect(detail.rows).toEqual([
      { id: id(0xa1), rank: 1, label: 'Ada', value: 5 },
      { id: id(0xb1), rank: 2, label: 'A teammate', value: 3 },
    ]);
  });

  it('loads your progress only if you take part', async () => {
    const taking = setup({ joined: true });
    await taking.detail.load();
    expect(taking.calls).toContain('progress');
    const watching = setup({ joined: false });
    await watching.detail.load();
    expect(watching.calls).not.toContain('progress');
  });

  it('keeps working when the standings are refused or the roster is unavailable', async () => {
    const { detail } = setup({
      boardError: new ApiError(403, 'challenge.not_participant', 'Not taking part'),
      rosterError: true,
    });
    await detail.load();
    expect(detail.challenge.value?.name).toBe('Challenge 1');
    expect(detail.board.error).toBe('Not taking part');
    expect(detail.rows).toEqual([]);
    expect(detail.names.size).toBe(0);
  });

  it('manager actions reload the page data', async () => {
    const { detail, calls } = setup();
    await detail.load();
    await detail.start();
    expect(calls).toContain('start');
    expect(detail.notice).toEqual({ kind: 'ok', text: 'Challenge started.' });
  });
});

describe('TeamAnalytics', () => {
  const report = (): TeamActivityReport => ({
    scope: 'team',
    teamId: id(0x71),
    from: '2026-11-18',
    to: '2026-11-20',
    minCohortSize: 5,
    total: { suppressed: false, completions: 30, participants: 8 },
    byActivityType: { walking: { suppressed: false, completions: 30, participants: 8 } },
    byDay: [
      { date: '2026-11-18', cell: { suppressed: false, completions: 12, participants: 6 } },
      { date: '2026-11-19', cell: { suppressed: true, reason: 'cohort_too_small' } },
      { date: '2026-11-20', cell: { suppressed: false, completions: 18, participants: 7 } },
    ],
  });

  it('charts only the days that may be shown, never a hidden day as zero, and counts the hidden ones', async () => {
    const calls: unknown[] = [];
    const api = {
      team: (teamId: string, period: unknown) => (
        calls.push([teamId, period]),
        Promise.resolve(report())
      ),
    } as unknown as InsightApi;
    const team = new TeamAnalytics(api);
    team.teamId = id(0x71);
    team.from = '2026-11-18';
    team.to = '2026-11-20';
    await team.load();
    expect(calls).toEqual([[id(0x71), { from: '2026-11-18', to: '2026-11-20' }]]);
    expect(team.series).toEqual([
      { date: '2026-11-18', value: 12 },
      { date: '2026-11-20', value: 18 },
    ]);
    expect(team.hiddenDays).toBe(1);
    expect(team.totalHidden).toBe(false);
  });

  it('knows when the whole total is hidden, and uses the organisation endpoint for administrators', async () => {
    const hidden = {
      ...report(),
      total: { suppressed: true, reason: 'cohort_too_small' },
      byDay: [],
    } as TeamActivityReport;
    const calls: string[] = [];
    const api = {
      organization: () => (calls.push('organization'), Promise.resolve(hidden)),
    } as unknown as InsightApi;
    const org = new TeamAnalytics(api, 'organization');
    await org.load();
    expect(calls).toEqual(['organization']);
    expect(org.totalHidden).toBe(true);
    expect(org.series).toEqual([]);
  });
});
