import type { TeamPulseEvent } from '@teampulse/contracts';
import type { Queryable } from '@teampulse/db';

/**
 * Port used by application code. Events are written in the same transaction as the change that
 * caused them and relayed to the event bus afterwards, so a crash can never leave a change
 * without its event or an event without its change.
 */
export interface Outbox {
  append(event: TeamPulseEvent): Promise<void>;
}

/**
 * The outbox table, shared by every producing service (each has its own copy in its own schema).
 * Include it in the service's first migration: `${OUTBOX_DDL}`.
 */
export const OUTBOX_DDL = `
      -- Transactional outbox: events are written with the change, then relayed to EventBridge.
      CREATE TABLE outbox (
        id           uuid PRIMARY KEY,
        event_type   text        NOT NULL,
        payload      jsonb       NOT NULL,
        created_at   timestamptz NOT NULL,
        published_at timestamptz,
        -- Failed publish attempts. At the relay's limit the row is parked for an operator.
        attempts     integer     NOT NULL DEFAULT 0
      );
      CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;
`;

/** Writes through whatever transaction it is given, so the append commits with the change. */
export class PostgresOutbox implements Outbox {
  constructor(private readonly db: Queryable) {}

  async append(event: TeamPulseEvent): Promise<void> {
    await this.db.query(
      'INSERT INTO outbox (id, event_type, payload, created_at) VALUES ($1, $2, $3::jsonb, $4)',
      [event.eventId, event.eventType, JSON.stringify(event), event.occurredAt],
    );
  }
}
