import { Pool, type PoolClient, type PoolConfig } from 'pg';

export interface QueryResult<Row> {
  readonly rows: Row[];
  /** Rows affected (INSERT, UPDATE, DELETE) or returned (SELECT). */
  readonly rowCount: number;
}

/** The smallest SQL surface the repositories need. Both `pg` and PGlite can provide it. */
export interface Queryable {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /** Runs a script with several statements and no parameters (migrations). */
  exec(script: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Commits when `work` resolves and rolls back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(name: string): string {
  if (!SCHEMA_NAME.test(name)) throw new Error('Invalid schema name');
  return name;
}

function wrap(client: Pick<PoolClient, 'query'>): Queryable {
  return {
    async query(text, params) {
      const result = await client.query(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows as never, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(script) {
      await client.query(script);
    },
  };
}

export interface PgDatabaseOptions {
  readonly connectionString: string;
  readonly schema: string;
  readonly maxConnections: number;
  readonly ssl: boolean;
}

/** PostgreSQL through a connection pool. Each service connects as its own database user. */
export class PgDatabase implements Database {
  private readonly pool: Pool;
  private readonly sessionSettings: string;
  /** Clients whose session settings are already applied. */
  private readonly configured = new WeakSet<PoolClient>();

  constructor(options: PgDatabaseOptions) {
    // Validated first: the name is placed into a SQL statement, and a bad one must fail before
    // any pool exists.
    const schema = assertSchemaName(options.schema);
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.maxConnections,
      // RDS requires TLS. Certificate verification stays on: the RDS CA bundle ships in the image.
      ssl: options.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    };
    this.pool = new Pool(config);

    // Per-session settings are applied with SET, not through the `options` startup parameter:
    // connection poolers such as RDS Proxy and PgBouncer reject or drop that parameter. Everything
    // runs inside the service's own schema, with bounded statement and idle-in-transaction times
    // so a stuck query cannot hold locks or connections indefinitely.
    this.sessionSettings = [
      `SET search_path TO ${schema}`,
      'SET statement_timeout TO 10000',
      'SET idle_in_transaction_session_timeout TO 15000',
    ].join('; ');

    // An idle client erroring (for example the server restarting) must not crash the process.
    this.pool.on('error', () => undefined);
  }

  /**
   * Checks a client out and makes sure its session settings are applied before anyone uses it.
   * This is awaited rather than fired from the pool's 'connect' event: overlapping queries on one
   * client are deprecated in node-postgres and an error from version 9.
   */
  private async acquire(): Promise<PoolClient> {
    const client = await this.pool.connect();
    if (!this.configured.has(client)) {
      try {
        await client.query(this.sessionSettings);
        this.configured.add(client);
      } catch (error) {
        // A connection that cannot take its settings must not serve queries against the wrong
        // schema: destroy it instead of returning it to the pool.
        client.release(error instanceof Error ? error : new Error('session setup failed'));
        throw error;
      }
    }
    return client;
  }

  async query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const client = await this.acquire();
    try {
      return await wrap(client).query<Row>(text, params);
    } finally {
      client.release();
    }
  }

  async exec(script: string): Promise<void> {
    const client = await this.acquire();
    try {
      await wrap(client).exec(script);
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    try {
      await client.query('BEGIN');
      const result = await work(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; the original error is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const TRANSIENT_NODE_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);
const TRANSIENT_MESSAGES = [
  'connection terminated',
  'timeout exceeded when trying to connect', // pool exhausted or database unreachable
  'connection timeout',
];

/**
 * True for failures where retrying shortly is the right response: the database is unreachable,
 * restarting, overloaded, or cancelled a statement. Code bugs and constraint violations are not
 * transient and must stay 500s.
 *
 * SQLSTATE: class 08 connection exception, 53 insufficient resources (for example too many
 * connections), 57P01-57P03 shutdown/startup, 57014 statement timeout, 40001/40P01 serialisation
 * failure and deadlock.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };

  if (typeof code === 'string') {
    if (TRANSIENT_NODE_ERRORS.has(code)) return true;
    if (code.startsWith('08') || code.startsWith('53')) return true;
    if (['57P01', '57P02', '57P03', '57014', '40001', '40P01'].includes(code)) return true;
  }
  if (typeof message === 'string') {
    const lowered = message.toLowerCase();
    return TRANSIENT_MESSAGES.some((fragment) => lowered.includes(fragment));
  }
  return false;
}
