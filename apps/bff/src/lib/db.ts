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
  readonly #max: number;

  constructor(opts: DatabaseOptions) {
    this.#max = opts.max;
    this.#pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max,
      // A query with no ceiling is a connection-pool exhaustion vector that
      // takes the whole API down (T10).
      //
      // THESE TWO LINES DO NOTHING IN ANY DEPLOYED ENVIRONMENT, AND THAT IS NOT
      // A REASON TO DELETE THEM. node-postgres puts both into the libpq
      // StartupMessage (`getStartupConf` in pg/lib/client.js), and Neon's proxy
      // discards startup parameters it does not recognise. Measured on
      // 2026-07-29 against the live staging branch with exactly this
      // configuration at 3000 ms:
      //
      //   pooled endpoint  backend reported statement_timeout = 30s (the ROLE
      //                    DEFAULT), pg_sleep(6) ran to completion in 6168 ms
      //   direct endpoint  backend reported 15min (the owner's role default),
      //                    pg_sleep(6) ran to completion in 6150 ms
      //
      // The direct endpoint is not an escape hatch: the same value sent the
      // other legal way, `options=-c statement_timeout=3s`, is REFUSED on both
      // ("unsupported startup parameter in options"). There is no connection-
      // time way for this client to set either GUC on Neon.
      //
      // So the real ceiling is a ROLE DEFAULT, applied out of band by
      // infra/neon/sql/set-role-timeouts.sql and asserted by
      // packages/db/scripts/verify-query-ceilings.mjs. DATABASE_STATEMENT_
      // TIMEOUT_MS cannot tighten the request path; editing that file can.
      //
      // They stay because they are still the control on a deployment with no
      // Neon proxy in front - a bare Postgres, or a future host - and because a
      // pool that asks for a bound it may not get is strictly better than one
      // that never asks. The role default is the guarantee; this is the belt.
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

  /**
   * Runs `fn` against ONE pinned pooled connection, without a transaction.
   *
   * Exists for session-scoped advisory locks, and that is a narrow enough
   * purpose to be worth stating. `pg_try_advisory_lock` without the `_xact_`
   * infix is bound to the SESSION, and on a pool "the session" is whichever
   * connection happened to serve that one query. Taking such a lock through
   * `query` is therefore doubly broken: the lock lands on an arbitrary
   * connection that is immediately returned to the pool, so a later
   * `pg_advisory_unlock` usually runs on a DIFFERENT connection, fails to find
   * the lock, and leaks it for the life of the leaked connection. Meanwhile a
   * concurrent caller handed the same connection re-acquires it successfully,
   * because advisory locks are re-entrant within a session, and the mutual
   * exclusion silently does not exist.
   *
   * The transaction-scoped `advisoryLock` below is the right tool wherever the
   * critical section fits in one transaction, and it should be preferred. This
   * is for the case where it does not: a sweep that makes many outbound HTTP
   * calls cannot hold a transaction open, both because it would pin a
   * connection in `idle in transaction` for minutes and because
   * `idle_in_transaction_session_timeout` is deliberately set and would kill it.
   */
  async withConnection<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Pool occupancy, for `/metrics`.
   *
   * `waiting` is the field that matters and the one a dashboard usually omits.
   * `total` and `idle` can both look comfortable while every caller is queueing
   * behind a slow query, and pool exhaustion presents to a user as latency with
   * no error anywhere - the failure mode Gate 7 asserts does not happen.
   *
   * `max` is reported alongside so saturation is computable from the scrape by
   * itself, without a dashboard having to know how this deployment is
   * configured. That matters more since the database became Neon behind a
   * transaction pooler: this number is now OUR concurrency ceiling, not the
   * server's, and the two are easy to confuse during an incident.
   */
  stats(): { total: number; idle: number; waiting: number; max: number } {
    return {
      total: this.#pool.totalCount,
      idle: this.#pool.idleCount,
      waiting: this.#pool.waitingCount,
      max: this.#max,
    };
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

/**
 * Takes a SESSION-scoped advisory lock, or reports that someone else holds it.
 *
 * `try` rather than a blocking wait, because the caller is a scheduled sweep:
 * an overlapping invocation should decline and let the current one finish, not
 * queue behind it. A cron that piles up waiting is how a periodic job becomes
 * an outage.
 *
 * `client` MUST be a pinned connection from {@link Database.withConnection}.
 * Passing the pool here would take the lock on an arbitrary connection and is
 * the exact bug that method's comment describes.
 */
export async function tryAdvisoryLock(
  client: Queryable,
  namespace: number,
  key: string,
): Promise<boolean> {
  const { rows } = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1, hashtext($2)) AS acquired",
    [namespace, key],
  );
  return rows[0]?.acquired === true;
}

/** Releases {@link tryAdvisoryLock}. Must run on the SAME pinned connection. */
export async function advisoryUnlock(
  client: Queryable,
  namespace: number,
  key: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
    namespace,
    key,
  ]);
}

/** Advisory-lock namespaces, so two features cannot collide on one key space. */
export const LOCK_NAMESPACE = {
  connectionRefresh: 1,
  accountDeletion: 2,
  directoryReap: 3,
  /** Audit-log anonymization and expiry (services/audit-retention.ts). */
  auditRetention: 4,
  /** Idempotency-key and connect-state expiry (services/expiry-sweeper.ts). */
  expirySweep: 5,
  /** Background upstream cache warming (services/cache-warmer.ts). */
  cacheWarm: 6,
  /**
   * The MusicBrainz canonical-dump load (services/mb-canonical-refresh.ts and
   * infra/mb-loader/mb-canonical-load.sh).
   *
   * TWO KEYS live in this namespace and they must stay distinct.
   * `mb:canonical:refresh` is a SESSION lock held by the job for its whole run,
   * so a second scheduled invocation declines. `mb:canonical:swap` is a
   * TRANSACTION lock the loader takes around the table rename, so two loaders
   * cannot interleave a swap. Giving them one key would make the loader block
   * on the job that spawned it, from a different session, forever.
   *
   * The loader is a shell script and takes its lock in SQL, so the namespace
   * number 7 is written literally there. Changing it here without changing
   * infra/mb-loader/mb-canonical-load.sh silently unlocks the swap.
   */
  mbCanonicalRefresh: 7,
} as const;
