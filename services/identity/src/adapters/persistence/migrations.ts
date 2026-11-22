import { OUTBOX_DDL } from '@teampulse/outbox';
import type { Migration } from '@teampulse/db';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE users (
        id                    uuid PRIMARY KEY,
        email                 text        NOT NULL,
        display_name          text        NOT NULL,
        password_hash         text        NOT NULL,
        role                  text        NOT NULL,
        status                text        NOT NULL,
        failed_login_attempts integer     NOT NULL DEFAULT 0,
        locked_until          timestamptz,
        created_at            timestamptz NOT NULL,
        updated_at            timestamptz NOT NULL,
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
        CONSTRAINT users_role_valid CHECK (role IN ('employee', 'manager', 'admin')),
        CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
        CONSTRAINT users_failed_attempts_nonneg CHECK (failed_login_attempts >= 0)
      );
      -- Keyset pagination: ORDER BY created_at, id with a (created_at, id) > (...) predicate.
      CREATE INDEX users_created_at_id_idx ON users (created_at, id);

      CREATE TABLE teams (
        id              uuid PRIMARY KEY,
        name            text        NOT NULL,
        manager_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_at      timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX teams_name_unique ON teams (lower(name));
      CREATE INDEX teams_manager_idx ON teams (manager_user_id);

      CREATE TABLE team_members (
        team_id  uuid        NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
        user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        added_at timestamptz NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE INDEX team_members_user_idx ON team_members (user_id);

      CREATE TABLE refresh_tokens (
        id                uuid PRIMARY KEY,
        user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id         uuid        NOT NULL,
        token_hash        text        NOT NULL,
        family_started_at timestamptz NOT NULL,
        issued_at         timestamptz NOT NULL,
        expires_at        timestamptz NOT NULL,
        revoked_at        timestamptz,
        replaced_by_id    uuid,
        CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
      );
      CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
      CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

      ${OUTBOX_DDL}
    `,
  },
];
