import type { Role } from '@teampulse/contracts';
import type { Database, Queryable } from '@teampulse/db';
import { err, ok, unwrap, type Cursor, type Result } from '@teampulse/kernel';
import type {
  RefreshTokenRepository,
  TeamRepository,
  Transaction,
  UnitOfWork,
  UserRepository,
} from '../../application/ports.js';
import { emailTaken, teamNameTaken } from '../../application/errors.js';
import { Email } from '../../domain/email.js';
import { RefreshToken } from '../../domain/refresh-token.js';
import type { Team, TeamMember, TeamSummary } from '../../domain/team.js';
import { User, type UserStatus } from '../../domain/user.js';
import { PostgresOutbox } from '@teampulse/outbox';

/* Row shapes returned by the driver, and the mapping into domain objects. */

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toUser = (row: UserRow): User =>
  User.restore({
    id: row.id,
    // Stored emails were validated on the way in, so re-parsing cannot fail.
    email: unwrap(Email.create(row.email)),
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    failedLoginAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

interface TeamRow {
  id: string;
  name: string;
  manager_user_id: string;
  created_at: Date;
  member_count?: number;
}

const toTeam = (row: TeamRow): Team => ({
  id: row.id,
  name: row.name,
  managerUserId: row.manager_user_id,
  createdAt: row.created_at,
});

const toSummary = (row: TeamRow): TeamSummary => ({
  team: toTeam(row),
  memberCount: row.member_count ?? 0,
});

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  family_started_at: Date;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
}

const toToken = (row: TokenRow): RefreshToken =>
  RefreshToken.restore({
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    familyStartedAt: row.family_started_at,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    replacedById: row.replaced_by_id,
  });

/* ------------------------------------------------------------------------------------------ */

class PostgresUsers implements UserRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string) {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async findByIdForUpdate(id: string) {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async findByEmail(email: string) {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async insert(user: User): Promise<Result<void>> {
    // ON CONFLICT instead of catching the error: a failed statement would abort the whole
    // transaction in PostgreSQL, silently discarding everything else done in it.
    const { rowCount } = await this.db.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, status,
                          failed_login_attempts, locked_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (email) DO NOTHING`,
      [
        user.id,
        user.email.value,
        user.displayName,
        user.passwordHash,
        user.role,
        user.status,
        user.failedLoginAttempts,
        user.lockedUntil,
        user.createdAt,
        user.updatedAt,
      ],
    );
    return rowCount === 0 ? err(emailTaken()) : ok(undefined);
  }

  async update(user: User) {
    await this.db.query(
      `UPDATE users
          SET display_name = $2, password_hash = $3, role = $4, status = $5,
              failed_login_attempts = $6, locked_until = $7, updated_at = $8
        WHERE id = $1`,
      [
        user.id,
        user.displayName,
        user.passwordHash,
        user.role,
        user.status,
        user.failedLoginAttempts,
        user.lockedUntil,
        user.updatedAt,
      ],
    );
  }

  async delete(id: string) {
    await this.db.query('DELETE FROM users WHERE id = $1', [id]);
  }

  async list(options: { limit: number; after?: Cursor }) {
    const { after, limit } = options;
    const { rows } =
      after === undefined
        ? await this.db.query<UserRow>('SELECT * FROM users ORDER BY created_at, id LIMIT $1', [
            limit,
          ])
        : await this.db.query<UserRow>(
            `SELECT * FROM users
              WHERE (created_at, id) > ($1::timestamptz, $2::uuid)
              ORDER BY created_at, id
              LIMIT $3`,
            [after.createdAt, after.id, limit],
          );
    return rows.map(toUser);
  }

  async countActiveAdmins() {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`,
    );
    return rows[0]?.n ?? 0;
  }
}

class PostgresTeams implements TeamRepository {
  constructor(private readonly db: Queryable) {}

  private static readonly WITH_COUNT = `
    SELECT t.*, (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count
      FROM teams t`;

  async findById(id: string) {
    const { rows } = await this.db.query<TeamRow>('SELECT * FROM teams WHERE id = $1', [id]);
    return rows[0] === undefined ? null : toTeam(rows[0]);
  }

  async insert(team: Team): Promise<Result<void>> {
    const { rowCount } = await this.db.query(
      `INSERT INTO teams (id, name, manager_user_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [team.id, team.name, team.managerUserId, team.createdAt],
    );
    return rowCount === 0 ? err(teamNameTaken()) : ok(undefined);
  }

  async listAll() {
    const { rows } = await this.db.query<TeamRow>(
      `${PostgresTeams.WITH_COUNT} ORDER BY t.name, t.id`,
    );
    return rows.map(toSummary);
  }

  async listForUser(userId: string) {
    const { rows } = await this.db.query<TeamRow>(
      `${PostgresTeams.WITH_COUNT}
        WHERE t.manager_user_id = $1
           OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $1)
        ORDER BY t.name, t.id`,
      [userId],
    );
    return rows.map(toSummary);
  }

  async teamIdsOfMember(userId: string) {
    const { rows } = await this.db.query<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE user_id = $1 ORDER BY team_id',
      [userId],
    );
    return rows.map((row) => row.team_id);
  }

  async teamIdsManagedBy(userId: string) {
    const { rows } = await this.db.query<{ id: string }>(
      'SELECT id FROM teams WHERE manager_user_id = $1 ORDER BY id',
      [userId],
    );
    return rows.map((row) => row.id);
  }

  async isMember(teamId: string, userId: string) {
    const { rows } = await this.db.query(
      'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId],
    );
    return rows.length > 0;
  }

  async members(teamId: string): Promise<readonly TeamMember[]> {
    const { rows } = await this.db.query<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name
         FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1
        ORDER BY u.display_name, u.id`,
      [teamId],
    );
    return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  async addMember(teamId: string, userId: string, now: Date) {
    const { rowCount } = await this.db.query(
      `INSERT INTO team_members (team_id, user_id, added_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [teamId, userId, now],
    );
    return rowCount > 0;
  }

  async removeMember(teamId: string, userId: string) {
    const { rowCount } = await this.db.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId],
    );
    return rowCount > 0;
  }
}

class PostgresRefreshTokens implements RefreshTokenRepository {
  constructor(private readonly db: Queryable) {}

  async insert(token: RefreshToken) {
    await this.db.query(
      `INSERT INTO refresh_tokens
         (id, user_id, family_id, token_hash, family_started_at, issued_at, expires_at,
          revoked_at, replaced_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        token.id,
        token.userId,
        token.familyId,
        token.tokenHash,
        token.familyStartedAt,
        token.issuedAt,
        token.expiresAt,
        token.revokedAt,
        token.replacedById,
      ],
    );
  }

  async findByHashForUpdate(tokenHash: string) {
    const { rows } = await this.db.query<TokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash],
    );
    return rows[0] === undefined ? null : toToken(rows[0]);
  }

  async update(token: RefreshToken) {
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = $2, replaced_by_id = $3 WHERE id = $1',
      [token.id, token.revokedAt, token.replacedById],
    );
  }

  async revokeFamily(familyId: string, now: Date) {
    // Already-revoked rows keep their original revocation time (it drives the reuse-grace rule).
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId, now],
    );
  }

  async revokeAllForUser(userId: string, now: Date) {
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, now],
    );
  }
}

/* ------------------------------------------------------------------------------------------ */

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((queryable) =>
      work({
        users: new PostgresUsers(queryable),
        teams: new PostgresTeams(queryable),
        tokens: new PostgresRefreshTokens(queryable),
        outbox: new PostgresOutbox(queryable),
      }),
    );
  }
}
