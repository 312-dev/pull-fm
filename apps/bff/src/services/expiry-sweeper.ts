/**
 * Deletes rows from the two tables that declare an expiry nothing enforces.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `idempotency_keys.expires_at` defaults to `now() + interval '24 hours'` and
 * `connect_states.expires_at` is minutes away, but the schema was verified
 * against the code and BOTH expiries are applied ON READ ONLY:
 *
 *   apps/bff/src/lib/idempotency.ts        WHERE user_id = $1 AND key = $2
 *                                            AND expires_at > now()
 *   apps/bff/src/services/connections.ts   AND expires_at > now()
 *
 * No `DELETE` anywhere in the application removes an expired row. The only
 * DELETE against `idempotency_keys` is `release()`, which drops a claim whose
 * operation failed, and the only one against `connect_states` is the
 * `DELETE ... RETURNING` that consumes a state exactly once. An expired row is
 * therefore INVISIBLE to the application and STILL PRESENT in the table, for
 * the life of the account.
 *
 * For `connect_states` that is a small privacy cost: a subject id, a provider
 * name, and a redirect URI.
 *
 * For `idempotency_keys` it is not small. `response_body jsonb` holds a
 * VERBATIM COPY OF AN API RESPONSE. For account operations that includes the
 * email address and display name; for wishlist writes it includes the user's
 * free-text note. Those copies are bounded by the life of the account, because
 * the foreign key cascades, but they are NOT bounded by the 24 hours the schema
 * advertises and the privacy policy states. Until this job runs, the sentence
 * "Idempotency records: 24 hours, enforced by the schema" is false as written:
 * the schema enforces 24 hours of VALIDITY, not 24 hours of STORAGE.
 *
 * ---------------------------------------------------------------------------
 * THE HOUR OF SLACK
 *
 * A row is deleted an hour AFTER it expires, not at expiry. The BFF and the
 * database do not share a clock, and this job must never be able to delete a
 * row that an in-flight request still considers valid: doing so would turn a
 * retried mutation into a second execution, which is the exact thing the
 * idempotency header exists to prevent. An hour is far beyond any plausible
 * skew between two hosts running NTP, and the cost of the slack is one extra
 * hour of storage on a row nobody can read.
 *
 * ---------------------------------------------------------------------------
 * SEPARATE FROM THE AUDIT PURGE, ON PURPOSE
 *
 * docs/compliance/data-retention-policy.md bundles these two statements into
 * the audit purge as its "statement 4". They are split here because they have
 * different CADENCES and different blast radii. The audit purge is a daily job
 * that rewrites identifiers under a 90-day window; this is an hourly job whose
 * whole point is that an expired idempotency record should not survive the day
 * the schema promises. Running the audit purge hourly to get this would mean
 * running a destructive rewrite twenty-four times as often for no benefit, and
 * running this daily would leave the 24-hour promise unmet by up to a day.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DELETE
 *
 *   - A row with no expiry. Both columns are `NOT NULL` today, so the
 *     `expires_at IS NOT NULL` predicate matches everything; it is written
 *     anyway because an unknown expiry must mean SKIP, and a later migration
 *     that relaxed the column should not silently turn this job into one that
 *     deletes every row it cannot date.
 *   - A row inside its expiry, or inside the hour of slack after it.
 *   - Anything at all, if the driver will not say how many rows a statement
 *     touched. See `affected`.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY AND FAILURE
 *
 * Idempotent: the predicate is the state, so a second run over the same rows
 * matches nothing. Safe to interrupt: each batch is its own autocommit
 * statement, so a killed process keeps the batches it committed.
 *
 * Safe to run concurrently, by a SESSION-scoped advisory lock on a PINNED
 * connection from `Database.withConnection`. A session lock taken through the
 * pool lands on an arbitrary connection which is then returned, so the unlock
 * runs elsewhere and leaks the lock while a concurrent caller handed the same
 * connection re-acquires it (advisory locks are re-entrant within a session)
 * and the exclusion silently does not exist.
 *
 * Failure leaves consistent state trivially: each row is deleted or it is not,
 * both tables are independent, and nothing else is written. A failure on one
 * table does not stop the other, because the two are unrelated and letting a
 * stuck `connect_states` hold up the table that actually holds email addresses
 * would be the wrong trade.
 */

import type pg from "pg";

import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
} from "../lib/db.js";
import { intFromEnv } from "../lib/job-env.js";

/** Advisory-lock key, inside the shared namespace registry in lib/db.ts. */
export const EXPIRY_SWEEP_LOCK_KEY = "retention:expiry-sweep";

export interface ExpirySweeperOptions {
  /**
   * Seconds a row survives past its own `expires_at`.
   *
   * Slack against clock skew between the BFF and the database, never a
   * retention extension. See the header.
   */
  readonly slackSeconds: number;
  /** Rows deleted per statement, so no batch holds a long lock. */
  readonly rowsPerBatch: number;
  /** Ceiling on batches per table per run. A backlog drains over several runs. */
  readonly maxBatchesPerTable: number;
}

export const EXPIRY_SWEEPER_DEFAULTS: ExpirySweeperOptions = {
  slackSeconds: 3600,
  rowsPerBatch: 5000,
  maxBatchesPerTable: 20,
};

/**
 * Resolves the options from the environment, falling back to the defaults.
 *
 * Lives beside the defaults rather than in `wiring.ts` so the variable names
 * and the numbers they override are one screen apart. See lib/job-env.ts for
 * why these are not in `config.ts`, and note the reader THROWS on a value that
 * is present but not a positive integer: a silently ignored override on a job
 * that deletes rows is how a stated retention window quietly stops being true.
 */
export function expirySweeperOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExpirySweeperOptions {
  const d = EXPIRY_SWEEPER_DEFAULTS;
  return {
    slackSeconds: intFromEnv("EXPIRY_SWEEP_SLACK_S", d.slackSeconds, env),
    rowsPerBatch: intFromEnv(
      "EXPIRY_SWEEP_ROWS_PER_BATCH",
      d.rowsPerBatch,
      env,
    ),
    maxBatchesPerTable: intFromEnv(
      "EXPIRY_SWEEP_MAX_BATCHES",
      d.maxBatchesPerTable,
      env,
    ),
  };
}

export interface ExpirySweepOutcome {
  /** False when another run held the lock. Not an error. */
  readonly ran: boolean;
  readonly idempotencyKeysDeleted: number;
  readonly connectStatesDeleted: number;
  /**
   * Tables whose sweep could not complete, or completed without reporting how
   * many rows it touched. Never folded into a zero; see `affected`.
   */
  readonly failed: number;
  /** True when a table hit `maxBatchesPerTable` with work remaining. */
  readonly capped: boolean;
}

const EMPTY: ExpirySweepOutcome = {
  ran: false,
  idempotencyKeysDeleted: 0,
  connectStatesDeleted: 0,
  failed: 0,
  capped: false,
};

/**
 * Deletes expired idempotency records, oldest first.
 *
 * Batched through the primary key `(user_id, key)` rather than by `ctid`,
 * because `release()` and the cascade can delete rows concurrently and a `ctid`
 * captured a moment earlier can name a different row by the time the DELETE
 * runs. Naming the key cannot go wrong that way.
 */
const DELETE_IDEMPOTENCY = `
DELETE FROM idempotency_keys t
 USING (
     SELECT user_id, key
       FROM idempotency_keys
      WHERE expires_at IS NOT NULL
        AND expires_at < now() - make_interval(secs => $1::int)
      ORDER BY expires_at
      LIMIT $2::int
 ) doomed
 WHERE t.user_id = doomed.user_id
   AND t.key     = doomed.key`;

/** Deletes expired connect states. Same shape, primary key `state_hash`. */
const DELETE_CONNECT_STATES = `
DELETE FROM connect_states t
 USING (
     SELECT state_hash
       FROM connect_states
      WHERE expires_at IS NOT NULL
        AND expires_at < now() - make_interval(secs => $1::int)
      ORDER BY expires_at
      LIMIT $2::int
 ) doomed
 WHERE t.state_hash = doomed.state_hash`;

/**
 * Rows affected, or null when the driver could not say.
 *
 * `pg` types `rowCount` as `number | null`. Folding null into zero would make a
 * DELETE that removed an unknown number of rows look identical to one that
 * removed none, and "removed none" is this job's loop-termination condition. A
 * deletion job that stops because it mistook "I do not know" for "there is
 * nothing left" reports a clean run over a backlog it never touched.
 */
function affected(result: pg.QueryResult): number | null {
  return typeof result.rowCount === "number" ? result.rowCount : null;
}

interface TableResult {
  readonly rows: number;
  readonly failed: boolean;
  readonly capped: boolean;
}

export class ExpirySweeper {
  readonly #db: Database;
  readonly #opts: ExpirySweeperOptions;

  constructor(db: Database, opts: ExpirySweeperOptions) {
    this.#db = db;
    this.#opts = opts;
  }

  /**
   * Runs one sweep.
   *
   * Returns a summary rather than throwing, so a scheduler can distinguish
   * "nothing to do", "another run holds the lock", and "a table is failing"
   * without parsing an error string. Only a failure to take the connection or
   * the lock propagates, because that is the case where nothing ran at all.
   */
  async run(): Promise<ExpirySweepOutcome> {
    return await this.#db.withConnection(async (locked) => {
      if (
        !(await tryAdvisoryLock(
          locked,
          LOCK_NAMESPACE.expirySweep,
          EXPIRY_SWEEP_LOCK_KEY,
        ))
      ) {
        return EMPTY;
      }
      try {
        // Idempotency keys first. That is the table that holds copies of API
        // responses containing email addresses, display names, and wishlist
        // notes; connect states hold a provider name and a redirect URI. If
        // only one of the two gets done, it should be the one that matters.
        const idempotency = await this.#sweepTable(locked, DELETE_IDEMPOTENCY);
        const states = await this.#sweepTable(locked, DELETE_CONNECT_STATES);

        return {
          ran: true,
          idempotencyKeysDeleted: idempotency.rows,
          connectStatesDeleted: states.rows,
          failed: (idempotency.failed ? 1 : 0) + (states.failed ? 1 : 0),
          capped: idempotency.capped || states.capped,
        };
      } finally {
        await advisoryUnlock(
          locked,
          LOCK_NAMESPACE.expirySweep,
          EXPIRY_SWEEP_LOCK_KEY,
        ).catch(() => undefined);
      }
    });
  }

  async #sweepTable(client: pg.PoolClient, sql: string): Promise<TableResult> {
    let rows = 0;
    for (let batch = 0; batch < this.#opts.maxBatchesPerTable; batch += 1) {
      let count: number | null;
      try {
        count = affected(
          await client.query(sql, [
            this.#opts.slackSeconds,
            this.#opts.rowsPerBatch,
          ]),
        );
      } catch {
        return { rows, failed: true, capped: false };
      }
      if (count === null) return { rows, failed: true, capped: false };
      rows += count;
      if (count === 0) return { rows, failed: false, capped: false };
    }
    return { rows, failed: false, capped: true };
  }
}
