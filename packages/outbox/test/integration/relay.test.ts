import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { PgliteDatabase } from '@teampulse/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTBOX_DDL,
  OutboxRelay,
  PostgresOutbox,
  type EventPublisher,
  type PublishOutcome,
} from '../../src/index.js';

const db = new PgliteDatabase();
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.exec(OUTBOX_DDL);
});
afterAll(() => db.close());

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-11-20T08:00:00Z';

const event = (n: number): TeamPulseEvent =>
  createEvent('UserDeleted', {
    eventId: id(n),
    occurredAt: new Date(Date.parse(NOW) + n * 1000),
    correlationId: id(900),
    payload: { userId: id(1) },
  });

const append = (...events: TeamPulseEvent[]) =>
  db.transaction(async (tx) => {
    const outbox = new PostgresOutbox(tx);
    for (const e of events) await outbox.append(e);
  });

const ok = (events: readonly TeamPulseEvent[]): PublishOutcome[] =>
  events.map((e) => ({ eventId: e.eventId }));

/** Fails the listed events, publishes the rest. */
const failing =
  (...failIds: string[]) =>
  (events: readonly TeamPulseEvent[]): Promise<PublishOutcome[]> =>
    Promise.resolve(
      events.map((e) =>
        failIds.includes(e.eventId)
          ? { eventId: e.eventId, error: 'rejected' }
          : { eventId: e.eventId },
      ),
    );

function setup(
  publish: (events: readonly TeamPulseEvent[]) => Promise<readonly PublishOutcome[]> = (events) =>
    Promise.resolve(ok(events)),
  options: { batchSize?: number; maxAttempts?: number; publishTimeoutMs?: number } = {},
) {
  const sent: string[][] = [];
  const publisher: EventPublisher = {
    publish: (events) => {
      sent.push(events.map((e) => e.eventId));
      return publish(events);
    },
  };
  const logs: string[] = [];
  const clock = new FixedClock('2026-11-20T09:00:00Z');
  const relay = new OutboxRelay({
    db,
    publisher,
    clock,
    logger: createLogger({ service: 'relay-test', level: 'debug', write: (l) => logs.push(l) }),
    ...options,
  });
  return { relay, sent, logs, clock };
}

const rows = async () =>
  (
    await db.query<{ id: string; attempts: number; published_at: Date | null }>(
      'SELECT id, attempts, published_at FROM outbox ORDER BY created_at, id',
    )
  ).rows;

describe('OutboxRelay.runOnce', () => {
  it('publishes pending events in order and marks them published', async () => {
    await append(event(3), event(1), event(2));
    const { relay, sent, clock } = setup();

    expect(await relay.runOnce()).toEqual({ published: 3, failed: 0, parked: 0 });
    expect(sent).toEqual([[id(1), id(2), id(3)]]);
    for (const row of await rows()) expect(row.published_at).toEqual(clock.now());
  });

  it('does nothing when the outbox is empty, and never republishes a published event', async () => {
    const { relay, sent } = setup();
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, parked: 0 });

    await append(event(1));
    await relay.runOnce();
    await relay.runOnce();
    expect(sent).toEqual([[id(1)]]);
  });

  it('respects the batch size and drains over several cycles', async () => {
    await append(...[1, 2, 3, 4, 5].map(event));
    const { relay, sent } = setup(undefined, { batchSize: 2 });
    await relay.runOnce();
    await relay.runOnce();
    await relay.runOnce();
    expect(sent.map((s) => s.length)).toEqual([2, 2, 1]);
    expect((await rows()).every((r) => r.published_at !== null)).toBe(true);
  });

  it('a rejected event stays pending with a counted attempt, without holding back the others', async () => {
    await append(event(1), event(2), event(3));
    const { relay, logs } = setup(failing(id(2)));

    expect(await relay.runOnce()).toEqual({ published: 2, failed: 1, parked: 0 });
    const state = await rows();
    expect(state.map((r) => [r.id, r.published_at !== null, r.attempts])).toEqual([
      [id(1), true, 0],
      [id(2), false, 1],
      [id(3), true, 0],
    ]);
    expect(logs.join('\n')).toContain('outbox.publish_failed');
  });

  it('a publisher that throws leaves every row pending and counts an attempt', async () => {
    await append(event(1), event(2));
    const { relay } = setup(() => Promise.reject(new Error('bus unreachable')));
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 2, parked: 0 });
    expect((await rows()).map((r) => [r.published_at, r.attempts])).toEqual([
      [null, 1],
      [null, 1],
    ]);
  });

  it('gives up on a publish that hangs, so the open transaction is not held until the database drops it', async () => {
    await append(event(1));
    const { relay } = setup(() => new Promise(() => undefined), { publishTimeoutMs: 50 });
    const started = Date.now();
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1, parked: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await rows())[0]).toMatchObject({ attempts: 1, published_at: null });
  });

  it('succeeds on a later cycle after a failure (at-least-once)', async () => {
    await append(event(1));
    let healthy = false;
    const { relay } = setup((events) =>
      healthy ? Promise.resolve(ok(events)) : failing(id(1))(events),
    );
    await relay.runOnce();
    healthy = true;
    expect(await relay.runOnce()).toMatchObject({ published: 1 });
    expect((await rows())[0]).toMatchObject({ attempts: 1 });
  });

  it('parks an event after the maximum attempts, so a poison event cannot spin forever', async () => {
    await append(event(1), event(2));
    const { relay, sent } = setup(failing(id(1)), { maxAttempts: 3 });
    for (let i = 0; i < 6; i += 1) await relay.runOnce();

    // Attempted exactly three times, then never picked up again.
    expect(sent.filter((batch) => batch.includes(id(1)))).toHaveLength(3);
    expect(await relay.backlog()).toEqual({ pending: 0, parked: 1 });
  });

  it('parks a row that is not a valid event immediately, and still publishes the valid ones', async () => {
    await append(event(1));
    await db.query(
      `INSERT INTO outbox (id, event_type, payload, created_at) VALUES ($1, 'Mystery', '{"nope":true}', $2)`,
      [id(50), new Date(Date.parse(NOW) + 500)],
    );
    const { relay, sent, logs } = setup(undefined, { maxAttempts: 5 });

    expect(await relay.runOnce()).toEqual({ published: 1, failed: 0, parked: 1 });
    expect(sent).toEqual([[id(1)]]);
    expect(logs.join('\n')).toContain('outbox.invalid');
    expect(await relay.backlog()).toEqual({ pending: 0, parked: 1 });
  });
});

describe('OutboxRelay housekeeping', () => {
  it('reports the backlog', async () => {
    await append(event(1), event(2));
    const { relay } = setup();
    expect(await relay.backlog()).toEqual({ pending: 2, parked: 0 });
    await relay.runOnce();
    expect(await relay.backlog()).toEqual({ pending: 0, parked: 0 });
  });

  it('purges only published rows older than the cutoff', async () => {
    await append(event(1), event(2), event(3));
    const { relay, clock } = setup(failing(id(3)));
    await relay.runOnce();

    expect(await relay.purgePublished(new Date(clock.now().getTime() - 1000))).toBe(0);
    expect(await relay.purgePublished(new Date(clock.now().getTime() + 1000))).toBe(2);
    expect((await rows()).map((r) => r.id)).toEqual([id(3)]);
  });
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('OutboxRelay.run', () => {
  it('keeps publishing as events arrive and stops promptly when aborted', async () => {
    const { relay, sent } = setup();
    const controller = new AbortController();
    const running = relay.run({ signal: controller.signal, pollIntervalMs: 20 });

    await append(event(1));
    await waitFor(() => sent.length >= 1);
    await append(event(2));
    await waitFor(() => sent.length >= 2);

    controller.abort();
    await running; // resolves instead of hanging
    expect(sent).toEqual([[id(1)], [id(2)]]);
  });

  it('survives a database error and carries on', async () => {
    const { relay } = setup();
    const controller = new AbortController();
    await db.exec('ALTER TABLE outbox RENAME TO outbox_gone');
    const running = relay.run({
      signal: controller.signal,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    await db.exec('ALTER TABLE outbox_gone RENAME TO outbox');
    await append(event(1));
    await waitFor(async () => (await rows())[0]?.published_at !== null);
    controller.abort();
    await running;
  });
});
