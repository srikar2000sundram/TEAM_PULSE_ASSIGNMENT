import type { Migration } from '@teampulse/db';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      -- When each person completed each habit. Instants and identifiers only, never content.
      CREATE TABLE activity_times (
        -- The ActivityCompleted event. The same event is stored once, however often it arrives.
        event_id    uuid PRIMARY KEY,
        -- Plain uuids, not foreign keys: users and habits belong to other services.
        user_id     uuid        NOT NULL,
        habit_id    uuid        NOT NULL,
        occurred_at timestamptz NOT NULL
      );
      CREATE INDEX activity_times_user_idx ON activity_times (user_id, occurred_at DESC);
      CREATE INDEX activity_times_occurred_idx ON activity_times (occurred_at);

      -- What the person decided about a particular suggestion.
      CREATE TABLE decisions (
        user_id        uuid        NOT NULL,
        habit_id       uuid        NOT NULL,
        suggested_time text        NOT NULL,
        time_zone      text        NOT NULL,
        decision       text        NOT NULL,
        decided_at     timestamptz NOT NULL,
        PRIMARY KEY (user_id, habit_id, suggested_time, time_zone),
        CONSTRAINT decisions_decision_valid CHECK (decision IN ('accepted', 'dismissed')),
        CONSTRAINT decisions_time_format CHECK (suggested_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      );
    `,
  },
];
