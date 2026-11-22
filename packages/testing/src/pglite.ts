import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Database, Queryable } from '@teampulse/db';

function wrap(client: Pick<PGlite, 'query' | 'exec'>): Queryable {
  return {
    async query(text, params) {
      const result = await client.query(text, params === undefined ? undefined : [...params]);
      return {
        rows: result.rows as never,
        // Match node-postgres: rows returned for SELECT/RETURNING, rows affected otherwise.
        rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0),
      };
    },
    async exec(script) {
      await client.exec(script);
    },
  };
}

/**
 * Real PostgreSQL (compiled to WebAssembly) running inside the test process. It lets the SQL
 * repositories be tested against an actual Postgres engine with no Docker and no server.
 */
export class PgliteDatabase implements Database {
  private readonly pg = new PGlite();
  private readonly executor = wrap(this.pg);

  query: Queryable['query'] = (text, params) => this.executor.query(text, params);
  exec: Queryable['exec'] = (script) => this.executor.exec(script);

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction((tx) => work(wrap(tx)));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

export interface PgWireServer {
  /** Connection string for the real `pg` driver. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serves an embedded PostgreSQL over the real wire protocol on a local port, so tests can exercise
 * the production `PgDatabase` class and the `pg` driver itself. The engine handles one connection
 * at a time: connect with a pool of one. `schema` is created up front, as the infrastructure code
 * will do for each service.
 */
export async function startPgWireServer(schema: string): Promise<PgWireServer> {
  const engine = await PGlite.create();
  await engine.exec(`CREATE SCHEMA ${schema}`);
  const server = new PGLiteSocketServer({ db: engine, port: 0, host: '127.0.0.1' });
  await server.start();
  return {
    url: `postgres://postgres:postgres@${server.getServerConn()}/postgres`,
    close: async () => {
      await server.stop();
      await engine.close();
    },
  };
}
