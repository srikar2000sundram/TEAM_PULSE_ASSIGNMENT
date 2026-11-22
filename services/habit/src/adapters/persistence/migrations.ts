import type { Migration } from '@teampulse/db';
import { OUTBOX_DDL } from '@teampulse/outbox';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 *
 * A migration is a snapshot: the activity type list below is written out, not imported, so adding
 * an activity type later needs a new migration (a test fails until it exists).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE habits (
        id            uuid PRIMARY KEY,
        -- A plain uuid, not a foreign key: users belong to the Identity Service's database.
        owner_user_id uuid        NOT NULL,
        title         text        NOT NULL,
        description   text,
        activity_type text        NOT NULL,
        visibility    text        NOT NULL,
        team_id       uuid,
        reminder      jsonb,
        archived_at   timestamptz,
        created_at    timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL,
        CONSTRAINT habits_title_length CHECK (char_length(title) BETWEEN 1 AND 80),
        CONSTRAINT habits_description_length CHECK (description IS NULL OR char_length(description) <= 500),
        CONSTRAINT habits_activity_type_valid CHECK (activity_type IN (
          'walking', 'running', 'cycling', 'strength', 'yoga', 'meditation',
          'sleep', 'hydration', 'nutrition', 'other')),
        CONSTRAINT habits_visibility_valid CHECK (visibility IN ('private', 'team')),
        -- A team habit has a team and a private habit does not: no half-shared habits.
        CONSTRAINT habits_team_matches_visibility CHECK ((visibility = 'team') = (team_id IS NOT NULL))
      );

      -- "My habits": newest first with keyset pagination on (created_at, id).
      CREATE INDEX habits_owner_idx ON habits (owner_user_id, created_at DESC, id DESC);
      -- "Habits shared with my teams": only active team habits are ever listed to other people.
      CREATE INDEX habits_team_idx ON habits (team_id, created_at DESC, id DESC)
        WHERE visibility = 'team' AND archived_at IS NULL;

      ${OUTBOX_DDL}
    `,
  },
];
