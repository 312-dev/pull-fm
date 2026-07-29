/**
 * Personal API tokens.
 *
 * The requirement: a user fetches THEIR OWN recommendations from a script, with
 * a credential they can create and revoke themselves. That is legally clean
 * because it is a person reading their own data, and it stays clean only
 * because the token surface exposes derived Pull.fm output and never a raw
 * upstream payload. The reasoning is in docs/api/data-portability.md and it is
 * a licence condition, not a preference.
 *
 * Security properties, each chosen against a specific failure:
 *
 *   Format          `pfm_live_<43 base64url chars>` / `pfm_test_<...>`.
 *                   A fixed, distinctive prefix is what makes a leaked token
 *                   findable: gitleaks, GitHub push protection, and a grep over
 *                   a support transcript all key on shape. A bare hex string
 *                   is indistinguishable from a hash and gets missed.
 *
 *   Entropy         32 bytes from `randomBytes`. Not a UUID: a v4 UUID is 122
 *                   bits with a recognisable layout, and there is no reason to
 *                   accept less than 256 when the cost is identical.
 *
 *   At rest         sha256(token), hex, UNIQUE. The token itself is never
 *                   written anywhere: not to the database, not to a log, not to
 *                   the audit trail. It exists in the process for the duration
 *                   of one response and in the creating user's clipboard.
 *
 *   Why not bcrypt  See the long note in migration 0002. Short version: the
 *                   secret is 256 bits of CSPRNG output, so there is no
 *                   dictionary to slow down, and a per-row salted hash would
 *                   force a table scan on every authenticated request.
 *
 *   Verification    Constant-time. The lookup is by digest so the timing of the
 *                   index probe already reveals nothing, but the comparison of
 *                   the digest is still done with timingSafeEqual so that a
 *                   future change to the lookup strategy cannot quietly
 *                   introduce an oracle.
 *
 *   Scope           Read-only. The scope set is CHECK-constrained in the
 *                   schema, so widening it is a migration and therefore a
 *                   review.
 *
 *   Escalation      A token cannot mint, rotate, or revoke a token, and cannot
 *                   delete the account. Those routes require a session. A
 *                   personal access token that can issue more personal access
 *                   tokens is a persistence mechanism, not a credential.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { errors } from "../lib/errors.js";
import type { Database, Queryable } from "../lib/db.js";

/** Scopes a token may hold. Mirrors the CHECK constraint in migration 0002. */
export const TOKEN_SCOPES = [
  "read:me",
  "read:wishlist",
  "read:recommendations",
  "read:connections",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const DEFAULT_SCOPES: readonly TokenScope[] = [
  "read:me",
  "read:wishlist",
  "read:recommendations",
];

/** Bytes of entropy in the secret half of a token. */
const SECRET_BYTES = 32;

/** The literal shape a valid token has, used to reject garbage before hashing. */
export const TOKEN_PATTERN = /^pfm_(?:live|test)_[A-Za-z0-9_-]{43}$/;

export type TokenPrefix = "pfm_live" | "pfm_test";

/** Public metadata for a token. Never contains the secret. */
export interface ApiTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly lastFour: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
}

/** A newly issued token. `token` is returned to the caller exactly once. */
export interface IssuedToken {
  readonly record: ApiTokenRecord;
  readonly token: string;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  last_four: string;
  scopes: string[];
  rate_limit_per_minute: number;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  rotated_from_id: string | null;
}

function toRecord(row: TokenRow): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    lastFour: row.last_four,
    scopes: row.scopes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    rotatedFromId: row.rotated_from_id,
  };
}

/** sha256 of the full token, lowercase hex. The only form we ever persist. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time digest comparison.
 *
 * Both inputs are fixed-length hex, so a length mismatch means malformed input
 * rather than a partial match, and returning early on it leaks nothing.
 */
export function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Generates a fresh token. The only place the plaintext is ever produced. */
export function mintToken(prefix: TokenPrefix): {
  token: string;
  hash: string;
  lastFour: string;
} {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${prefix}_${secret}`;
  return { token, hash: hashToken(token), lastFour: secret.slice(-4) };
}

export interface TokenServiceOptions {
  readonly prefix: TokenPrefix;
  readonly maxPerUser: number;
  readonly defaultTtlDays: number;
  readonly maxTtlDays: number;
  readonly defaultRateLimit: number;
}

export interface CreateTokenInput {
  readonly name: string;
  readonly scopes?: readonly string[] | undefined;
  readonly expiresInDays?: number | undefined;
}

/** The result of authenticating a bearer token. */
export interface AuthenticatedToken {
  readonly tokenId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
}

export class TokenService {
  readonly #db: Database;
  readonly #opts: TokenServiceOptions;

  constructor(db: Database, opts: TokenServiceOptions) {
    this.#db = db;
    this.#opts = opts;
  }

  #validate(input: CreateTokenInput): {
    scopes: string[];
    expiresAt: Date;
  } {
    const scopes = [...(input.scopes ?? DEFAULT_SCOPES)];
    if (scopes.length === 0) {
      throw errors.unprocessable("At least one scope is required.");
    }
    const unknown = scopes.filter(
      (s) => !(TOKEN_SCOPES as readonly string[]).includes(s),
    );
    if (unknown.length > 0) {
      throw errors.unprocessable(
        `Unknown scope(s): ${unknown.join(", ")}. Supported scopes are ${TOKEN_SCOPES.join(", ")}.`,
      );
    }

    const days = input.expiresInDays ?? this.#opts.defaultTtlDays;
    if (days < 1 || days > this.#opts.maxTtlDays) {
      throw errors.unprocessable(
        `expiresInDays must be between 1 and ${String(this.#opts.maxTtlDays)}.`,
      );
    }
    return {
      scopes: [...new Set(scopes)].sort(),
      expiresAt: new Date(Date.now() + days * 86_400_000),
    };
  }

  /**
   * Issues a token. The plaintext is in the return value and nowhere else.
   *
   * The per-user cap is enforced inside the transaction with the count taken
   * under the same snapshot as the insert, so two concurrent creates cannot
   * both observe `count = max - 1`.
   */
  async create(userId: string, input: CreateTokenInput): Promise<IssuedToken> {
    const { scopes, expiresAt } = this.#validate(input);
    const minted = mintToken(this.#opts.prefix);

    return this.#db.transaction(async (client) => {
      // The user row is locked first, so two concurrent creates for the same
      // subject serialise and cannot both observe `count = max - 1`. The lock
      // has to be on the user rather than on the counted rows: `FOR UPDATE` is
      // not permitted alongside an aggregate, and locking nothing would make
      // the cap advisory.
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);
      const { rows } = await client.query<{ live: string }>(
        `SELECT count(*)::text AS live
           FROM api_tokens
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [userId],
      );
      if (Number(rows[0]?.live ?? 0) >= this.#opts.maxPerUser) {
        throw errors.conflict(
          `You already have ${String(this.#opts.maxPerUser)} active tokens. Revoke one before creating another.`,
        );
      }

      let created;
      try {
        created = await client.query<TokenRow>(
          `INSERT INTO api_tokens
             (user_id, name, token_hash, token_prefix, last_four, scopes,
              rate_limit_per_minute, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            userId,
            input.name,
            minted.hash,
            this.#opts.prefix,
            minted.lastFour,
            scopes,
            this.#opts.defaultRateLimit,
            expiresAt,
          ],
        );
      } catch (err) {
        throw translateInsertError(err);
      }

      const row = created.rows[0];
      /* c8 ignore next 3 -- RETURNING on a successful INSERT always yields a row */
      if (row === undefined) {
        throw errors.conflict("The token could not be created.");
      }
      return { record: toRecord(row), token: minted.token };
    });
  }

  /** Lists the caller's tokens. Metadata only; the secret does not exist here. */
  async list(userId: string): Promise<ApiTokenRecord[]> {
    const { rows } = await this.#db.query<TokenRow>(
      `SELECT * FROM api_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toRecord);
  }

  /**
   * Revokes a token.
   *
   * The ownership predicate is in the same statement as the id predicate
   * (M11). There is no SELECT-then-check: a foreign id simply matches zero
   * rows, and the caller is told 404 rather than 403 so token ids cannot be
   * enumerated by observing which ones exist.
   */
  async revoke(userId: string, tokenId: string): Promise<ApiTokenRecord> {
    const { rows } = await this.#db.query<TokenRow>(
      `UPDATE api_tokens
          SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING *`,
      [tokenId, userId],
    );
    const row = rows[0];
    if (row === undefined) throw errors.notFound("No such token.");
    return toRecord(row);
  }

  /**
   * Rotates a token: same name and scopes, new secret, old secret dead.
   *
   * Done in one transaction so there is never a moment where both secrets work
   * or neither does. The old row is revoked rather than deleted, so the audit
   * trail and the rotation chain survive.
   */
  async rotate(userId: string, tokenId: string): Promise<IssuedToken> {
    const minted = mintToken(this.#opts.prefix);

    return this.#db.transaction(async (client) => {
      const previous = await client.query<TokenRow>(
        `UPDATE api_tokens
            SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING *`,
        [tokenId, userId],
      );
      const old = previous.rows[0];
      if (old === undefined) throw errors.notFound("No such token.");

      // The name is UNIQUE per user and the old row keeps it, so the
      // replacement is suffixed deterministically rather than colliding.
      const name = nextRotationName(old.name);

      let created;
      try {
        created = await client.query<TokenRow>(
          `INSERT INTO api_tokens
             (user_id, name, token_hash, token_prefix, last_four, scopes,
              rate_limit_per_minute, expires_at, rotated_from_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            userId,
            name,
            minted.hash,
            this.#opts.prefix,
            minted.lastFour,
            old.scopes,
            old.rate_limit_per_minute,
            new Date(Date.now() + this.#opts.defaultTtlDays * 86_400_000),
            old.id,
          ],
        );
      } catch (err) {
        throw translateInsertError(err);
      }

      const row = created.rows[0];
      /* c8 ignore next 3 -- RETURNING on a successful INSERT always yields a row */
      if (row === undefined) {
        throw errors.conflict("The token could not be rotated.");
      }
      return { record: toRecord(row), token: minted.token };
    });
  }

  /**
   * Authenticates a presented token.
   *
   * Expiry and revocation are predicates in the SAME statement as the hash
   * lookup rather than checks on the returned row. A fetch-then-check here
   * would be the identical mistake as a fetch-then-check on ownership: it
   * creates a window, and it makes the security property depend on the caller
   * remembering to apply it.
   *
   * Returns null for every failure. The caller must not distinguish "no such
   * token" from "expired" from "revoked" in its response: all three are 401
   * with the same body, or an attacker learns which of their guesses are real.
   */
  async authenticate(token: string): Promise<AuthenticatedToken | null> {
    if (!TOKEN_PATTERN.test(token)) return null;

    const digest = hashToken(token);
    const { rows } = await this.#db.query<{
      id: string;
      user_id: string;
      token_hash: string;
      scopes: string[];
      rate_limit_per_minute: number;
    }>(
      `SELECT t.id, t.user_id, t.token_hash, t.scopes, t.rate_limit_per_minute
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1
          AND t.revoked_at IS NULL
          AND t.expires_at > now()
          AND u.deleted_at IS NULL`,
      [digest],
    );

    const row = rows[0];
    if (row === undefined) return null;
    // Belt and braces: the WHERE already matched on equality, but comparing
    // again in constant time means a future change to the lookup (a prefix
    // index, a cache) cannot silently introduce a timing oracle.
    if (!digestsEqual(row.token_hash, digest)) return null;

    return {
      tokenId: row.id,
      userId: row.user_id,
      scopes: row.scopes,
      rateLimitPerMinute: row.rate_limit_per_minute,
    };
  }

  /**
   * Records that a token was used.
   *
   * Throttled to at most one write per minute per token. `last_used_at` is
   * genuinely useful ("is this token still in use before I revoke it?") but an
   * UPDATE on every authenticated request turns a read-only API into a
   * write-amplified one and puts a row lock on the hot path.
   */
  async touch(
    client: Queryable,
    tokenId: string,
    ip: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE api_tokens
          SET last_used_at = now(), last_used_ip = $2
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [tokenId, ip],
    );
  }

  get db(): Database {
    return this.#db;
  }
}

/** `laptop` -> `laptop (rotated)`, `laptop (rotated)` -> `laptop (rotated 2)`. */
export function nextRotationName(name: string): string {
  const match = /^(.*) \(rotated(?: (\d+))?\)$/.exec(name);
  if (match === null) return truncateName(`${name} (rotated)`);
  const base = match[1] ?? name;
  const n = match[2] === undefined ? 2 : Number(match[2]) + 1;
  return truncateName(`${base} (rotated ${String(n)})`);
}

/** The schema caps `name` at 64 characters; overflow must not 500. */
function truncateName(name: string): string {
  return name.length <= 64 ? name : `${name.slice(0, 61)}...`;
}

/**
 * Maps a constraint violation to a client-safe problem.
 *
 * Postgres error text can carry the offending value, so the message is
 * reconstructed rather than echoed.
 */
function translateInsertError(err: unknown): Error {
  const code = (err as { code?: unknown }).code;
  const constraint = (err as { constraint?: unknown }).constraint;
  if (code === "23505" && constraint === "api_tokens_user_id_name_key") {
    return errors.conflict("You already have a token with that name.");
  }
  if (code === "23514") {
    return errors.unprocessable("The token parameters are not acceptable.");
  }
  return err as Error;
}
