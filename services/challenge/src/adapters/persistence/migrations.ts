import type { Migration } from '@teampulse/db';
import { OUTBOX_DDL } from '@teampulse/outbox';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 *
 * A migration is a snapshot: the lists of activity types, statuses and badge kinds are written
 * out, not imported, so adding a value later needs a new migration (a test fails until it exists).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE challenges (
        id                 uuid PRIMARY KEY,
        name               text        NOT NULL,
        activity_type      text        NOT NULL,
        -- A plain uuid, not a foreign key: teams belong to the Identity Service's database.
        team_id            uuid        NOT NULL,
        starts_on          date        NOT NULL,
        ends_on            date        NOT NULL,
        status             text        NOT NULL,
        -- Null after the creator's account was deleted.
        created_by_user_id uuid,
        created_at         timestamptz NOT NULL,
        updated_at         timestamptz NOT NULL,
        completed_on       date,
        CONSTRAINT challenges_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
        CONSTRAINT challenges_activity_type_valid CHECK (activity_type IN (
          'walking', 'running', 'cycling', 'strength', 'yoga', 'meditation',
          'sleep', 'hydration', 'nutrition', 'other')),
        CONSTRAINT challenges_status_valid
          CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
        CONSTRAINT challenges_dates_ordered CHECK (starts_on <= ends_on),
        -- Only a completed challenge has a completion date.
        CONSTRAINT challenges_completed_on_matches_status
          CHECK ((status = 'completed') = (completed_on IS NOT NULL))
      );
      -- "Challenges of my team", newest first with keyset pagination on (created_at, id).
      CREATE INDEX challenges_team_idx ON challenges (team_id, created_at DESC, id DESC);
      -- The scheduler looks only at unfinished challenges.
      CREATE INDEX challenges_open_idx ON challenges (status, starts_on, ends_on)
        WHERE status IN ('draft', 'active');

      CREATE TABLE badge_rules (
        id           uuid PRIMARY KEY,
        challenge_id uuid    NOT NULL REFERENCES challenges (id) ON DELETE CASCADE,
        kind         text    NOT NULL,
        threshold    integer NOT NULL,
        CONSTRAINT badge_rules_kind_valid CHECK (kind IN ('streak', 'total', 'milestone')),
        CONSTRAINT badge_rules_threshold_range CHECK (threshold BETWEEN 1 AND 1000),
        CONSTRAINT badge_rules_unique UNIQUE (challenge_id, kind, threshold)
      );

      CREATE TABLE participations (
        challenge_id uuid    NOT NULL REFERENCES challenges (id) ON DELETE CASCADE,
        user_id      uuid    NOT NULL,
        team_id      uuid    NOT NULL,
        joined_on    date    NOT NULL,
        points       integer NOT NULL DEFAULT 0,
        PRIMARY KEY (challenge_id, user_id),
        CONSTRAINT participations_points_not_negative CHECK (points >= 0)
      );
      CREATE INDEX participations_user_idx ON participations (user_id);
      -- The leaderboard: highest points first, ties in a stable order.
      CREATE INDEX participations_board_idx ON participations (challenge_id, points DESC, user_id);

      -- One row per qualifying activity. The key makes scoring idempotent: the same event scores
      -- once per challenge, however often it is delivered.
      CREATE TABLE progress_ledger (
        challenge_id    uuid NOT NULL REFERENCES challenges (id) ON DELETE CASCADE,
        source_event_id uuid NOT NULL,
        user_id         uuid NOT NULL,
        activity_date   date NOT NULL,
        PRIMARY KEY (challenge_id, source_event_id)
      );
      CREATE INDEX progress_ledger_user_idx ON progress_ledger (challenge_id, user_id, activity_date);
      CREATE INDEX progress_ledger_person_idx ON progress_ledger (user_id);

      CREATE TABLE awarded_badges (
        challenge_id  uuid NOT NULL REFERENCES challenges (id) ON DELETE CASCADE,
        user_id       uuid NOT NULL,
        badge_rule_id uuid NOT NULL REFERENCES badge_rules (id) ON DELETE CASCADE,
        awarded_on    date NOT NULL,
        -- A badge is awarded once per person.
        PRIMARY KEY (challenge_id, user_id, badge_rule_id)
      );
      CREATE INDEX awarded_badges_person_idx ON awarded_badges (user_id);

      ${OUTBOX_DDL}
    `,
  },
];
