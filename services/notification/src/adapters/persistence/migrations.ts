import type { Migration } from '@teampulse/db';

/**
 * Migrations are TypeScript strings rather than .sql files so the build needs no copy step and
 * they cannot go missing from the container image.
 *
 * A migration is a snapshot: the list of notification kinds is written out, not imported, so adding
 * a kind later needs a new migration (a test fails until it exists).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE notifications (
        id         uuid PRIMARY KEY,
        -- A plain uuid, not a foreign key: users belong to the Identity Service.
        user_id    uuid        NOT NULL,
        kind       text        NOT NULL,
        -- The numbers the text is rendered from. Never free text.
        params     jsonb       NOT NULL DEFAULT '{}',
        -- The event (or reminder occurrence) that caused it.
        source_id  uuid        NOT NULL,
        created_at timestamptz NOT NULL,
        read_at    timestamptz,
        CONSTRAINT notifications_kind_valid
          CHECK (kind IN ('milestone', 'badge', 'challenge_completed', 'reminder')),
        -- Idempotency: the same cause notifies the same person once.
        CONSTRAINT notifications_once_per_source UNIQUE (user_id, source_id)
      );
      -- "My notifications": newest first with keyset pagination on (created_at, id).
      CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
      CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC, id DESC)
        WHERE read_at IS NULL;

      CREATE TABLE notification_preferences (
        user_id    uuid PRIMARY KEY,
        milestones boolean     NOT NULL,
        badges     boolean     NOT NULL,
        challenges boolean     NOT NULL,
        reminders  boolean     NOT NULL,
        updated_at timestamptz NOT NULL
      );

      -- Reminder schedules, learned from Habit Service events.
      CREATE TABLE reminders (
        habit_id      uuid PRIMARY KEY,
        user_id       uuid        NOT NULL,
        -- All three are null when the habit has no reminder (never set, or cleared).
        days_of_week  text[],
        remind_at     text,
        time_zone     text,
        archived      boolean     NOT NULL DEFAULT false,
        last_event_at timestamptz NOT NULL,
        CONSTRAINT reminders_schedule_complete CHECK (
          (days_of_week IS NULL) = (remind_at IS NULL) AND (remind_at IS NULL) = (time_zone IS NULL)),
        CONSTRAINT reminders_time_format
          CHECK (remind_at IS NULL OR remind_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      );
      CREATE INDEX reminders_user_idx ON reminders (user_id);

      -- Which day's reminder has been sent, so a repeated tick cannot send it again.
      CREATE TABLE reminder_occurrences (
        habit_id   uuid        NOT NULL,
        local_date date        NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (habit_id, local_date)
      );

      -- Who joined which challenge, so ChallengeCompleted (which names nobody) can be fanned out.
      CREATE TABLE challenge_participants (
        challenge_id uuid NOT NULL,
        user_id      uuid NOT NULL,
        PRIMARY KEY (challenge_id, user_id)
      );
      CREATE INDEX challenge_participants_user_idx ON challenge_participants (user_id);
    `,
  },
];
