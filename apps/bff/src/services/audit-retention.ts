/**
 * Audit-log retention: anonymize on a window, then expire.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `audit_log` (migration 0002) holds `user_id uuid` and `ip inet`, deliberately
 * with NO foreign key so the rows survive the account deletion they record.
 * Nothing ever deleted or rewrote them, so the table was an unbounded store of
 * "internal account identifier plus IP address", which is personal data under
 * GDPR Article 4(1) and fails the storage-limitation principle in Article
 * 5(1)(e) whether or not the account still exists. That is the `[OPEN]` marker
 * blocking publication of legal/privacy-policy.md.
 *
 * Deleting the trail is the wrong fix. A security audit trail a user can erase
 * by deleting their account is worthless in precisely the case it exists for:
 * an attacker who takes over an account, drains it, and deletes it to cover the
 * trail. So the evidence is kept and the IDENTIFIERS are dropped.
 *
 * The full argument, including the legitimate-interest balancing that justifies
 * keeping the rows at all, is docs/compliance/data-retention-policy.md. This
 * file implements section 5 of it.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOWS, AND WHY THEY ARE THOSE NUMBERS
 *
 *   90 days   full fidelity. Long enough that an incident discovered late can
 *             still be scoped, short enough to be a real bound. Past it, a row
 *             is anonymized in place.
 *   30 days   after the account is deleted, rather than immediately. Account
 *             deletion is itself a plausible final step of an account takeover:
 *             under immediate anonymization an attacker who signs in,
 *             exfiltrates a session key, and deletes the account would have
 *             erased the source IP of their own sign-in at the moment they most
 *             wanted it gone. Thirty days is long enough for the victim to
 *             notice through the third-party provider (which is where they
 *             would notice) and report it.
 *   400 days  the anonymized tail. A year-over-year comparison survives, with a
 *             month of slack. After that the row is storage cost, not evidence.
 *
 * ---------------------------------------------------------------------------
 * RANDOM PSEUDONYM, NOT AN HMAC. THIS IS LOAD-BEARING.
 *
 * `subject_pseudonym` is a fresh random UUID generated INSIDE the UPDATE, once
 * per user per batch, and written nowhere else. There is no key, no pepper, and
 * no mapping table, so the transformation cannot be undone by anyone including
 * us. Under Recital 26 the resulting rows are anonymous data outside the scope
 * of the GDPR, which is the whole point.
 *
 * `HMAC(pepper, user_id)` was considered and REJECTED IN WRITING, and the
 * reason is specific to this schema rather than general hash folklore:
 * `deletion_log.deleted_user_id` retains the UUID of every deleted account,
 * permanently and by design, because it is the proof the erasure happened.
 * Anyone holding the pepper and that table could recompute the HMAC for every
 * candidate id and re-identify every anonymized row by brute force over a
 * candidate set of a few thousand. Do not "simplify" this back to a keyed hash.
 *
 * The cost, stated plainly: after anonymization we cannot answer "what did user
 * X do" for a deleted account, including if that user later asks us to. That is
 * the trade, and it is what the rows not being personal data any more buys.
 *
 * ---------------------------------------------------------------------------
 * TWO PLACES THIS DEVIATES FROM THE SPEC, DELIBERATELY
 *
 * 1. THE SPEC'S UPDATE HAS NO PER-ROW AGE PREDICATE, AND MUST.
 *
 *    docs/compliance/data-retention-policy.md section 5.4 selects victims with
 *    `created_at < now() - interval '30 days'` in a CTE and then updates every
 *    row of those users with only `AND a.anonymized_at IS NULL`. It then says
 *    statement 2 is "identical shape" with 90 days.
 *
 *    Applied literally to statement 2 that is a serious bug: a LIVE user who has
 *    one row older than 90 days would have their entire history anonymized,
 *    including yesterday's sign-in. The 90-day window would then bound nothing
 *    at all, and the loss falls on exactly the rows an incident needs.
 *
 *    Applied literally to statement 1 it is a smaller version of the same
 *    problem: a deleted account's rows would be anonymized as soon as the
 *    OLDEST reached 30 days, so the takeover sign-in from three days before the
 *    deletion loses its IP well inside the window written to protect it.
 *
 *    The prose in section 5.2 says what was meant, per row: "on the first job
 *    run after the row reaches 30 days old". Both UPDATEs therefore carry the
 *    same age predicate as their CTE. Anonymizing EARLY is destroying evidence
 *    early, which is the failure this job must not have.
 *
 *    The price is that a user's rows can cross the line on different days and
 *    receive a different pseudonym per batch, so correlation holds within a
 *    batch rather than across a user's whole history. That is unavoidable given
 *    "stored nowhere else": recovering a previously issued pseudonym would
 *    require the mapping that is the thing we refuse to keep.
 *
 * 2. THE HARD DELETE ONLY TOUCHES ROWS THAT ARE ALREADY ANONYMIZED.
 *
 *    The spec's statement 3 deletes on age alone. A 400-day-old row that is NOT
 *    anonymized is a row in an unknown state: it means the anonymizer never
 *    reached it, which is a bug. Deleting it would destroy the evidence AND
 *    erase the only symptom of the bug, because the standing invariant counts
 *    exactly those rows. Anonymization is the privacy control; the 400-day
 *    delete is storage hygiene. So the delete refuses anything the sweep has
 *    not already been over, the backlog is reported instead, and the invariant
 *    stays able to detect a dead anonymizer.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY AND FAILURE
 *
 * Idempotent. Every statement is filtered on the state it sets, so a second run
 * over the same rows matches nothing. Safe to interrupt: statements run in
 * autocommit on one pinned connection rather than inside one transaction, so a
 * killed process leaves committed batches committed and the rest untouched.
 * Bundling the whole sweep in one transaction would be worse in both
 * directions: it would hold a long write transaction against the primary and it
 * would throw away all progress on any failure.
 *
 * Safe to run concurrently, by a Postgres SESSION-scoped advisory lock held on
 * a PINNED connection via `Database.withConnection`. Taking a session lock
 * through the pool lands it on whichever connection served that one query,
 * which is then returned to the pool: the unlock usually runs on a DIFFERENT
 * connection and leaks the lock, while a concurrent caller handed the same
 * connection re-acquires it because advisory locks are re-entrant within a
 * session, and the mutual exclusion silently does not exist.
 *
 * PARTIAL FAILURE LEAVES CONSISTENT STATE, and the reason is structural rather
 * than careful: `audit_log_identity_chk` (migration 0006) makes a half-applied
 * anonymization unrepresentable. A row carrying both a real `user_id` and a
 * pseudonym cannot be stored, so no interrupted batch, no bug here, and no
 * hand-run SQL can produce the one state that would hand an attacker the
 * mapping this design exists to destroy.
 */

import type pg from "pg";

import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
  type Queryable,
} from "../lib/db.js";

/** Advisory-lock key, inside the shared namespace registry in lib/db.ts. */
export const AUDIT_RETENTION_LOCK_KEY = "audit:retention-purge";

export interface AuditRetentionOptions {
  /** Days a row keeps its identifiers. Spec section 5.2. */
  readonly fullFidelityDays: number;
  /** Days after which a DELETED account's rows are anonymized. Per row. */
  readonly postDeletionDays: number;
  /** Days after which an already-anonymized row is hard deleted. */
  readonly hardDeleteDays: number;
  /** Days of inactivity after which `api_tokens.last_used_ip` is cleared. */
  readonly tokenIpDays: number;
  /** Distinct users touched by one anonymization batch. */
  readonly usersPerBatch: number;
  /** Rows touched by one orphan or delete batch. */
  readonly rowsPerBatch: number;
  /**
   * Ceiling on batches per statement per run.
   *
   * A blast-radius and runtime bound, not a throughput knob. A long backlog
   * drains over several runs rather than locking the table once, and a bug that
   * made everything look eligible is capped at a number a human can review.
   */
  readonly maxBatchesPerStatement: number;
  /**
   * Hours without a successful anonymization before the run reports `stale`.
   *
   * This is the only symptom a silently dead scheduler produces: rows past the
   * window pile up while nothing errors anywhere.
   */
  readonly freshnessHours: number;
}

/** Defaults are the numbers in docs/compliance/data-retention-policy.md. */
export const AUDIT_RETENTION_DEFAULTS: AuditRetentionOptions = {
  fullFidelityDays: 90,
  postDeletionDays: 30,
  hardDeleteDays: 400,
  tokenIpDays: 90,
  usersPerBatch: 500,
  rowsPerBatch: 10_000,
  maxBatchesPerStatement: 20,
  freshnessHours: 48,
};

export interface AuditRetentionOutcome {
  /** False when another run held the lock. Not an error. */
  readonly ran: boolean;
  /** Rows anonymized because their account was deleted 30+ days ago. */
  readonly anonymizedDeleted: number;
  /** Rows anonymized because they simply aged past 90 days. */
  readonly anonymizedAged: number;
  /**
   * Rows anonymized that never had a subject (a rejected webhook, a reaped
   * directory record). They carry no user_id and get no pseudonym, but they do
   * carry an `ip`, so they still need the sweep.
   */
  readonly anonymizedOrphan: number;
  readonly hardDeleted: number;
  readonly tokenIpsCleared: number;
  /**
   * The standing invariant, measured AFTER the run: rows past the window that
   * are still not anonymized. Must be 0. Anything else means the sweep could
   * not keep up or could not run.
   */
  readonly pendingBeyondWindow: number;
  /**
   * True when nothing had been anonymized for `freshnessHours` while rows past
   * the window were already pending, measured BEFORE this run did any work.
   */
  readonly stale: boolean;
  /**
   * Statements that could not complete, or completed without reporting how many
   * rows they touched.
   *
   * `pg` reports `rowCount: null` for a statement whose affected-row count it
   * could not determine. Folding that into 0 would make a job that has no idea
   * what it did report a clean run, which for a destructive job is the worst
   * available failure mode.
   */
  readonly failed: number;
  /** True when a statement hit `maxBatchesPerStatement` with work remaining. */
  readonly capped: boolean;
}

/**
 * The outcome of a run that declined the lock. Nothing happened.
 *
 * Note on the SQL below: the `/24` and `/48` truncation is written out at each
 * call site rather than interpolated from a shared constant. No SQL text in
 * this application is assembled by string concatenation (the T05 control), and
 * a retention job is not the place to make the first exception.
 */
const EMPTY: AuditRetentionOutcome = {
  ran: false,
  anonymizedDeleted: 0,
  anonymizedAged: 0,
  anonymizedOrphan: 0,
  hardDeleted: 0,
  tokenIpsCleared: 0,
  pendingBeyondWindow: 0,
  stale: false,
  failed: 0,
  capped: false,
};

/**
 * Anonymizes rows whose account has been deleted for `postDeletionDays`.
 *
 * `deletion_log` already records every deleted account id and `audit_log` has
 * no FK, so the two simply join; no new bookkeeping is required.
 *
 * The pseudonym is minted in `assigned`, once per user, so every row of one
 * user in this batch is correlated with the others. It exists only for the
 * duration of the statement.
 */
const ANONYMIZE_DELETED = `
WITH victims AS (
    SELECT a.user_id
      FROM audit_log a
      JOIN deletion_log d ON d.deleted_user_id = a.user_id
     WHERE a.anonymized_at IS NULL
       AND a.created_at < now() - make_interval(days => $1::int)
     GROUP BY a.user_id
     LIMIT $2::int
),
assigned AS (
    SELECT user_id, gen_random_uuid() AS pseudonym FROM victims
)
UPDATE audit_log a
   SET user_id           = NULL,
       subject_pseudonym = assigned.pseudonym,
       ip                = CASE
                             WHEN a.ip IS NULL     THEN NULL
                             WHEN family(a.ip) = 4 THEN network(set_masklen(a.ip, 24))::inet
                             ELSE                       network(set_masklen(a.ip, 48))::inet
                           END,
       anonymized_at     = now()
  FROM assigned
 WHERE a.user_id = assigned.user_id
   AND a.anonymized_at IS NULL
   AND a.created_at < now() - make_interval(days => $1::int)`;

/**
 * Anonymizes rows that have simply aged past `fullFidelityDays`.
 *
 * Same shape, no join. The per-row age predicate on the UPDATE is what keeps a
 * live user's recent events out of it; see the header.
 */
const ANONYMIZE_AGED = `
WITH victims AS (
    SELECT a.user_id
      FROM audit_log a
     WHERE a.anonymized_at IS NULL
       AND a.user_id IS NOT NULL
       AND a.created_at < now() - make_interval(days => $1::int)
     GROUP BY a.user_id
     LIMIT $2::int
),
assigned AS (
    SELECT user_id, gen_random_uuid() AS pseudonym FROM victims
)
UPDATE audit_log a
   SET user_id           = NULL,
       subject_pseudonym = assigned.pseudonym,
       ip                = CASE
                             WHEN a.ip IS NULL     THEN NULL
                             WHEN family(a.ip) = 4 THEN network(set_masklen(a.ip, 24))::inet
                             ELSE                       network(set_masklen(a.ip, 48))::inet
                           END,
       anonymized_at     = now()
  FROM assigned
 WHERE a.user_id = assigned.user_id
   AND a.anonymized_at IS NULL
   AND a.created_at < now() - make_interval(days => $1::int)`;

/**
 * Anonymizes aged rows that never had a subject.
 *
 * `directory.unverified_reaped`, `webhook.rejected` and the failed magic-link
 * attempts are written with `user_id = NULL`, so neither statement above can
 * ever match them: `a.user_id = assigned.user_id` is never true for NULL. They
 * still carry an `ip`, so without this pass they would sit un-anonymized
 * forever and the standing invariant would be permanently violated.
 *
 * They get NO pseudonym. There is no actor to correlate, and minting one would
 * fabricate a subject rather than protect one. `audit_log_identity_chk` permits
 * exactly this shape.
 */
const ANONYMIZE_ORPHANS = `
UPDATE audit_log a
   SET ip            = CASE
                         WHEN a.ip IS NULL     THEN NULL
                         WHEN family(a.ip) = 4 THEN network(set_masklen(a.ip, 24))::inet
                         ELSE                       network(set_masklen(a.ip, 48))::inet
                       END,
       anonymized_at = now()
 WHERE a.id IN (
     SELECT id FROM audit_log
      WHERE anonymized_at IS NULL
        AND user_id IS NULL
        AND created_at < now() - make_interval(days => $1::int)
      ORDER BY created_at
      LIMIT $2::int
 )`;

/**
 * Hard deletes the anonymized tail.
 *
 * `anonymized_at IS NOT NULL` is the guard the spec does not have. See the
 * header: a 400-day row the sweep never reached is a bug symptom, and deleting
 * it would erase both the evidence and the only signal that the anonymizer
 * stopped working.
 *
 * Batched by primary key rather than by `ctid`. `ctid` moves when a row is
 * updated, so a concurrent anonymization could shift a row out from under a
 * ctid captured a moment earlier; the identity column cannot move.
 */
const HARD_DELETE = `
DELETE FROM audit_log
 WHERE id IN (
     SELECT id FROM audit_log
      WHERE created_at < now() - make_interval(days => $1::int)
        AND anonymized_at IS NOT NULL
      ORDER BY created_at
      LIMIT $2::int
 )`;

/**
 * Expires the personal-API-token last-used IP.
 *
 * The `last_used_at IS NULL` arm covers a row that is internally inconsistent:
 * an IP recorded with no corresponding use. That state can only come from a
 * bug, and this is the one place in these jobs where an unknown state is
 * resolved by scrubbing rather than by skipping. The asymmetry is the reason:
 * scrubbing here REMOVES personal data and destroys nothing that a deletion job
 * would destroy, so failing closed would mean keeping an IP address we cannot
 * even explain.
 */
const EXPIRE_TOKEN_IPS = `
UPDATE api_tokens
   SET last_used_ip = NULL
 WHERE last_used_ip IS NOT NULL
   AND (last_used_at IS NULL OR last_used_at < now() - make_interval(days => $1::int))`;

/**
 * The standing invariant from section 8.5 of the policy, plus the freshness
 * signal from 8.4.
 *
 * The `+ 1` day of slack matches the policy's own query: a row that crossed the
 * 90-day line seconds ago and has not been swept yet is the job working
 * normally, not a violation.
 */
const INVARIANT = `
SELECT (
         SELECT count(*) FROM audit_log
          WHERE anonymized_at IS NULL
            AND created_at < now() - make_interval(days => $1::int + 1)
       )::text AS pending,
       (SELECT max(anonymized_at) FROM audit_log) AS last_anonymized_at`;

/**
 * Rows affected, or null when the driver could not say.
 *
 * `pg` types `rowCount` as `number | null`. Treating null as zero would make a
 * statement that touched an unknown number of rows indistinguishable from one
 * that touched none, and the caller here uses "touched none" as its loop
 * termination condition. A destructive job that stops because it mistook "I do
 * not know" for "there is nothing left" is the failure this guards.
 */
function affected(result: pg.QueryResult): number | null {
  return typeof result.rowCount === "number" ? result.rowCount : null;
}

interface BatchResult {
  readonly rows: number;
  readonly failed: boolean;
  readonly capped: boolean;
}

export class AuditRetention {
  readonly #db: Database;
  readonly #opts: AuditRetentionOptions;

  constructor(db: Database, opts: AuditRetentionOptions) {
    this.#db = db;
    this.#opts = opts;
  }

  /**
   * Runs one sweep.
   *
   * Returns a summary rather than throwing on partial failure, so a scheduler
   * can tell "nothing to do" from "another run is in progress" from "one
   * statement is failing" without parsing an error string. Only a failure to
   * take the connection or the lock propagates, because that is the case where
   * nothing ran at all.
   */
  async run(): Promise<AuditRetentionOutcome> {
    return await this.#db.withConnection(async (locked) => {
      if (
        !(await tryAdvisoryLock(
          locked,
          LOCK_NAMESPACE.auditRetention,
          AUDIT_RETENTION_LOCK_KEY,
        ))
      ) {
        // Another run is in progress. Declining is correct, not an error.
        return EMPTY;
      }
      try {
        return await this.#sweep(locked);
      } finally {
        // Same connection, so this actually finds the lock. Swallowed because a
        // failed unlock must not mask the sweep's own result; the session
        // ending releases it in the worst case.
        await advisoryUnlock(
          locked,
          LOCK_NAMESPACE.auditRetention,
          AUDIT_RETENTION_LOCK_KEY,
        ).catch(() => undefined);
      }
    });
  }

  /**
   * The standing invariant and the freshness signal, without running anything.
   *
   * Exposed so CI and an operator can ask the same question the job asks, which
   * is the point of section 8.5: a retention policy nobody can check is a
   * statement of intent.
   */
  async invariant(
    client: Queryable = this.#db,
  ): Promise<{ pending: number; lastAnonymizedAt: Date | null }> {
    const { rows } = await client.query<{
      pending: string;
      last_anonymized_at: Date | null;
    }>(INVARIANT, [this.#opts.fullFidelityDays]);
    const row = rows[0];
    return {
      // Postgres returns count(*) as bigint, which pg hands back as a string.
      pending: row === undefined ? 0 : Number(row.pending),
      lastAnonymizedAt: row?.last_anonymized_at ?? null,
    };
  }

  /** The sweep proper. Runs only with the advisory lock held. */
  async #sweep(client: pg.PoolClient): Promise<AuditRetentionOutcome> {
    const o = this.#opts;

    // Freshness is measured FIRST, because the sweep below is about to set
    // `anonymized_at = now()` on everything it touches and would otherwise
    // erase the very symptom the alert is looking for.
    const before = await this.invariant(client);
    const staleCutoff = Date.now() - o.freshnessHours * 3_600_000;
    const stale =
      before.pending > 0 &&
      (before.lastAnonymizedAt === null ||
        before.lastAnonymizedAt.getTime() < staleCutoff);

    // Order matters. Deleted accounts are handled before the age-based pass so
    // that a row qualifying under both is anonymized under the deletion rule,
    // and both anonymizations run before the hard delete so a row is never
    // deleted in a state the sweep has not been over.
    const deleted = await this.#batched(client, ANONYMIZE_DELETED, [
      o.postDeletionDays,
      o.usersPerBatch,
    ]);
    const aged = await this.#batched(client, ANONYMIZE_AGED, [
      o.fullFidelityDays,
      o.usersPerBatch,
    ]);
    const orphan = await this.#batched(client, ANONYMIZE_ORPHANS, [
      o.fullFidelityDays,
      o.rowsPerBatch,
    ]);
    const expired = await this.#batched(client, HARD_DELETE, [
      o.hardDeleteDays,
      o.rowsPerBatch,
    ]);

    // Not batched: the predicate is already narrow (a token with an IP and no
    // recent use), the table is bounded by API_TOKEN_MAX_PER_USER per account,
    // and a partial pass would leave an arbitrary subset scrubbed for no gain.
    let tokenIpsCleared = 0;
    let tokenFailed = 0;
    try {
      const result = await client.query(EXPIRE_TOKEN_IPS, [o.tokenIpDays]);
      const count = affected(result);
      if (count === null) tokenFailed = 1;
      else tokenIpsCleared = count;
    } catch {
      tokenFailed = 1;
    }

    // Measured AFTER, so it reflects the state this run leaves behind. A
    // nonzero value is the alert.
    const after = await this.invariant(client);

    return {
      ran: true,
      anonymizedDeleted: deleted.rows,
      anonymizedAged: aged.rows,
      anonymizedOrphan: orphan.rows,
      hardDeleted: expired.rows,
      tokenIpsCleared,
      pendingBeyondWindow: after.pending,
      stale,
      failed:
        (deleted.failed ? 1 : 0) +
        (aged.failed ? 1 : 0) +
        (orphan.failed ? 1 : 0) +
        (expired.failed ? 1 : 0) +
        tokenFailed,
      capped: deleted.capped || aged.capped || orphan.capped || expired.capped,
    };
  }

  /**
   * Runs one statement in batches until it stops matching rows.
   *
   * Each batch is its own autocommit statement, so an interrupted run keeps the
   * batches it already committed. A failure stops THIS statement and is
   * reported; it does not abort the sweep, because the remaining statements
   * operate on disjoint predicates and refusing to run them would let one
   * stuck window hold up every other.
   */
  async #batched(
    client: pg.PoolClient,
    sql: string,
    params: number[],
  ): Promise<BatchResult> {
    let rows = 0;
    for (let batch = 0; batch < this.#opts.maxBatchesPerStatement; batch += 1) {
      let count: number | null;
      try {
        count = affected(await client.query(sql, params));
      } catch {
        return { rows, failed: true, capped: false };
      }
      // Unknown is not zero. Stop and report rather than assume the backlog is
      // drained, which would silently leave personal data in place.
      if (count === null) return { rows, failed: true, capped: false };
      rows += count;
      if (count === 0) return { rows, failed: false, capped: false };
    }
    // The last batch was still doing work when the ceiling was reached, so
    // there is more to do on the next run.
    return { rows, failed: false, capped: true };
  }
}
