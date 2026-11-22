import type { ActivityType, BadgeKind, ChallengeStatus } from '@teampulse/contracts';
import type { Database, Queryable } from '@teampulse/db';
import { PostgresOutbox } from '@teampulse/outbox';
import type {
  AwardedBadge,
  BadgeRepository,
  ChallengeListQuery,
  ChallengeRepository,
  Participation,
  ParticipationRepository,
  ProgressLedger,
  Transaction,
  UnitOfWork,
} from '../../application/ports.js';
import { Challenge, type BadgeRule, type Viewer } from '../../domain/challenge.js';
import type { RankedStanding } from '../../domain/progress.js';

/* Row shapes returned by the driver, and the mapping into domain objects. */

interface ChallengeRow {
  id: string;
  name: string;
  activity_type: ActivityType;
  team_id: string;
  /** Selected as text (`to_char`): the driver would otherwise turn a date into a local-time Date. */
  starts_on: string;
  ends_on: string;
  status: ChallengeStatus;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_on: string | null;
}

interface RuleRow {
  id: string;
  challenge_id: string;
  kind: BadgeKind;
  threshold: number;
}

const CHALLENGE_COLUMNS = `id, name, activity_type, team_id,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
  status, created_by_user_id, created_at, updated_at,
  to_char(completed_on, 'YYYY-MM-DD') AS completed_on`;

/** The same, with every column qualified, for queries that join other tables. */
const QUALIFIED_CHALLENGE_COLUMNS = `c.id, c.name, c.activity_type, c.team_id,
  to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
  c.status, c.created_by_user_id, c.created_at, c.updated_at,
  to_char(c.completed_on, 'YYYY-MM-DD') AS completed_on`;

const toChallenge = (row: ChallengeRow, rules: readonly BadgeRule[]): Challenge =>
  Challenge.restore({
    id: row.id,
    name: row.name,
    activityType: row.activity_type,
    teamId: row.team_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    badgeRules: rules,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedOn: row.completed_on,
  });

/**
 * The rule of `Challenge.canBeSeenBy`, as SQL: administrators; managers of the challenge's team and
 * its creator; and, once it has started, members of its team.
 */
const visibleTo = (
  userParam: number,
  teamsParam: number,
  managedParam: number,
  adminParam: number,
) =>
  `(($${adminParam}::boolean) OR team_id = ANY($${managedParam}::uuid[]) OR created_by_user_id = $${userParam}
    OR (status <> 'draft' AND team_id = ANY($${teamsParam}::uuid[])))`;

class PostgresChallenges implements ChallengeRepository {
  constructor(private readonly db: Queryable) {}

  /** Attaches badge rules to challenge rows with one extra query for the whole batch. */
  private async hydrate(rows: readonly ChallengeRow[]): Promise<Challenge[]> {
    if (rows.length === 0) return [];
    const { rows: ruleRows } = await this.db.query<RuleRow>(
      'SELECT id, challenge_id, kind, threshold FROM badge_rules WHERE challenge_id = ANY($1::uuid[]) ORDER BY kind, threshold',
      [rows.map((row) => row.id)],
    );
    return rows.map((row) =>
      toChallenge(
        row,
        ruleRows
          .filter((rule) => rule.challenge_id === row.id)
          .map((rule) => ({ id: rule.id, kind: rule.kind, threshold: rule.threshold })),
      ),
    );
  }

  async insert(challenge: Challenge) {
    await this.db.query(
      `INSERT INTO challenges
         (id, name, activity_type, team_id, starts_on, ends_on, status, created_by_user_id,
          created_at, updated_at, completed_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        challenge.id,
        challenge.name,
        challenge.activityType,
        challenge.teamId,
        challenge.startsOn,
        challenge.endsOn,
        challenge.status,
        challenge.createdByUserId,
        challenge.createdAt,
        challenge.updatedAt,
        challenge.completedOn,
      ],
    );
    for (const rule of challenge.badgeRules) {
      await this.db.query(
        'INSERT INTO badge_rules (id, challenge_id, kind, threshold) VALUES ($1, $2, $3, $4)',
        [rule.id, challenge.id, rule.kind, rule.threshold],
      );
    }
  }

  async findVisible(id: string, viewer: Viewer) {
    const { rows } = await this.db.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM challenges WHERE id = $1 AND ${visibleTo(2, 3, 4, 5)}`,
      [id, viewer.userId, [...viewer.teamIds], [...viewer.managedTeamIds], viewer.role === 'admin'],
    );
    return (await this.hydrate(rows))[0] ?? null;
  }

  async transition(challenge: Challenge, from: ChallengeStatus) {
    const result = await this.db.query(
      `UPDATE challenges SET status = $2, completed_on = $3, updated_at = $4
        WHERE id = $1 AND status = $5`,
      [challenge.id, challenge.status, challenge.completedOn, challenge.updatedAt, from],
    );
    return result.rowCount === 1;
  }

  async list(query: ChallengeListQuery) {
    const { viewer } = query;
    const params: unknown[] = [
      viewer.userId,
      [...viewer.teamIds],
      [...viewer.managedTeamIds],
      viewer.role === 'admin',
    ];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [visibleTo(1, 2, 3, 4)];
    if (query.status !== undefined) where.push(`status = ${bind(query.status)}`);
    if (query.after !== undefined) {
      where.push(`(created_at, id) < (${bind(query.after.createdAt)}, ${bind(query.after.id)})`);
    }
    const { rows } = await this.db.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM challenges WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ${bind(query.limit)}`,
      params,
    );
    return this.hydrate(rows);
  }

  async findScoring(userId: string, activityType: ActivityType, activityDate: string) {
    const { rows } = await this.db.query<ChallengeRow>(
      `SELECT ${QUALIFIED_CHALLENGE_COLUMNS}
         FROM challenges c
         JOIN participations p
           ON p.challenge_id = c.id AND p.user_id = $1 AND p.joined_on <= $3::date
        WHERE c.status = 'active' AND c.activity_type = $2
          AND c.starts_on <= $3::date AND c.ends_on >= $3::date`,
      [userId, activityType, activityDate],
    );
    return this.hydrate(rows);
  }

  async listDraftsDue(today: string) {
    const { rows } = await this.db.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM challenges
        WHERE status = 'draft' AND starts_on <= $1::date AND ends_on >= $1::date
        ORDER BY starts_on, id`,
      [today],
    );
    return this.hydrate(rows);
  }

  async listActiveEndedBefore(cutoff: string) {
    const { rows } = await this.db.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM challenges
        WHERE status = 'active' AND ends_on < $1::date
        ORDER BY ends_on, id`,
      [cutoff],
    );
    return this.hydrate(rows);
  }

  async detachCreator(userId: string) {
    const result = await this.db.query(
      'UPDATE challenges SET created_by_user_id = NULL WHERE created_by_user_id = $1',
      [userId],
    );
    return result.rowCount;
  }
}

interface StandingRow {
  user_id: string;
  points: number;
  rank: number;
}

const toStanding = (row: StandingRow): RankedStanding => ({
  userId: row.user_id,
  points: row.points,
  rank: row.rank,
});

class PostgresParticipations implements ParticipationRepository {
  constructor(private readonly db: Queryable) {}

  async add(input: { challengeId: string; userId: string; teamId: string; joinedOn: string }) {
    const result = await this.db.query(
      `INSERT INTO participations (challenge_id, user_id, team_id, joined_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (challenge_id, user_id) DO NOTHING`,
      [input.challengeId, input.userId, input.teamId, input.joinedOn],
    );
    return result.rowCount === 1;
  }

  async find(challengeId: string, userId: string): Promise<Participation | null> {
    const { rows } = await this.db.query<{ joined_on: string; points: number }>(
      `SELECT to_char(joined_on, 'YYYY-MM-DD') AS joined_on, points
         FROM participations WHERE challenge_id = $1 AND user_id = $2`,
      [challengeId, userId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { challengeId, userId, joinedOn: row.joined_on, points: row.points };
  }

  async countFor(challengeIds: readonly string[]) {
    if (challengeIds.length === 0) return new Map<string, number>();
    const { rows } = await this.db.query<{ challenge_id: string; n: number }>(
      `SELECT challenge_id, count(*)::int AS n FROM participations
        WHERE challenge_id = ANY($1::uuid[]) GROUP BY challenge_id`,
      [[...challengeIds]],
    );
    return new Map(rows.map((row) => [row.challenge_id, row.n]));
  }

  async joinedAmong(userId: string, challengeIds: readonly string[]) {
    if (challengeIds.length === 0) return new Set<string>();
    const { rows } = await this.db.query<{ challenge_id: string }>(
      'SELECT challenge_id FROM participations WHERE user_id = $1 AND challenge_id = ANY($2::uuid[])',
      [userId, [...challengeIds]],
    );
    return new Set(rows.map((row) => row.challenge_id));
  }

  async addPoint(challengeId: string, userId: string) {
    await this.db.query(
      'UPDATE participations SET points = points + 1 WHERE challenge_id = $1 AND user_id = $2',
      [challengeId, userId],
    );
  }

  async leaderboard(challengeId: string, limit: number) {
    // The window function ranks everyone before LIMIT cuts the list, so ranks stay true.
    const { rows } = await this.db.query<StandingRow>(
      `SELECT user_id, points, rank() OVER (ORDER BY points DESC)::int AS rank
         FROM participations WHERE challenge_id = $1
        ORDER BY points DESC, user_id ASC LIMIT $2`,
      [challengeId, limit],
    );
    return rows.map(toStanding);
  }

  async rankOf(challengeId: string, userId: string) {
    const { rows } = await this.db.query<StandingRow>(
      `SELECT p.user_id, p.points,
              ((SELECT count(*) FROM participations o
                 WHERE o.challenge_id = p.challenge_id AND o.points > p.points) + 1)::int AS rank
         FROM participations p WHERE p.challenge_id = $1 AND p.user_id = $2`,
      [challengeId, userId],
    );
    return rows[0] === undefined ? null : toStanding(rows[0]);
  }

  async withdrawFromTeam(userId: string, teamId: string) {
    const { rows } = await this.db.query<{ challenge_id: string }>(
      `DELETE FROM participations p USING challenges c
        WHERE p.challenge_id = c.id AND p.user_id = $1 AND c.team_id = $2
          AND c.status IN ('draft', 'active')
        RETURNING p.challenge_id`,
      [userId, teamId],
    );
    return rows.map((row) => row.challenge_id);
  }

  async deleteAllForUser(userId: string) {
    const result = await this.db.query('DELETE FROM participations WHERE user_id = $1', [userId]);
    return result.rowCount;
  }
}

class PostgresProgressLedger implements ProgressLedger {
  constructor(private readonly db: Queryable) {}

  async record(entry: {
    challengeId: string;
    sourceEventId: string;
    userId: string;
    activityDate: string;
  }) {
    // The key decides, not a read-then-write: two simultaneous deliveries cannot both score.
    const result = await this.db.query(
      `INSERT INTO progress_ledger (challenge_id, source_event_id, user_id, activity_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (challenge_id, source_event_id) DO NOTHING`,
      [entry.challengeId, entry.sourceEventId, entry.userId, entry.activityDate],
    );
    return result.rowCount === 1;
  }

  async dates(challengeId: string, userId: string) {
    const { rows } = await this.db.query<{ activity_date: string }>(
      `SELECT to_char(activity_date, 'YYYY-MM-DD') AS activity_date FROM progress_ledger
        WHERE challenge_id = $1 AND user_id = $2 ORDER BY activity_date`,
      [challengeId, userId],
    );
    return rows.map((row) => row.activity_date);
  }

  async deleteForUserIn(userId: string, challengeIds: readonly string[]) {
    if (challengeIds.length === 0) return 0;
    const result = await this.db.query(
      'DELETE FROM progress_ledger WHERE user_id = $1 AND challenge_id = ANY($2::uuid[])',
      [userId, [...challengeIds]],
    );
    return result.rowCount;
  }

  async deleteAllForUser(userId: string) {
    const result = await this.db.query('DELETE FROM progress_ledger WHERE user_id = $1', [userId]);
    return result.rowCount;
  }
}

class PostgresBadges implements BadgeRepository {
  constructor(private readonly db: Queryable) {}

  async award(badge: AwardedBadge) {
    const result = await this.db.query(
      `INSERT INTO awarded_badges (challenge_id, user_id, badge_rule_id, awarded_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (challenge_id, user_id, badge_rule_id) DO NOTHING`,
      [badge.challengeId, badge.userId, badge.badgeRuleId, badge.awardedOn],
    );
    return result.rowCount === 1;
  }

  async listFor(challengeId: string, userId: string) {
    const { rows } = await this.db.query<{ badge_rule_id: string; awarded_on: string }>(
      `SELECT badge_rule_id, to_char(awarded_on, 'YYYY-MM-DD') AS awarded_on FROM awarded_badges
        WHERE challenge_id = $1 AND user_id = $2 ORDER BY awarded_on, badge_rule_id`,
      [challengeId, userId],
    );
    return rows.map((row): AwardedBadge => ({
      challengeId,
      userId,
      badgeRuleId: row.badge_rule_id,
      awardedOn: row.awarded_on,
    }));
  }

  async deleteAllForUser(userId: string) {
    const result = await this.db.query('DELETE FROM awarded_badges WHERE user_id = $1', [userId]);
    return result.rowCount;
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({
        challenges: new PostgresChallenges(queryable),
        participations: new PostgresParticipations(queryable),
        progress: new PostgresProgressLedger(queryable),
        badges: new PostgresBadges(queryable),
        outbox: new PostgresOutbox(queryable),
      }),
    );
  }
}
