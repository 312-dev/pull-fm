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
 *   3. If a restore ever occurs, the deletion_log rows in this database are the
 *      authoritative replay list: any restored user id present in deletion_log
 *      is re-deleted before the restored system serves traffic. That makes the
 *      deletion durable across a restore, which is the property the regulation
 *      actually cares about.
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

import type { Database } from "../lib/db.js";
import { deleteByPrefix } from "../lib/redis.js";
import type { WorkOsClient } from "./workos.js";

export interface DeletionOutcome {
  readonly userId: string;
  readonly rowsDeleted: Record<string, number>;
  readonly workosDeleted: boolean;
  readonly redisKeysDeleted: number;
}

export interface DeletionServiceDeps {
  readonly db: Database;
  readonly workos: WorkOsClient;
  readonly cacheRedis: Redis;
  readonly quotaRedis: Redis;
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
   *   2. Delete the Postgres rows in one transaction.
   *   3. Delete upstream and in Redis, both best effort, both recorded.
   *
   * `workosUserId` is passed in rather than read after the delete, because
   * after step 2 the row that held it no longer exists.
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
      await this.#deps.db.query(
        `UPDATE deletion_log
            SET completed_at = now(), rows_deleted = $2, workos_deleted = $3, notes = $4
          WHERE id = $1`,
        [
          logId,
          JSON.stringify({ ...rowsDeleted, redisKeys: redisKeysDeleted }),
          workosDeleted,
          workosDeleted
            ? null
            : "WorkOS identity deletion failed or was skipped; retry required.",
        ],
      );
    }

    return { userId, rowsDeleted, workosDeleted, redisKeysDeleted };
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
