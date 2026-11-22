import type {
  ActivityType,
  ChallengeResponse,
  ChallengeStatus,
  LeaderboardResponse,
  ChallengeProgressResponse,
  CreateChallengeRequest,
} from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { ChallengeApi, IdentityApi } from '../api/index.js';
import { messageOf } from '../format.js';

/** What the list is narrowed by. The URL carries it, so a filtered view can be shared. */
export class ChallengeFilters {
  activityType = $state<ActivityType | 'all'>('all');
  status = $state<ChallengeStatus | 'all'>('all');
  from = $state('');
  to = $state('');

  /** Query parameters for the address bar. Defaults are left out. */
  params = $derived.by(() => {
    const params: Record<string, string> = {};
    if (this.activityType !== 'all') params['type'] = this.activityType;
    if (this.status !== 'all') params['status'] = this.status;
    if (this.from !== '') params['from'] = this.from;
    if (this.to !== '') params['to'] = this.to;
    return params;
  });

  /** Reads the filters back from an address (unknown values are ignored). */
  static fromParams(
    params: { get(name: string): string | null },
    valid: { types: readonly string[]; statuses: readonly string[] },
  ) {
    const filters = new ChallengeFilters();
    const type = params.get('type') ?? '';
    const status = params.get('status') ?? '';
    if (valid.types.includes(type)) filters.activityType = type as ActivityType;
    if (valid.statuses.includes(status)) filters.status = status as ChallengeStatus;
    filters.from = /^\d{4}-\d{2}-\d{2}$/.test(params.get('from') ?? '')
      ? (params.get('from') ?? '')
      : '';
    filters.to = /^\d{4}-\d{2}-\d{2}$/.test(params.get('to') ?? '') ? (params.get('to') ?? '') : '';
    return filters;
  }

  /** Does a challenge pass the filters? A date range keeps challenges that overlap it. */
  matches(challenge: ChallengeResponse): boolean {
    return (
      (this.activityType === 'all' || challenge.activityType === this.activityType) &&
      (this.status === 'all' || challenge.status === this.status) &&
      (this.from === '' || challenge.endsOn >= this.from) &&
      (this.to === '' || challenge.startsOn <= this.to)
    );
  }
}

/** The challenge list with its filters, and the actions available from it. */
export class ChallengesState {
  readonly list = new AsyncValue<ChallengeResponse[]>();
  filters = $state(new ChallengeFilters());
  notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

  visible = $derived(
    (this.list.value ?? []).filter((challenge) => this.filters.matches(challenge)),
  );

  constructor(private readonly api: ChallengeApi) {}

  async load(): Promise<void> {
    await this.list.load(async () => (await this.api.list({ limit: 100 })).items);
  }

  async join(challenge: ChallengeResponse): Promise<void> {
    await this.act(async () => {
      await this.api.join(challenge.id);
      await this.load();
      return `You joined ${challenge.name}.`;
    });
  }

  async create(request: CreateChallengeRequest): Promise<boolean> {
    return this.act(async () => {
      await this.api.create(request);
      await this.load();
      return 'Challenge created as a draft. Start it when you are ready.';
    });
  }

  private async act(work: () => Promise<string>): Promise<boolean> {
    this.notice = null;
    try {
      this.notice = { kind: 'ok', text: await work() };
      return true;
    } catch (error) {
      this.notice = { kind: 'error', text: messageOf(error) };
      return false;
    }
  }
}

export interface BoardRow {
  readonly id: string;
  readonly rank: number;
  readonly label: string;
  readonly value: number;
}

/** One challenge: its details, standings (with names), your progress, and manager actions. */
export class ChallengeDetail {
  readonly challenge = new AsyncValue<ChallengeResponse>();
  readonly board = new AsyncValue<LeaderboardResponse>();
  readonly progress = new AsyncValue<ChallengeProgressResponse>();
  names = $state<ReadonlyMap<string, string>>(new Map());
  notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

  rows = $derived<BoardRow[]>(
    (this.board.value?.entries ?? []).map((entry) => ({
      id: entry.userId,
      rank: entry.rank,
      label: this.names.get(entry.userId) ?? 'A teammate',
      value: entry.points,
    })),
  );

  constructor(
    private readonly challenges: ChallengeApi,
    private readonly identity: IdentityApi,
    private readonly id: string,
  ) {}

  async load(): Promise<void> {
    await this.challenge.load(() => this.challenges.get(this.id));
    const challenge = this.challenge.value;
    if (challenge === undefined) return;
    // Standings and progress are for participants (and managers): others get a 403 we simply skip.
    await Promise.all([
      this.board.load(() => this.challenges.leaderboard(this.id)),
      challenge.joined
        ? this.progress.load(() => this.challenges.progress(this.id))
        : Promise.resolve(),
      this.loadNames(challenge.teamId),
    ]);
  }

  /** Names come from the team roster (Identity), because Challenge only knows ids. */
  private async loadNames(teamId: string): Promise<void> {
    try {
      const members = await this.identity.teamMembers(teamId);
      this.names = new Map(members.items.map((m) => [m.id, m.displayName]));
    } catch {
      this.names = new Map();
    }
  }

  private async act(work: () => Promise<string>): Promise<void> {
    this.notice = null;
    try {
      this.notice = { kind: 'ok', text: await work() };
    } catch (error) {
      this.notice = { kind: 'error', text: messageOf(error) };
    }
  }

  join = () =>
    this.act(async () => (await this.challenges.join(this.id), await this.load(), 'You joined.'));
  start = () =>
    this.act(
      async () => (await this.challenges.start(this.id), await this.load(), 'Challenge started.'),
    );
  cancel = () =>
    this.act(
      async () => (
        await this.challenges.cancel(this.id),
        await this.load(),
        'Challenge cancelled.'
      ),
    );
}
