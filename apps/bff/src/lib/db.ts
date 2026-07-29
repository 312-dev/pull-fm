/**
 * Postgres access.
 *
 * Thin on purpose. There is no ORM and there will not be one, for two reasons
 * this project cares about more than ergonomics:
 *
 *   1. THREAT-MODEL T07: an ORM that logs bound parameters puts credentials and
 *      the values used to derive them into the same trust boundary as the query
 *      log. Owning the query layer means owning what is loggable.
 *   2. THREAT-MODEL M11: every user-owned read and write must carry an
 *      ownership predicate in the SAME statement as the id predicate. That is a
 *      property of the SQL text, and it is far easier to review, grep, and
 *      test when the SQL text is visible in the repository.
 *
 * Every call site uses parameterised queries. There is no string interpolation
 * into SQL anywhere in this application, which is the T05 control.
 */

import pg from "pg";

/**
 * The narrow query surface everything in this application uses.
 *
 * Declared here rather than taken from `pg.PoolClient` so a service can accept
 * either the pool or a transaction client without knowing which. That is what
 * lets the idempotency claim and the write it guards share one transaction: the
 * same function is called with a pool for a standalone read and with a client
 * inside a transaction for a write.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly statementTimeoutMs: number;
}

/**
 * Owns the connection pool.
 *
 * Pool sizing is deliberately small (see config): concurrency is absorbed by
 * PgBouncer in transaction mode, and every BFF node multiplies into the
 * server's `max_connections`.
 */
export class Database implements Queryable {
  readonly #pool: pg.Pool;

  constructor(opts: DatabaseOptions) {
    this.#pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max,
      // A query with no ceiling is a connection-pool exhaustion vector that
      // takes the whole API down (T10). Set on the server side so it applies
      // even to a query issued outside this class.
      statement_timeout: opts.statementTimeoutMs,
      idle_in_transaction_session_timeout: opts.statementTimeoutMs,
      // PgBouncer in transaction mode cannot hold a session-level prepared
      // statement, so the driver must not create any.
      allowExitOnIdle: true,
    });

    // An idle client erroring (a server restart, a PgBouncer bounce) emits on
    // the pool. Without a listener Node treats it as an unhandled 'error' event
    // and terminates the process.
    this.#pool.on("error", () => {
      /* handled by the caller's next query failing; nothing to do here */
    });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.#pool.query<R>(text, values as unknown[]);
  }

  /**
   * Runs `fn` inside a transaction, rolling back on any throw.
   *
   * Used where a multi-statement operation must be all-or-nothing: account
   * deletion, token rotation, and idempotent writes. A partially applied
   * deletion is a GDPR problem, not merely a bug.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the connection is already broken; releasing it is the only recovery */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Liveness probe for /readyz. Deliberately trivial. */
  async healthy(): Promise<boolean> {
    try {
      await this.#pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * Takes a transaction-scoped advisory lock.
 *
 * Required for the credential refresh path: providers rotate refresh tokens, so
 * two concurrent refreshes for the same connection lock the user out of their
 * third-party account permanently (docs/PLAN.md section 5). The lock is
 * transaction-scoped so it is released by COMMIT or ROLLBACK and cannot be
 * leaked by an early return.
 */
export async function advisoryLock(
  client: Queryable,
  namespace: number,
  key: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    namespace,
    key,
  ]);
}

/** Advisory-lock namespaces, so two features cannot collide on one key space. */
export const LOCK_NAMESPACE = {
  connectionRefresh: 1,
  accountDeletion: 2,
} as const;
