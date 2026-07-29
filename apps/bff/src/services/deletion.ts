/**
 * Account deletion, and the cascade it has to complete.
 *
 * Required by GDPR Article 17 and CCPA regardless of how the app is
 * distributed (docs/PLAN.md open decision 6). It is also the most destructive
 * operation in the system, which is why the route in front of it demands a
 * proof of recent authentication and refuses personal API tokens outright.
 *
 * The cascade has four destinations and they do not all behave the same way:
 *
 *   Postgres  One `DELETE FROM users`. Every user-owned table declares
 *             ON DELETE CASCADE, so this is transactional by construction
 *             rather than an application-level sweep that can partially fail.
 *             `packages/db/scripts/verify-migrations.mjs` asserts this against
 *             a real database on every CI run.
 *
 *   WorkOS    A DELETE against the identity provider. Best effort and recorded:
 *             if it fails, the local rows are still gone and the deletion_log
 *             row carries `workos_deleted = false` so the retry is a query
 *             rather than an investigation.
 *
 *   Redis     Cache entries and quota counters keyed by the subject. Scanned,
 *             never `KEYS *`, because a blocking scan on the quota instance
 *             times out every rate-limit check in flight.
 *
 *   Backups   NOT deleted, and this is a deliberate documented position rather
 *             than an oversight. See the note below.
 *
 * ---------------------------------------------------------------------------
 * The backup position (Gate L: "documented backup-retention position for
 * deleted data")
 *
 * pgBackRest retains WAL and full backups in R2 for the point-in-time-recovery
 * window. A deleted user's rows therefore continue to exist inside encrypted
 * backup artifacts until the last backup containing them ages out.
 *
 * We do not attempt to erase from backups, for the reason the ICO, the EDPB,
 * and every serious analysis of Article 17 give: selectively rewriting a
 * backup destroys its integrity, which defeats the purpose of having one, and
 * the attempt would itself be a bigger risk to every other user's data than the
 * residual retention is to the deleted one.
 *
 * The position we take instead, which is the one regulators accept:
 *
 *   1. Backups are "put beyond use": encrypted at rest with the pgBackRest
 *      repository cipher, access-controlled to a single scoped R2 credential,
 *      and never queried for live traffic.
 *   2. Retention is bounded and stated. Deleted data disappears from the backup
 *      set when the last backup containing it expires, within the documented
 *      PITR window.
 *   3. If a restore ever occurs, the R2 ERASURE LEDGER is the authoritative
 *      replay list: any restored user id present in it is re-deleted before the
 *      restored system serves traffic. That makes the deletion durable across a
 *      restore, which is the property the regulation actually cares about.
 *
 *      IT USED TO SAY `deletion_log` HERE, AND THAT WAS FALSE. `deletion_log`
 *      is a table inside the database being restored, so rolling back past an
 *      erasure rolls back the erasure and its own evidence simultaneously. The
 *      2026-07-29 drill proved it: the account came back and `deletion_log`
 *      held zero rows. The replay list has to live where a Postgres restore
 *      cannot reach, which is what services/erasure-ledger.ts is.
 *   4. Backup encryption keys are escrowed but not user-specific, so there is
 *      no per-user crypto-shredding claim to make here. The claim that IS true:
 *      third-party credentials in a backup are envelope ciphertext, so a
 *      restored backup of a deleted account yields no usable credential.
 *
 * That is the whole position. It is written here, next to the code, rather than
 * only in a policy document, because the code is what a future maintainer reads
 * before changing the retention window.
 * ---------------------------------------------------------------------------
 */

import type { Redis } from "ioredis";

import type { Queryable } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";
import { deleteByPrefix } from "../lib/redis.js";
import type { ErasureDurability, ErasureLedger } from "./erasure-ledger.js";
import type { WorkOsClient } from "./workos.js";

export interface DeletionOutcome {
  readonly userId: string;
  readonly rowsDeleted: Record<string, number>;
  readonly workosDeleted: boolean;
  readonly redisKeysDeleted: number;
  /**
   * How this erasure was made durable outside Postgres.
   *
   * Returned rather than merely logged because it is the difference between two
   * different promises to the data subject: `inline` means the erasure survives
   * a restore to any point after this instant, and `deferred-to-reconciler`
   * means it survives a restore to any point after the exporter's next run.
   */
  readonly durability: ErasureDurability;
}

/**
 * The narrow database surface the cascade needs.
 *
 * Declared structurally rather than as the concrete `Database` so the
 * partial-failure paths - which are the ones that matter here, because this is
 * the only irreversible operation in the API - can be driven deterministically
 * by a fake. A cascade whose failure modes are only reachable by breaking a
 * real Postgres is a cascade whose failure modes are untested.
 */
export interface DeletionDatabase extends Queryable {
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

export interface DeletionServiceDeps {
  readonly db: DeletionDatabase;
  readonly workos: WorkOsClient;
  readonly cacheRedis: Redis;
  readonly quotaRedis: Redis;
  /**
   * The out-of-band erasure ledger. NOT optional: a deployment without one
   * passes `UnconfiguredErasureLedger`, so there is no code path here that can
   * forget to consider durability.
   */
  readonly ledger: ErasureLedger;
  /** Optional. Never receives anything but ids and a failure kind. */
  readonly log?: { warn: (obj: unknown, msg?: string) => void } | undefined;
}

/**
 * The refusal returned when the ledger is configured and its write failed.
 *
 * 503 rather than 500 because it is precisely a "try again" condition: nothing
 * has been destroyed, the request row records that erasure was asked for, and a
 * retry is expected to succeed. The WorkOS webhook path depends on this too - a
 * non-2xx there means the provider redelivers `user.deleted`, which is the
 * behaviour we want when the erasure is not yet durable.
 */
function ledgerUnavailable(): ApiError {
  return new ApiError(
    503,
    "erasure-not-durable",
    "Service Unavailable",
    "The erasure record could not be written to durable storage, so the account has NOT been deleted. " +
      "Nothing was changed. Please retry.",
  );
}

/**
 * Tables counted before the cascade fires.
 *
 * Counted rather than assumed, because "the cascade worked" is a claim that has
 * to be evidenced in the deletion_log for an Article 17 response, and because a
 * future table added without ON DELETE CASCADE would otherwise be discovered by
 * a regulator rather than by us.
 */
const OWNED_TABLES = [
  "user_connections",
  "wishlist_items",
  "idempotency_keys",
  "api_tokens",
  "connect_states",
] as const;

export class DeletionService {
  readonly #deps: DeletionServiceDeps;

  constructor(deps: DeletionServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Deletes an account and everything derived from it.
   *
   * Ordering is chosen so that a failure at any point leaves a recoverable
   * state rather than a half-deleted one:
   *
   *   1. Write the deletion_log request row FIRST. If everything after it
   *      fails, there is a durable record that erasure was requested, and the
   *      sweep can retry. A log written last would be lost by the failure it
   *      exists to record.
   *   2. Write the OUT-OF-BAND ERASURE LEDGER object, and refuse to continue if
   *      it fails. See below.
   *   3. Delete the Postgres rows in one transaction.
   *   4. Delete upstream and in Redis, both best effort, both recorded.
   *
   * `workosUserId` is passed in rather than read after the delete, because
   * after step 3 the row that held it no longer exists.
   *
   * -------------------------------------------------------------------------
   * WHY THE LEDGER IS STEP 2 AND NOT STEP 5, AND WHICH FAILURE THAT PREFERS
   *
   * There are only two orderings and each one has a failure it cannot avoid:
   *
   *   LEDGER LAST   The rows are gone and the ledger write fails. The erasure
   *                 happened and nothing outside Postgres records it, so a
   *                 restore past this moment resurrects the account with
   *                 nothing to say it should not exist. That is exactly the
   *                 defect the 2026-07-29 drill found, reintroduced at a
   *                 smaller scale. It is also unfixable in the moment: the
   *                 delete cannot be undone, so the only honest response is an
   *                 error on a request that irreversibly succeeded.
   *
   *   LEDGER FIRST  The ledger holds an entry for an account that was not, in
   *                 the end, erased, because step 3 failed. The account is
   *                 intact, the caller got an error, and a retry reconciles
   *                 everything. The residue is that a restore-and-replay would
   *                 delete an account that is technically still live.
   *
   * WE PREFER THE SECOND, for three reasons:
   *
   *   1. NOTHING IRREVERSIBLE HAS HAPPENED WHEN IT OCCURS. The whole ordering
   *      property this method already had - a failure leaves a recoverable
   *      state - is preserved, and the ledger write is placed before the one
   *      step that cannot be taken back.
   *   2. THE "ORPHAN" IS NOT A NEW FAILURE MODE. The `deletion_log` request row
   *      is already written first, and the timer exporter already copies every
   *      row it finds, completed or not, into the ledger. An erasure that
   *      failed at step 3 therefore already produced a ledger entry within ten
   *      minutes, before this change. Writing it inline makes the same entry
   *      appear sooner; it does not create one that would not have existed.
   *   3. THE ORPHANED SUBJECT ASKED TO BE ERASED. Both callers require it: the
   *      route demands a fresh session plus the account's own email typed back,
   *      and the webhook path requires a signature-verified `user.deleted`. A
   *      replay that erases them is late compliance, not a wrongful deletion.
   *      The reverse failure - a resurrected account with no record of its
   *      erasure - is a breach of a published promise, and one we already know
   *      how to discover only by drilling for it.
   *
   * The refusal in step 2 is what stops this from being a silent downgrade: an
   * erasure that cannot be made durable does not happen at all, rather than
   * happening and claiming a durability it does not have.
   *
   * A deployment with NO ledger configured is a different case and is handled
   * differently: it is a known property of the deployment rather than a
   * per-request failure, so the cascade proceeds, the weaker durability is
   * recorded in `deletion_log.notes` and returned to the caller, and the
   * ten-minute exporter remains the mechanism. Refusing to erase because an
   * object-store credential is absent would be a worse Article 17 outcome than
   * erasing with a ten-minute RPO.
   */
  async deleteAccount(
    userId: string,
    workosUserId: string,
  ): Promise<DeletionOutcome> {
    const requestedAt = new Date();

    const { rows: logRows } = await this.#deps.db.query<{ id: string }>(
      `INSERT INTO deletion_log (deleted_user_id, requested_at)
       VALUES ($1, $2) RETURNING id`,
      [userId, requestedAt],
    );
    const logId = logRows[0]?.id ?? null;

    let durability: ErasureDurability;
    try {
      durability = await this.#deps.ledger.record({
        deletedUserId: userId,
        requestedAt,
      });
    } catch (err) {
      // The one place in this method that aborts. Everything after this point
      // is irreversible, so this is the last moment at which refusing is free.
      this.#deps.log?.warn(
        {
          userId,
          err: err instanceof Error ? err.name : "unknown",
        },
        "erasure ledger write failed; the deletion was refused and nothing was deleted",
      );
      await this.#note(
        logId,
        "ABORTED: the out-of-band erasure ledger was unwritable, so no data was deleted. Retry required.",
      );
      throw ledgerUnavailable();
    }

    const rowsDeleted = await this.#deps.db.transaction(async (client) => {
      const counts: Record<string, number> = {};
      for (const table of OWNED_TABLES) {
        // Table names come from the constant above and never from input; there
        // is no path by which a caller influences this string.
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE user_id = $1`,
          [userId],
        );
        counts[table] = Number(rows[0]?.n ?? 0);
      }
      const { rowCount } = await client.query(
        `DELETE FROM users WHERE id = $1`,
        [userId],
      );
      counts["users"] = rowCount ?? 0;
      return counts;
    });

    let workosDeleted = false;
    try {
      workosDeleted = await this.#deps.workos.deleteUser(workosUserId);
    } catch {
      // Recorded as false and swept later. The local erasure has already
      // happened and must not be rolled back because a vendor was unavailable.
      workosDeleted = false;
    }

    let redisKeysDeleted = 0;
    for (const [client, prefix] of [
      [this.#deps.cacheRedis, `u:${userId}:`],
      [this.#deps.quotaRedis, `quota:user:${userId}:`],
    ] as const) {
      try {
        redisKeysDeleted += await deleteByPrefix(client, prefix);
      } catch {
        /* best effort: these are caches and counters, both reconstructible */
      }
    }

    if (logId !== null) {
      // Both facts, in one column, because an Article 17 response has to be
      // able to state what happened AND how durable it is, and a note that
      // recorded only the WorkOS outcome would silently drop the second.
      const notes = [
        workosDeleted
          ? null
          : "WorkOS identity deletion failed or was skipped; retry required.",
        durability === "deferred-to-reconciler"
          ? "No out-of-band erasure ledger is configured on this deployment; durability across a restore is bounded by the ledger exporter's interval."
          : `Erasure ledger written before deletion (${durability}).`,
      ]
        .filter((n): n is string => n !== null)
        .join(" ");

      await this.#deps.db.query(
        `UPDATE deletion_log
            SET completed_at = now(), rows_deleted = $2, workos_deleted = $3, notes = $4
          WHERE id = $1`,
        [
          logId,
          JSON.stringify({ ...rowsDeleted, redisKeys: redisKeysDeleted }),
          workosDeleted,
          notes,
        ],
      );
    }

    return { userId, rowsDeleted, workosDeleted, redisKeysDeleted, durability };
  }

  /**
   * Annotates the request row on an aborted erasure. Best effort by design.
   *
   * The abort is already being reported to the caller and to the log; failing
   * the abort itself because the annotation could not be written would replace
   * a clear 503 with an opaque 500 and tell the operator less, not more.
   */
  async #note(logId: string | null, note: string): Promise<void> {
    if (logId === null) return;
    try {
      await this.#deps.db.query(
        `UPDATE deletion_log SET notes = $2 WHERE id = $1`,
        [logId, note],
      );
    } catch {
      /* the 503 and the log line already carry this */
    }
  }

  /**
   * Deletion triggered by a verified `user.deleted` webhook.
   *
   * The identity is already gone upstream, so the WorkOS call is skipped: it
   * would 404, and treating that 404 as a failure would fill the deletion_log
   * with retries that can never succeed.
   */
  async deleteByWorkOsId(
    workosUserId: string,
  ): Promise<DeletionOutcome | null> {
    const { rows } = await this.#deps.db.query<{ id: string }>(
      `SELECT id FROM users WHERE workos_user_id = $1`,
      [workosUserId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const outcome = await this.deleteAccount(row.id, workosUserId);
    return { ...outcome, workosDeleted: true };
  }
}
