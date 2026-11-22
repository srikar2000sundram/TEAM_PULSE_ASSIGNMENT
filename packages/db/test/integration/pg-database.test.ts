import pg from 'pg';
import { startPgWireServer, type PgWireServer } from '@teampulse/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, isTransientDatabaseError } from '../../src/index.js';

/**
 * `PgDatabase` is the class every service runs in production, so it is exercised through the real
 * `pg` driver and the PostgreSQL wire protocol (PGlite serves the protocol on a local socket; no
 * Docker or database server needed).
 */

const SCHEMA = 'svc';
const insert = (n: number) =>
  `INSERT INTO t (id) VALUES ('00000000-0000-4000-8000-${String(n).padStart(12, '0')}')`;

describe('PgDatabase', () => {
  let server: PgWireServer;
  let db: PgDatabase;

  beforeAll(async () => {
    server = await startPgWireServer(SCHEMA);
    db = new PgDatabase({
      connectionString: server.url,
      schema: SCHEMA,
      maxConnections: 1,
      ssl: false,
    });
    await db.exec('CREATE TABLE t (id uuid PRIMARY KEY)');
  });
  afterAll(async () => {
    await db.close();
    await server.close();
  });

  it('keeps the service inside its own schema', async () => {
    const { rows } = await db.query<{ table_schema: string }>(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 't'",
    );
    expect(rows).toEqual([{ table_schema: SCHEMA }]);
  });

  it('applies the connection safety settings to every session', async () => {
    const path = await db.query<{ search_path: string }>('SHOW search_path');
    const timeout = await db.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const idle = await db.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );
    expect(path.rows[0]?.search_path).toBe(SCHEMA);
    expect(timeout.rows[0]?.statement_timeout).toBe('10s');
    expect(idle.rows[0]?.idle_in_transaction_session_timeout).toBe('15s');
  });

  it('reports rows affected for writes and rows returned for reads', async () => {
    const write = await db.query(insert(1));
    const read = await db.query('SELECT 1 FROM t');
    const none = await db.query('SELECT 1 FROM t WHERE false');
    expect(write.rowCount).toBe(1);
    expect(read.rowCount).toBe(1);
    expect(none.rowCount).toBe(0);
    await db.exec('DELETE FROM t');
  });

  it('commits a transaction when the work resolves', async () => {
    await db.transaction((tx) => tx.query(insert(2)));
    expect((await db.query('SELECT 1 FROM t')).rowCount).toBe(1);
    await db.exec('DELETE FROM t');
  });

  it('rolls a transaction back when the work throws, and the pool stays usable', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(insert(3));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect((await db.query('SELECT 1 FROM t')).rowCount).toBe(0);
    expect((await db.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
  });

  it('survives a failing statement inside a transaction without leaking the connection', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(
        db.transaction((tx) => tx.query('SELECT * FROM no_such_table')),
      ).rejects.toThrow();
    }
    // With a pool of one, a leaked connection would hang here instead of answering.
    expect((await db.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
  });

  it('serialises concurrent transactions on a pool of one', async () => {
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        db.transaction(async (tx) => {
          order.push(`${name}:start`);
          await tx.query('SELECT 1');
          order.push(`${name}:end`);
        }),
      ),
    );
    // Never interleaved: each transaction ends before the next one starts.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.split(':')[0]).toBe(order[i + 1]?.split(':')[0]);
    }
  });

  it('never overlaps two queries on one connection (deprecated in pg 8, an error in pg 9)', async () => {
    // Counts queries in flight per client. (Node reports the deprecation only once per process, so
    // watching for the warning would miss a regression whenever an earlier test already triggered it.)
    const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const original = proto.query;
    const inFlight = new Map<object, number>();
    let maxInFlight = 0;
    proto.query = function (this: object, ...args: unknown[]) {
      const now = (inFlight.get(this) ?? 0) + 1;
      inFlight.set(this, now);
      maxInFlight = Math.max(maxInFlight, now);
      const done = () => inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
      const result = original.apply(this, args);
      if (result instanceof Promise) result.then(done, done);
      return result;
    };

    // Its own server and a brand-new pool, so the very first query applies the session settings.
    // (The embedded engine serves one connection at a time, so it cannot share the other pool's.)
    const own = await startPgWireServer(SCHEMA);
    try {
      const fresh = new PgDatabase({
        connectionString: own.url,
        schema: SCHEMA,
        maxConnections: 1,
        ssl: false,
      });
      await Promise.all([fresh.query('SELECT 1'), fresh.query('SELECT 2')]);
      await fresh.close();
    } finally {
      proto.query = original;
      await own.close();
    }
    expect(maxInFlight).toBe(1);
  });

  it('only accepts a simple schema name (it is placed into a SQL statement)', () => {
    for (const schema of ['x; DROP TABLE users', 'Identity', 'a b', '', '1abc']) {
      expect(
        () =>
          new PgDatabase({ connectionString: server.url, schema, maxConnections: 1, ssl: false }),
      ).toThrow(/Invalid schema name/);
    }
  });
});

describe('real connection failures are classified as transient', () => {
  it('recognises the error the pg driver raises when the database is unreachable', async () => {
    // Port 1 is never listening; the driver raises its real ECONNREFUSED error.
    const db = new PgDatabase({
      connectionString: 'postgres://u:p@127.0.0.1:1/none',
      schema: SCHEMA,
      maxConnections: 1,
      ssl: false,
    });
    const failure = await db.query('SELECT 1').then(
      () => undefined,
      (error: unknown) => error,
    );
    await db.close();

    expect(failure).toBeInstanceOf(Error);
    expect(isTransientDatabaseError(failure)).toBe(true);
  });
});
