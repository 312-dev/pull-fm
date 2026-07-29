/**
 * Idempotency-Key handling for mutating routes.
 *
 * docs/PLAN.md section 6 mandates the header on every mutating call, because a
 * mobile client on a flaky network retries and a double-tap must not create two
 * rows. That mandate is also the reason THREAT-MODEL T14 is rated High: a
 * cross-cutting header that every mutating route honours turns ONE caching
 * mistake into a BOLA on every mutating route simultaneously.
 *
 * The mistake in question is keying the stored response on the header value
 * alone. An attacker then replays a guessed or observed key and is handed the
 * previous caller's response body.
 *
 * The control (M13) is that the record is keyed on the SUBJECT and the key,
 * with the request fingerprint stored alongside:
 *
 *   PRIMARY KEY (user_id, key)   -- from migration 0001
 *   request_hash = sha256(method | route | canonical body)
 *
 * so a foreign subject replaying a key finds no row at all, and the same
 * subject replaying a key with a different body gets 409 rather than someone
 * else's cached answer.
 */

import { createHash } from "node:crypto";

import { errors } from "./errors.js";
import type { Queryable } from "./db.js";

/** Cached outcome of a previously completed request. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

/**
 * Validates the header.
 *
 * A short or unconstrained key is a guessing surface, and while the subject
 * scoping above means guessing another user's key gains nothing, a caller
 * colliding with THEIR OWN key across two different operations is a real
 * source of confusing bugs. Rejecting the shape early is cheaper than
 * debugging it later.
 */
export function requireIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw errors.badRequest(
      "An Idempotency-Key header is required on this request. Use a fresh UUID per logical operation and reuse it on retry.",
    );
  }
  if (!KEY_PATTERN.test(raw)) {
    throw errors.badRequest(
      "Idempotency-Key must be 8 to 255 characters of [A-Za-z0-9_.:-].",
    );
  }
  return raw;
}

/** Stable fingerprint of the request this key is claimed to represent. */
export function fingerprint(
  method: string,
  route: string,
  body: unknown,
): string {
  // JSON.stringify with sorted keys: two semantically identical bodies that
  // differ only in property order must not look like different requests.
  return createHash("sha256")
    .update(`${method}\n${route}\n${canonicalise(body)}`, "utf8")
    .digest("hex");
}

function canonicalise(value: unknown): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string, so an absent body
  // has to be handled before the general case or the fingerprint of one request
  // becomes literally undefined.
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

/**
 * Claims the key for this request, or returns the stored response.
 *
 * The claim is an INSERT ... ON CONFLICT DO NOTHING, so two concurrent retries
 * race in the database and exactly one wins. The loser reads the winner's row.
 * A check-then-insert would let both proceed, which is precisely the double
 * write the header exists to prevent.
 *
 * Returns `null` when this caller owns the key and should execute the
 * operation, or the stored response when the operation already completed.
 */
export async function claim(
  client: Queryable,
  userId: string,
  key: string,
  requestHash: string,
): Promise<StoredResponse | null> {
  const inserted = await client.query<{ key: string }>(
    `INSERT INTO idempotency_keys (user_id, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING key`,
    [userId, key, requestHash],
  );
  if (inserted.rowCount === 1) return null;

  // Note the ownership predicate: the row is looked up by (user_id, key), never
  // by key alone. This single line is the difference between M13 and T14.
  const existing = await client.query<{
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
      WHERE user_id = $1 AND key = $2 AND expires_at > now()`,
    [userId, key],
  );

  const row = existing.rows[0];
  if (row === undefined) {
    // The row expired between the INSERT conflicting and this read. Treat it as
    // a fresh request rather than a conflict; re-executing is safe because the
    // operation itself is written to be idempotent.
    return null;
  }
  if (row.request_hash !== requestHash) {
    throw errors.idempotencyConflict();
  }
  if (row.response_status === null) {
    // A concurrent request holds the key and has not finished. Returning the
    // half-finished state would be a lie; 409 tells the client to retry.
    throw errors.conflict(
      "A request with this Idempotency-Key is still in flight. Retry shortly.",
    );
  }
  return { status: row.response_status, body: row.response_body };
}

/** Records the completed response so a retry returns the ORIGINAL answer. */
export async function complete(
  client: Queryable,
  userId: string,
  key: string,
  response: StoredResponse,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET response_status = $3, response_body = $4
      WHERE user_id = $1 AND key = $2`,
    [userId, key, response.status, JSON.stringify(response.body)],
  );
}

/**
 * Releases a claim whose operation failed.
 *
 * Without this a transient 500 would poison the key: the client's retry finds a
 * claimed row with no response and gets 409 forever.
 */
export async function release(
  client: Queryable,
  userId: string,
  key: string,
): Promise<void> {
  await client.query(
    `DELETE FROM idempotency_keys
      WHERE user_id = $1 AND key = $2 AND response_status IS NULL`,
    [userId, key],
  );
}
