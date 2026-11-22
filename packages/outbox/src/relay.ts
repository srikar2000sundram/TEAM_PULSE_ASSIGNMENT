import { parseEvent, type TeamPulseEvent } from '@teampulse/contracts';
import type { Database } from '@teampulse/db';
import type { Clock } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';

export interface PublishOutcome {
  readonly eventId: string;
  /** Present when this event could not be published. */
  readonly error?: string;
}

/** Port: sends events to the bus. Returns one outcome per event; throws only if nothing was sent. */
export interface EventPublisher {
  publish(events: readonly TeamPulseEvent[]): Promise<readonly PublishOutcome[]>;
}

export interface OutboxRelayOptions {
  readonly db: Database;
  readonly publisher: EventPublisher;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Rows handled per cycle. */
  readonly batchSize?: number;
  /** After this many failed attempts an event is parked for an operator instead of retried. */
  readonly maxAttempts?: number;
  /**
   * How long one publish call may take. The relay holds a database transaction open meanwhile, and
   * connections drop transactions idle for more than 15 seconds, so this must stay well below that.
   * A call that times out counts as failed and is retried (it may still reach the bus, which is a
   * duplicate, and consumers absorb those).
   */
  readonly publishTimeoutMs?: number;
}

export interface RelayCycleResult {
  readonly published: number;
  readonly failed: number;
  readonly parked: number;
}

export interface RelayRunOptions {
  readonly signal: AbortSignal;
  /** Wait between cycles when the outbox is empty. */
  readonly pollIntervalMs?: number;
  /** Wait after the database itself fails. */
  readonly errorBackoffMs?: number;
}

interface OutboxRow {
  id: string;
  payload: unknown;
  attempts: number;
}

/**
 * Publishes outbox rows to the event bus (at-least-once).
 *
 * Each cycle claims a batch with `FOR UPDATE SKIP LOCKED`, so several service instances can run a
 * relay at once without publishing the same row twice at the same moment, and a crashed instance
 * simply releases its rows. A row is marked published only after the bus accepted it; if the process
 * dies between the two, the event is published again, which is why every consumer is idempotent.
 *
 * Failures are per event: one rejected event does not hold back the others. A rejected event is
 * retried on later cycles, and after `maxAttempts` it is parked (`attempts` stays at the limit, the
 * row stays in the table) so a poison event cannot spin forever; an alarm on parked rows tells an
 * operator.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly publishTimeoutMs: number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 25;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 8_000;
  }

  /** One claim, publish, mark cycle. */
  runOnce(): Promise<RelayCycleResult> {
    const { db, logger } = this.options;
    return db.transaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, payload, attempts FROM outbox
          WHERE published_at IS NULL AND attempts < $1
          ORDER BY created_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [this.maxAttempts, this.batchSize],
      );
      if (rows.length === 0) return { published: 0, failed: 0, parked: 0 };

      const valid: TeamPulseEvent[] = [];
      const parked: string[] = [];
      for (const row of rows) {
        const parsed = parseEvent(row.payload);
        if (parsed.success) {
          valid.push(parsed.data);
        } else {
          // Can never succeed, so retrying is pointless: park it right away.
          parked.push(row.id);
          logger.error(
            { event: 'outbox.invalid', eventId: row.id },
            'outbox row is not a valid event',
          );
        }
      }

      const outcomes = await this.publish(valid);
      const succeeded = outcomes.filter((o) => o.error === undefined).map((o) => o.eventId);
      const failed = outcomes.filter((o) => o.error !== undefined);

      if (succeeded.length > 0) {
        await tx.query('UPDATE outbox SET published_at = $2 WHERE id = ANY($1::uuid[])', [
          succeeded,
          this.options.clock.now(),
        ]);
      }
      if (failed.length > 0) {
        await tx.query('UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])', [
          failed.map((o) => o.eventId),
        ]);
        for (const outcome of failed) {
          logger.warn(
            { event: 'outbox.publish_failed', eventId: outcome.eventId, reason: outcome.error },
            'event not published, will retry',
          );
        }
      }
      if (parked.length > 0) {
        await tx.query('UPDATE outbox SET attempts = $2 WHERE id = ANY($1::uuid[])', [
          parked,
          this.maxAttempts,
        ]);
      }
      return { published: succeeded.length, failed: failed.length, parked: parked.length };
    });
  }

  /** A publisher that throws counts as every event failing: the rows stay and are retried. */
  private async publish(events: readonly TeamPulseEvent[]): Promise<readonly PublishOutcome[]> {
    if (events.length === 0) return [];
    try {
      return await withTimeout(this.options.publisher.publish(events), this.publishTimeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'publish failed';
      return events.map((event) => ({ eventId: event.eventId, error: reason }));
    }
  }

  /**
   * Runs cycles until `signal` aborts. A full batch means more is waiting, so it goes straight to
   * the next cycle; otherwise it sleeps. Database errors back off and never end the loop.
   */
  async run({
    signal,
    pollIntervalMs = 1_000,
    errorBackoffMs = 5_000,
  }: RelayRunOptions): Promise<void> {
    const { logger } = this.options;
    logger.info({ event: 'outbox.relay_started' }, 'outbox relay started');
    while (!signal.aborted) {
      try {
        const result = await this.runOnce();
        const handled = result.published + result.failed + result.parked;
        // Retrying failed rows immediately would hammer a struggling bus: only a clean full batch
        // skips the wait.
        if (handled >= this.batchSize && result.failed === 0) continue;
        await sleep(pollIntervalMs, signal);
      } catch (error) {
        logger.error({ event: 'outbox.relay_error', err: error }, 'outbox relay cycle failed');
        await sleep(errorBackoffMs, signal);
      }
    }
    logger.info({ event: 'outbox.relay_stopped' }, 'outbox relay stopped');
  }

  /** Housekeeping: published rows older than `before` are no longer needed. Returns rows removed. */
  async purgePublished(before: Date): Promise<number> {
    const result = await this.options.db.query(
      'DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < $1',
      [before],
    );
    return result.rowCount;
  }

  /** Events waiting to go out, and events given up on. For health checks and alarms. */
  async backlog(): Promise<{ pending: number; parked: number }> {
    const { rows } = await this.options.db.query<{ pending: number; parked: number }>(
      `SELECT count(*) FILTER (WHERE attempts < $1)::int AS pending,
              count(*) FILTER (WHERE attempts >= $1)::int AS parked
         FROM outbox WHERE published_at IS NULL`,
      [this.maxAttempts],
    );
    return rows[0] ?? { pending: 0, parked: 0 };
  }
}

/** Resolves after `ms`, or immediately when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Rejects if `work` does not settle within `ms`. The work itself is not cancelled. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`publish timed out after ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('publish failed'));
      },
    );
  });
}
