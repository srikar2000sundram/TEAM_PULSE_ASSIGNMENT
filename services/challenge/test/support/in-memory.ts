import type { TeamPulseEvent } from '@teampulse/contracts';
import type { Outbox } from '@teampulse/outbox';
import type {
  AwardedBadge,
  BadgeRepository,
  ChallengeListQuery,
  ChallengeRepository,
  ParticipationRepository,
  ProgressLedger,
  Transaction,
  UnitOfWork,
} from '../../src/application/ports.js';
import { Challenge, type Viewer } from '../../src/domain/challenge.js';
import { rankStandings, type RankedStanding } from '../../src/domain/progress.js';

interface ParticipationRow {
  challengeId: string;
  userId: string;
  teamId: string;
  joinedOn: string;
  points: number;
}

interface LedgerRow {
  challengeId: string;
  sourceEventId: string;
  userId: string;
  activityDate: string;
}

/**
 * In-memory adapters used by unit tests. They implement the same rules as the SQL, and the shared
 * repository contract suite runs against both this and PostgreSQL, so the two cannot drift.
 */
export class InMemoryStore {
  challenges = new Map<string, Challenge>();
  participations = new Map<string, ParticipationRow>();
  ledger = new Map<string, LedgerRow>();
  badges = new Map<string, AwardedBadge>();
  outbox: TeamPulseEvent[] = [];

  snapshot() {
    return {
      challenges: new Map(this.challenges),
      participations: new Map([...this.participations].map(([k, v]) => [k, { ...v }])),
      ledger: new Map(this.ledger),
      badges: new Map(this.badges),
      outbox: [...this.outbox],
    };
  }

  restore(snapshot: ReturnType<InMemoryStore['snapshot']>): void {
    this.challenges = snapshot.challenges;
    this.participations = snapshot.participations;
    this.ledger = snapshot.ledger;
    this.badges = snapshot.badges;
    this.outbox = snapshot.outbox;
  }
}

const pair = (a: string, b: string) => `${a}|${b}`;

class InMemoryChallenges implements ChallengeRepository {
  constructor(private readonly store: InMemoryStore) {}

  insert(challenge: Challenge) {
    this.store.challenges.set(challenge.id, challenge);
    return Promise.resolve();
  }

  findVisible(id: string, viewer: Viewer) {
    const challenge = this.store.challenges.get(id);
    return Promise.resolve(
      challenge !== undefined && challenge.canBeSeenBy(viewer) ? challenge : null,
    );
  }

  transition(challenge: Challenge, from: Challenge['status']) {
    const stored = this.store.challenges.get(challenge.id);
    if (stored === undefined || stored.status !== from) return Promise.resolve(false);
    this.store.challenges.set(challenge.id, challenge);
    return Promise.resolve(true);
  }

  list(query: ChallengeListQuery) {
    const rows = [...this.store.challenges.values()]
      .filter(
        (c) =>
          c.canBeSeenBy(query.viewer) && (query.status === undefined || c.status === query.status),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .filter((c) => {
        if (query.after === undefined) return true;
        const time = c.createdAt.getTime();
        const afterTime = query.after.createdAt.getTime();
        return time < afterTime || (time === afterTime && c.id < query.after.id);
      });
    return Promise.resolve(rows.slice(0, query.limit));
  }

  findScoring(userId: string, activityType: Challenge['activityType'], activityDate: string) {
    return Promise.resolve(
      [...this.store.challenges.values()].filter((c) => {
        const participation = this.store.participations.get(pair(c.id, userId));
        return (
          participation !== undefined &&
          participation.joinedOn <= activityDate &&
          c.activityType === activityType &&
          c.scoresOn(activityDate)
        );
      }),
    );
  }

  listDraftsDue(today: string) {
    return Promise.resolve(
      [...this.store.challenges.values()].filter(
        (c) => c.status === 'draft' && c.startsOn <= today && c.endsOn >= today,
      ),
    );
  }

  listActiveEndedBefore(cutoff: string) {
    return Promise.resolve(
      [...this.store.challenges.values()].filter((c) => c.status === 'active' && c.endsOn < cutoff),
    );
  }

  detachCreator(userId: string) {
    let changed = 0;
    for (const [id, challenge] of this.store.challenges) {
      if (challenge.createdByUserId !== userId) continue;
      this.store.challenges.set(id, Challenge.restore({ ...challenge, createdByUserId: null }));
      changed += 1;
    }
    return Promise.resolve(changed);
  }
}

class InMemoryParticipations implements ParticipationRepository {
  constructor(private readonly store: InMemoryStore) {}

  add(input: { challengeId: string; userId: string; teamId: string; joinedOn: string }) {
    const key = pair(input.challengeId, input.userId);
    if (this.store.participations.has(key)) return Promise.resolve(false);
    this.store.participations.set(key, { ...input, points: 0 });
    return Promise.resolve(true);
  }

  find(challengeId: string, userId: string) {
    const row = this.store.participations.get(pair(challengeId, userId));
    return Promise.resolve(
      row === undefined
        ? null
        : {
            challengeId: row.challengeId,
            userId: row.userId,
            joinedOn: row.joinedOn,
            points: row.points,
          },
    );
  }

  countFor(challengeIds: readonly string[]) {
    const counts = new Map<string, number>();
    for (const row of this.store.participations.values()) {
      if (challengeIds.includes(row.challengeId)) {
        counts.set(row.challengeId, (counts.get(row.challengeId) ?? 0) + 1);
      }
    }
    return Promise.resolve(counts);
  }

  joinedAmong(userId: string, challengeIds: readonly string[]) {
    return Promise.resolve(
      new Set(
        [...this.store.participations.values()]
          .filter((row) => row.userId === userId && challengeIds.includes(row.challengeId))
          .map((row) => row.challengeId),
      ),
    );
  }

  addPoint(challengeId: string, userId: string) {
    const row = this.store.participations.get(pair(challengeId, userId));
    if (row !== undefined) row.points += 1;
    return Promise.resolve();
  }

  private ranked(challengeId: string): RankedStanding[] {
    return rankStandings(
      [...this.store.participations.values()]
        .filter((row) => row.challengeId === challengeId)
        .map((row) => ({ userId: row.userId, points: row.points })),
    );
  }

  leaderboard(challengeId: string, limit: number) {
    return Promise.resolve(this.ranked(challengeId).slice(0, limit));
  }

  rankOf(challengeId: string, userId: string) {
    return Promise.resolve(this.ranked(challengeId).find((s) => s.userId === userId) ?? null);
  }

  withdrawFromTeam(userId: string, teamId: string) {
    const left: string[] = [];
    for (const [key, row] of [...this.store.participations]) {
      const challenge = this.store.challenges.get(row.challengeId);
      if (
        row.userId === userId &&
        challenge?.teamId === teamId &&
        (challenge.status === 'draft' || challenge.status === 'active')
      ) {
        this.store.participations.delete(key);
        left.push(row.challengeId);
      }
    }
    return Promise.resolve(left);
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const [key, row] of [...this.store.participations]) {
      if (row.userId === userId) {
        this.store.participations.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryLedger implements ProgressLedger {
  constructor(private readonly store: InMemoryStore) {}

  record(entry: LedgerRow) {
    const key = pair(entry.challengeId, entry.sourceEventId);
    if (this.store.ledger.has(key)) return Promise.resolve(false);
    this.store.ledger.set(key, entry);
    return Promise.resolve(true);
  }

  dates(challengeId: string, userId: string) {
    return Promise.resolve(
      [...this.store.ledger.values()]
        .filter((row) => row.challengeId === challengeId && row.userId === userId)
        .map((row) => row.activityDate)
        .sort(),
    );
  }

  deleteForUserIn(userId: string, challengeIds: readonly string[]) {
    return this.deleteWhere(
      (row) => row.userId === userId && challengeIds.includes(row.challengeId),
    );
  }

  deleteAllForUser(userId: string) {
    return this.deleteWhere((row) => row.userId === userId);
  }

  private deleteWhere(predicate: (row: LedgerRow) => boolean) {
    let removed = 0;
    for (const [key, row] of [...this.store.ledger]) {
      if (predicate(row)) {
        this.store.ledger.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryBadges implements BadgeRepository {
  constructor(private readonly store: InMemoryStore) {}

  award(badge: AwardedBadge) {
    const key = `${badge.challengeId}|${badge.userId}|${badge.badgeRuleId}`;
    if (this.store.badges.has(key)) return Promise.resolve(false);
    this.store.badges.set(key, badge);
    return Promise.resolve(true);
  }

  listFor(challengeId: string, userId: string) {
    return Promise.resolve(
      [...this.store.badges.values()].filter(
        (badge) => badge.challengeId === challengeId && badge.userId === userId,
      ),
    );
  }

  deleteAllForUser(userId: string) {
    let removed = 0;
    for (const [key, badge] of [...this.store.badges]) {
      if (badge.userId === userId) {
        this.store.badges.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryOutbox implements Outbox {
  constructor(private readonly store: InMemoryStore) {}
  append(event: TeamPulseEvent) {
    this.store.outbox.push(event);
    return Promise.resolve();
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store: InMemoryStore = new InMemoryStore()) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    const tx: Transaction = {
      challenges: new InMemoryChallenges(this.store),
      participations: new InMemoryParticipations(this.store),
      progress: new InMemoryLedger(this.store),
      badges: new InMemoryBadges(this.store),
      outbox: new InMemoryOutbox(this.store),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.store.restore(before); // roll back only when the work throws
      throw error;
    }
  }
}
