/**
 * Opaque, integrity-protected keyset cursors.
 *
 * Two independent controls, because THREAT-MODEL M15 asks for exactly that and
 * because either one alone has a known failure:
 *
 *   1. The cursor is signed and bound to the subject that was issued it, so a
 *      cursor lifted from another user is rejected before any SQL runs.
 *   2. The keyset predicate ALWAYS ANDs `user_id = $subject` in the same
 *      statement. If control 1 were bypassed entirely, a forged cursor still
 *      cannot escape the subject: it can only reposition the caller within
 *      their own rows.
 *
 * Control 2 is the real one. Control 1 exists so that a tampering attempt is
 * observable (a 400 in the logs) rather than silently absorbed.
 *
 * Keyset rather than OFFSET, because OFFSET on a large table is a scan the
 * caller controls the length of, which is a resource-consumption bug (API4) as
 * much as a performance one.
 */

import { errors } from "./errors.js";
import type { SigningKeys } from "./keys.js";

/** The position of the last row on the previous page. */
export interface CursorPosition {
  /** ISO-8601 timestamp of the sort column. */
  readonly createdAt: string;
  /** Tie-breaker, so rows sharing a timestamp cannot be skipped or repeated. */
  readonly id: string;
}

const SEPARATOR = ".";

/**
 * Encodes a position as `base64url(payload).base64url(mac)`.
 *
 * The subject and a scope label are covered by the MAC but not carried in the
 * payload: including them in the message is what binds the cursor, and leaving
 * them out of the payload keeps the cursor from disclosing a user id to anyone
 * who base64-decodes it.
 */
export function encodeCursor(
  keys: SigningKeys,
  scope: string,
  subjectId: string,
  position: CursorPosition,
): string {
  const payload = Buffer.from(
    JSON.stringify({ t: position.createdAt, i: position.id }),
    "utf8",
  ).toString("base64url");
  const mac = keys.sign("cursor", `${scope}|${subjectId}|${payload}`);
  return `${payload}${SEPARATOR}${mac}`;
}

/**
 * Decodes and verifies a cursor.
 *
 * Every rejection path returns the same 400, so the caller cannot distinguish
 * "malformed" from "signed for another subject" from "signed for another
 * route". A differential response here would be a subject-existence oracle.
 */
export function decodeCursor(
  keys: SigningKeys,
  scope: string,
  subjectId: string,
  cursor: string,
): CursorPosition {
  const reject = (): never => {
    throw errors.badRequest(
      "The cursor is not valid. Start from the first page.",
    );
  };

  const parts = cursor.split(SEPARATOR);
  if (parts.length !== 2) return reject();
  const [payload, mac] = parts as [string, string];
  if (payload.length === 0 || mac.length === 0) return reject();

  if (!keys.verify("cursor", `${scope}|${subjectId}|${payload}`, mac)) {
    return reject();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return reject();
  }

  if (typeof parsed !== "object" || parsed === null) return reject();
  const record = parsed as Record<string, unknown>;
  const createdAt = record["t"];
  const id = record["i"];
  if (typeof createdAt !== "string" || typeof id !== "string") return reject();
  // A signed cursor cannot normally be malformed, but validating anyway means a
  // future key-handling bug degrades to a 400 rather than to a SQL type error.
  if (Number.isNaN(Date.parse(createdAt))) return reject();

  return { createdAt, id };
}

/** Clamps a client-supplied page size. An unbounded limit is an API4 finding. */
export function pageLimit(requested: number | undefined, max = 100): number {
  if (requested === undefined) return 25;
  if (!Number.isInteger(requested) || requested < 1) return 25;
  return Math.min(requested, max);
}
