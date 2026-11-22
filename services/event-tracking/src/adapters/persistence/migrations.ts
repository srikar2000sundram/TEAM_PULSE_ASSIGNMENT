import type { Migration } from '@teampulse/db';
import { OUTBOX_DDL } from '@teampulse/outbox';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 *
 * A migration is a snapshot: the activity type list below is written out, not imported, so adding
 * an activity type later needs a new migration (a test fails until it exists).
 */
const ACTIVITY_TYPES = `'walking', 'running', 'cycling', 'strength', 'yoga', 'meditation',
          'sleep', 'hydration', 'nutrition', 'other'`;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE activities (
        id            uuid PRIMARY KEY,
        -- Plain uuids, not foreign keys: users belong to Identity, habits to the Habit Service.
        user_id       uuid        NOT NULL,
        habit_id      uuid        NOT NULL,
        activity_type text        NOT NULL,
        activity_date date        NOT NULL,
        -- The user's teams when it happened. At most 20, the same cap the access token enforces.
        team_ids      uuid[]      NOT NULL DEFAULT '{}',
        created_at    timestamptz NOT NULL,
        CONSTRAINT activities_type_valid CHECK (activity_type IN (${ACTIVITY_TYPES})),
        CONSTRAINT activities_team_ids_max CHECK (cardinality(team_ids) <= 20),
        -- Idempotency: one completion per user, habit and day, decided by the database.
        CONSTRAINT activities_once_per_day UNIQUE (user_id, habit_id, activity_date)
      );
      -- "My activities": newest first with keyset pagination on (created_at, id).
      CREATE INDEX activities_user_created_idx ON activities (user_id, created_at DESC, id DESC);

      -- What this service has learned about habits from Habit Service events.
      CREATE TABLE known_habits (
        habit_id      uuid PRIMARY KEY,
        owner_user_id uuid        NOT NULL,
        -- Null until HabitCreated or HabitUpdated is seen (an archive can arrive first).
        activity_type text,
        archived      boolean     NOT NULL DEFAULT false,
        last_event_at timestamptz NOT NULL,
        CONSTRAINT known_habits_type_valid CHECK (activity_type IS NULL OR activity_type IN (${ACTIVITY_TYPES}))
      );
      CREATE INDEX known_habits_owner_idx ON known_habits (owner_user_id);

      ${OUTBOX_DDL}
    `,
  },
];
