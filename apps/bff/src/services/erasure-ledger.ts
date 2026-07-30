/**
 * The append-only erasure ledger, written INLINE with the erasure.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM THAT WAS FALSE, AND HOW
 *
 * legal/privacy-policy.md and docs/api/deletion-and-backups.md both named
 * `deletion_log` as the authoritative list for re-applying erasures after a
 * restore. It cannot be. `deletion_log` is a table INSIDE the database being
 * restored, so a restore to a point before an erasure rolls back the erasure
 * and the record of the erasure in the same instant. The 2026-07-29 drill
 * (docs/RUNBOOK-DR.md §5) ran it: the account came back and `deletion_log` held
 * zero rows.
 *
 * The fix is that the replay list lives somewhere a Postgres restore cannot
 * reach: one immutable R2 object per erasure, keyed by the user id.
 * `infra/backup/pullfm-backup.sh replay-deletions` reads it before a restored
 * system serves traffic, and the drill now passes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CHANGES
 *
 * That ledger was written by an exporter on a TEN-MINUTE TIMER
 * (`infra/backup/systemd/pullfm-deletion-ledger.timer`), which made ten minutes
 * the erasure-durability RPO: an account erased inside the window and then
 * restored past it came back with nothing recording that it asked to be gone.
 * Both published documents disclose that as an open gap.
 *
 * This makes the deletion cascade write the object itself, in the same handler
 * that writes the `deletion_log` row, so the durability is synchronous with the
 * request. The timer becomes a RECONCILER rather than the primary writer, and
 * it needs no change to become one: it already HEADs before it PUTs and skips
 * keys that are present, so it now finds nothing to do except for erasures the
 * inline path could not complete. Its "N new" number stops being a throughput
 * figure and becomes an error count worth alerting on.
 *
 * ---------------------------------------------------------------------------
 * THE OBJECT
 *
 * Byte-compatible with what the exporter writes, because `replay-deletions`
 * parses it and must not care which writer produced it. It reads
 * `deleted_user_id`, `requested_at`, and `completed_at` (falling back to
 * `requested_at`), and ignores everything else, so `written_by` is additive
 * rather than a schema change.
 *
 * `completed_at` is null for an inline entry, and that is not a defect: the
 * object is written BEFORE the destructive delete, so at the moment of writing
 * the erasure has not completed. Nothing downstream needs it - the replay keys
 * on the id alone - and a ledger entry that claimed completion it had not yet
 * observed would be the same kind of lie this whole mechanism exists to stop.
 *
 * The object holds an opaque uuid and timestamps and nothing else. That is the
 * same data `deletion_log` already retains permanently and which
 * legal/privacy-policy.md §7 already discloses, so this adds a location rather
 * than a category of personal data.
 */

import type { ErasureLedgerConfig } from "../config.js";
import { R2Client, R2Error } from "../lib/r2.js";

export interface ErasureLedgerEntry {
  readonly deletedUserId: string;
  readonly requestedAt: Date;
}

/**
 * How an erasure was made durable outside Postgres.
 *
 * `deferred` is NOT a success. It means this deployment has no ledger
 * configured and the durability of this erasure is bounded by the exporter's
 * timer, which is a materially weaker claim; the caller records it rather than
 * discarding it, so an Article 17 response can say which one applied.
 */
export type ErasureDurability =
  "inline" | "already-present" | "deferred-to-reconciler";

export interface ErasureLedger {
  /**
   * True when this deployment can make an erasure durable synchronously.
   *
   * Read at startup for the warning, and by the cascade to decide whether a
   * failure is a per-request fault or a known deployment property.
   */
  readonly configured: boolean;
  /**
   * Writes the erasure record.
   *
   * MUST THROW when the ledger is configured and the write did not happen. The
   * cascade turns that into a refusal to proceed, so an erasure never claims a
   * durability it does not have. Returns `deferred-to-reconciler` only when no
   * ledger is configured at all, which is a deployment decision known at
   * startup rather than a silent per-request failure.
   */
  record(entry: ErasureLedgerEntry): Promise<ErasureDurability>;
}

/** The ledger for a deployment that has none. See the `configured` contract. */
export class UnconfiguredErasureLedger implements ErasureLedger {
  readonly configured = false;

  record(): Promise<ErasureDurability> {
    return Promise.resolve("deferred-to-reconciler");
  }
}

export interface R2ErasureLedgerOptions {
  readonly config: ErasureLedgerConfig;
  /** Test seam; the client defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
}

export class R2ErasureLedger implements ErasureLedger {
  readonly configured = true;
  readonly #client: R2Client;
  readonly #prefix: string;

  constructor(opts: R2ErasureLedgerOptions) {
    this.#prefix = opts.config.prefix;
    this.#client = new R2Client({
      endpoint: opts.config.endpoint,
      bucket: opts.config.bucket,
      accessKeyId: opts.config.accessKeyId,
      secretAccessKey: opts.config.secretAccessKey,
      timeoutMs: opts.config.timeoutMs,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
  }

  /** Matches `_ledger_key()` in infra/backup/pullfm-backup.sh exactly. */
  keyFor(userId: string): string {
    return `${this.#prefix}/${userId}.json`;
  }

  async record(entry: ErasureLedgerEntry): Promise<ErasureDurability> {
    const key = this.keyFor(entry.deletedUserId);

    /**
     * HEAD BEFORE PUT, for the reason the exporter gives: append-only that a
     * second writer silently overwrites is just a filename convention.
     *
     * It also makes a retry correct. An erasure that failed after the ledger
     * write and is retried finds its own entry and proceeds, rather than
     * replacing an immutable record with a second version of itself.
     */
    if (await this.#client.exists(key)) return "already-present";

    await this.#client.put(
      key,
      `${JSON.stringify(
        {
          completed_at: null,
          deleted_user_id: entry.deletedUserId,
          note:
            "Authoritative erasure record. Survives a Postgres restore because it is not in Postgres. " +
            "Re-delete this id before a restored system serves traffic.",
          requested_at: entry.requestedAt.toISOString(),
          // Additive, and ignored by replay-deletions. It is what lets an
          // operator tell an inline record from a reconciled one when the two
          // disagree about how long the gap was.
          written_by: "bff-inline",
        },
        null,
        2,
      )}\n`,
    );
    return "inline";
  }
}

export { R2Error };

/**
 * Builds the ledger for a deployment.
 *
 * Returns the unconfigured implementation rather than null, so the deletion
 * cascade always has a ledger to call and there is no branch in the cascade
 * that can forget to. A dependency that can be absent is a dependency somebody
 * will forget to check.
 */
export function createErasureLedger(
  config: ErasureLedgerConfig | null,
  opts: { fetchImpl?: typeof fetch | undefined } = {},
): ErasureLedger {
  if (config === null) return new UnconfiguredErasureLedger();
  return new R2ErasureLedger({ config, fetchImpl: opts.fetchImpl });
}
