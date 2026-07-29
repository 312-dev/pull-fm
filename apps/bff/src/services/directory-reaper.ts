/**
 * Deletes WorkOS directory records that were auto-created and never verified.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `POST /user_management/magic_auth/send` CREATES a WorkOS user when the
 * address it is given does not already have one, with `email_verified: false`,
 * and answers 200. That was verified against the live API on 2026-07-29, not
 * inferred from documentation. See the comment on
 * `WorkOsClient.sendMagicAuthCode`.
 *
 * `POST /v1/auth/start` is unauthenticated, so that behaviour means anyone can
 * cause a directory record to exist for any address they can type. Two problems
 * follow, and the second is the serious one:
 *
 *   Pollution   the directory fills with junk, and "how many users does Pull.fm
 *               have" stops being answerable.
 *
 *   Lawful basis
 *               we would be creating and holding a personal-data record, an
 *               email address, for a person who never consented and has no
 *               relationship with the service. There is no lawful basis for
 *               that under GDPR Article 6, and unlike a retention gap on our
 *               own users it affects people who are not users at all and who
 *               would have no reason to look for us to exercise a right.
 *
 * The send budgets in services/magic-auth.ts bound the RATE at which that can
 * happen. This bounds the DURATION. Neither alone is sufficient: a slow
 * attacker defeats the rate limit given time, and a fast one defeats a
 * retention window given none.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT DELETE
 *
 * A record is reaped only when ALL FOUR of these hold. Every one of them is a
 * separate reason to leave a record alone, and the conjunction is deliberate:
 * this job deletes identities, so it should be hard to persuade.
 *
 *   1. WorkOS reports `email_verified === false`, strictly. This is the
 *      VERIFICATION STATE, which is the key the operator asked for, and it is
 *      what makes the job safe: a person who has completed a sign-in has
 *      `email_verified: true` and is therefore invisible to this code no
 *      matter how old the record is or what our own database says.
 *   2. The record has a parseable `created_at` older than the window.
 *   3. We hold no `users` row for that WorkOS id, INCLUDING a soft-deleted one.
 *      This is the belt to the braces of rule 1. A local row means a real
 *      person completed a sign-in at some point, and no combination of a
 *      response-shape change and a clock problem should be able to delete them.
 *   4. Nothing about the record is unknown. An absent `email_verified` or an
 *      unparseable `created_at` means SKIP, never delete. Fail closed, because
 *      the failure modes are not symmetric: skipping leaves a junk record for
 *      another day, deleting wrongly destroys somebody's account.
 *
 * ---------------------------------------------------------------------------
 * WHY 24 HOURS
 *
 * The window has to clear the longest legitimate gap between a record being
 * created and the same person verifying, and it should otherwise be as short as
 * possible, because its whole purpose is to bound how long an unconsented
 * record exists.
 *
 * The lower bound is set by the flow: a Magic Auth code lives for 10 minutes,
 * so anybody still holding a usable code is inside 10 minutes by definition.
 * The realistic gap is longer than that, because a person requests a code,
 * cannot find the mail, goes to look on another device, and asks for a fresh
 * one. 24 hours is roughly two orders of magnitude above the code lifetime,
 * which comfortably covers "requested it before lunch, finished after".
 *
 * The upper bound is that an unconsented record should not outlive a day.
 *
 * What makes a short window safe is that reaping is NOT DESTRUCTIVE HERE, and
 * this is the load-bearing observation. Because a send auto-creates, deleting
 * an unverified record has no user-visible effect at all: the next
 * `POST /v1/auth/start` for that address simply creates it again. The cost of
 * reaping a record one minute too early is that a subsequent send makes a new
 * one. The cost of NOT reaping is an unconsented personal-data record. Those
 * are not comparable, which is why the window errs short rather than long.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY AND FAILURE
 *
 * Idempotent. Deleting an already-deleted user is a 404, which
 * `WorkOsClient.deleteUser` already treats as success, so a re-run over the
 * same directory converges rather than erroring.
 *
 * Safe to run concurrently. A Postgres advisory lock means a second invocation
 * declines to start rather than racing the first. `pg_try_advisory_lock` rather
 * than `pg_advisory_lock`, so an overlapping run exits immediately instead of
 * queueing behind a run that may be about to time out; a scheduled job that
 * silently piles up is how a cron becomes an outage.
 *
 * The lock is held on a PINNED connection for the whole sweep, via
 * `Database.withConnection`. That is not a detail. A session-scoped advisory
 * lock taken through the pool lands on whichever connection served the query
 * and is then returned to the pool, so the unlock usually runs on a different
 * connection and leaks the lock, while a concurrent caller handed the same
 * connection re-acquires it successfully because advisory locks are re-entrant
 * within a session. The mutual exclusion then silently does not exist. The
 * transaction-scoped variant used elsewhere in this codebase is unavailable
 * here, because a sweep makes many outbound HTTP calls and cannot hold a
 * transaction open under `idle_in_transaction_session_timeout`.
 *
 * Failure leaves state consistent, and it is worth being precise about why
 * rather than asserting it. This job performs NO local writes at all except
 * best-effort audit rows. It does not delete, mark, or update a single
 * application row, so there is no local state that a partial run can leave
 * inconsistent and no possibility of orphaning a real account by half-finishing.
 * Concretely:
 *
 *   - Listing fails      -> abort with zero deletions. A directory we cannot
 *                           enumerate is one we must not act on.
 *   - One delete fails   -> counted, logged, and the run continues. The record
 *                           is still unverified and still older than the
 *                           window, so the next run retries it. Aborting the
 *                           whole sweep because one identity was stubborn would
 *                           let one bad record protect every other.
 *   - Process dies       -> the advisory lock is released by the session
 *                           ending, and whatever was already deleted stays
 *                           deleted. Both correct.
 */

import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
} from "../lib/db.js";
import type { AuditLog } from "../lib/audit.js";
import type { WorkOsClient, WorkOsUser } from "./workos.js";

export interface DirectoryReaperOptions {
  /** How long an unverified record may live before it is eligible. */
  readonly reapAfterSeconds: number;
  /** Users requested per WorkOS page. */
  readonly pageSize: number;
  /**
   * Ceiling on deletions in one run.
   *
   * A blast-radius bound, not a performance tuning knob. If a bug or a
   * response-shape change ever made this job consider everything eligible, the
   * damage is capped at this many identities and the next run is a decision a
   * human gets to make. An uncapped destructive sweep is one bad deploy away
   * from deleting a user base.
   */
  readonly maxDeletionsPerRun: number;
  /** Ceiling on pages walked, so a huge directory cannot run unbounded. */
  readonly maxPagesPerRun: number;
}

export interface ReapOutcome {
  /** False when another run held the lock. Not an error. */
  readonly ran: boolean;
  readonly examined: number;
  readonly deleted: number;
  /** Eligible but refused because the cap was reached. */
  readonly capped: number;
  /** Deletion attempts WorkOS rejected. Retried on the next run. */
  readonly failed: number;
  /**
   * Records skipped because something about them was unknown.
   *
   * Surfaced rather than swallowed: a nonzero value here means WorkOS stopped
   * returning a field we depend on, and the job would otherwise report a clean
   * run while quietly doing nothing.
   */
  readonly skippedUnknown: number;
}

/**
 * Advisory lock key, inside the shared namespace registry in lib/db.ts.
 *
 * Registered there rather than picked as a bare constant here, so two features
 * cannot silently collide on one key space.
 */
export const REAP_LOCK_KEY = "directory:unverified-sweep";

export class DirectoryReaper {
  readonly #db: Database;
  readonly #workos: WorkOsClient;
  readonly #audit: AuditLog;
  readonly #opts: DirectoryReaperOptions;

  constructor(
    db: Database,
    workos: WorkOsClient,
    audit: AuditLog,
    opts: DirectoryReaperOptions,
  ) {
    this.#db = db;
    this.#workos = workos;
    this.#audit = audit;
    this.#opts = opts;
  }

  /**
   * Decides whether one directory record is eligible.
   *
   * Pure and exported through the class for testing, because this predicate is
   * the whole safety property of the job and deserves to be assertable without
   * standing up a directory.
   */
  static eligible(
    user: WorkOsUser,
    cutoff: Date,
  ): {
    eligible: boolean;
    reason: "verified" | "recent" | "unknown" | "eligible";
  } {
    // Rule 1. Strictly false, so null (the field was absent) is NOT eligible.
    if (user.emailVerified !== false) {
      return {
        eligible: false,
        reason: user.emailVerified === true ? "verified" : "unknown",
      };
    }

    // Rule 4, for the timestamp. An unparseable date is unknown, not old.
    if (user.createdAt === null) {
      return { eligible: false, reason: "unknown" };
    }
    const createdAt = new Date(user.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return { eligible: false, reason: "unknown" };
    }

    // Rule 2.
    if (createdAt >= cutoff) return { eligible: false, reason: "recent" };

    return { eligible: true, reason: "eligible" };
  }

  /**
   * Rule 3: does a local row exist for this WorkOS id?
   *
   * Deliberately WITHOUT `deleted_at IS NULL`. Every other query in this
   * application scopes to live rows; this one must not. A soft-deleted row is
   * evidence that a real person once completed a sign-in, and that is exactly
   * the case where deleting the upstream identity on age alone would be worst.
   */
  async #hasLocalRecord(workosUserId: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ present: boolean }>(
      `SELECT true AS present FROM users WHERE workos_user_id = $1 LIMIT 1`,
      [workosUserId],
    );
    return rows.length > 0;
  }

  /**
   * Runs one sweep.
   *
   * Returns a summary rather than throwing on partial failure, so a scheduler
   * can distinguish "nothing to do", "another run is in progress", and "the
   * identity provider is refusing deletions" without parsing an error string.
   * A failure to LIST still throws, because that is the one case where
   * continuing would mean acting on an unknown directory.
   */
  async run(now = new Date()): Promise<ReapOutcome> {
    const empty: ReapOutcome = {
      ran: false,
      examined: 0,
      deleted: 0,
      capped: 0,
      failed: 0,
      skippedUnknown: 0,
    };

    // The lock is held on ONE pinned connection for the whole sweep. See the
    // comment on Database.withConnection for why taking it through the pool
    // would produce a lock that does not exclude anything.
    return await this.#db.withConnection(async (locked) => {
      if (
        !(await tryAdvisoryLock(
          locked,
          LOCK_NAMESPACE.directoryReap,
          REAP_LOCK_KEY,
        ))
      ) {
        // Another sweep is in progress. Declining is the correct outcome, not
        // an error, so the scheduler is not paged for working as designed.
        return empty;
      }

      try {
        return await this.#sweep(now);
      } finally {
        // Same connection, so this actually finds the lock. Swallowed because a
        // failure to unlock must not mask the sweep's own result; the lock is
        // released by the session ending in the worst case.
        await advisoryUnlock(
          locked,
          LOCK_NAMESPACE.directoryReap,
          REAP_LOCK_KEY,
        ).catch(() => undefined);
      }
    });
  }

  /** The sweep proper. Runs only with the advisory lock held. */
  async #sweep(now: Date): Promise<ReapOutcome> {
    const cutoff = new Date(now.getTime() - this.#opts.reapAfterSeconds * 1000);

    let examined = 0;
    let deleted = 0;
    let capped = 0;
    let failed = 0;
    let skippedUnknown = 0;

    {
      let after: string | null = null;
      for (let page = 0; page < this.#opts.maxPagesPerRun; page += 1) {
        // A listing failure propagates: zero deletions have happened at this
        // point on the first page, and on a later page the deletions already
        // made are individually correct and independently justified.
        const result = await this.#workos.listUsers({
          limit: this.#opts.pageSize,
          after,
        });

        for (const user of result.users) {
          examined += 1;
          const verdict = DirectoryReaper.eligible(user, cutoff);
          if (verdict.reason === "unknown") skippedUnknown += 1;
          if (!verdict.eligible) continue;

          // Rule 3, checked per candidate rather than by pre-loading every
          // local id: the candidate set is small by construction (only
          // unverified records past the window reach here) and a full table
          // scan of `users` on a schedule is a worse trade.
          if (await this.#hasLocalRecord(user.id)) continue;

          if (deleted >= this.#opts.maxDeletionsPerRun) {
            capped += 1;
            continue;
          }

          // `deleteUser` REPORTS rather than throws: it returns false for a
          // status it does not accept, and true for 2xx or a 404 that means
          // the identity is already gone. Both halves have to be handled, and
          // an earlier draft of this loop checked only for a thrown error,
          // which counted every refused deletion as a success. A destructive
          // job that reports work it did not do is worse than one that fails.
          let removed = false;
          try {
            removed = await this.#workos.deleteUser(user.id);
          } catch {
            removed = false;
          }

          if (removed) {
            deleted += 1;
          } else {
            // Still unverified, still past the window, so the next run retries
            // it. One stubborn identity must not protect every other.
            failed += 1;
          }

          // The WorkOS id, never the address. These rows outlive the subject,
          // and the whole point of the job is that this person is not a user of
          // ours; writing their address into our permanent audit trail to
          // record that we deleted their record would be self-defeating.
          await this.#audit.record({
            userId: null,
            action: "directory.unverified_reaped",
            subjectRef: user.id,
            outcome: removed ? "ok" : "error",
          });
        }

        after = result.after;
        if (after === null) break;
      }
    }

    return { ran: true, examined, deleted, capped, failed, skippedUnknown };
  }
}
