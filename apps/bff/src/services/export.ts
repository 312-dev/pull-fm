/**
 * GDPR Article 20 data portability.
 *
 * Two decisions are worth stating plainly, because both are the kind of thing
 * that gets "simplified" later by someone who has not read the reasoning.
 *
 * ---------------------------------------------------------------------------
 * 1. The export EXCLUDES decrypted third-party credentials, deliberately.
 *
 * Article 20 gives a person the right to receive the personal data they
 * provided, in a structured, commonly used, machine-readable format. It does
 * not require handing back a secret, and a ListenBrainz token or a Last.fm
 * session key is not personal data about the user in any meaningful sense: it
 * is a bearer credential for someone else's system that the user can regenerate
 * at that system in under a minute.
 *
 * Including them would convert every session takeover into a credential theft
 * with one request, which is THREAT-MODEL AT-1 branch 2a. Last.fm session keys
 * do not expire, so the resulting compromise would be permanent and invisible.
 * The export therefore carries connection METADATA (which provider, which
 * account, when connected, current status) and no credential material at all.
 *
 * What the user loses by this: nothing they cannot recover at the source.
 * What they would risk by the alternative: a permanent third-party compromise.
 *
 * ---------------------------------------------------------------------------
 * 2. The export is issued as a single-use link, not returned inline.
 *
 * THREAT-MODEL M17. Returning a complete personal-data document synchronously
 * on a GET is a self-service denial of service against our own database (API4)
 * and puts the most sensitive response body in the system on a route that a
 * proxy or a client is most likely to cache.
 *
 * So `GET /v1/me/export` returns 202 with a signed, subject-bound, ten-minute,
 * single-use download link, and the document is produced on download. The link
 * is claimed atomically in the quota Redis, so a replay loses the race rather
 * than being checked and then invalidated.
 */

import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import { errors } from "../lib/errors.js";
import { claimOnce, incrementWindow } from "../lib/redis.js";
import type { Database } from "../lib/db.js";
import type { SigningKeys } from "../lib/keys.js";

export interface ExportServiceOptions {
  readonly publicBaseUrl: string;
  readonly linkTtlSeconds: number;
  readonly cooldownSeconds: number;
}

export interface ExportTicket {
  readonly downloadUrl: string;
  readonly expiresAt: string;
  readonly token: string;
}

/** The exported document. Deliberately flat, versioned, and self-describing. */
export interface ExportDocument {
  readonly format: "pullfm-export";
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly notice: string;
  readonly account: unknown;
  readonly connections: unknown[];
  readonly wishlist: unknown[];
  readonly apiTokens: unknown[];
  /**
   * The subject's recorded acceptances of the legal documents.
   *
   * Included because it is personal data ABOUT the subject that the subject
   * cannot reconstruct from anything else: it is the record of what agreement
   * they are under and when they entered it. An Article 20 export that omitted it
   * would hand a user everything except the terms they are bound by.
   *
   * `ip` and `user_agent` are excluded. They are corroboration of the act for our
   * benefit rather than data the subject provided, and echoing an address back
   * into a portable file that a user may forward is a disclosure with no
   * portability value.
   */
  readonly legalConsents: unknown[];
}

const EXCLUSION_NOTICE =
  "This export contains the data you provided to Pull.fm. It deliberately excludes " +
  "the access tokens and session keys held for your connected services: those are " +
  "bearer credentials for third-party systems, they can be regenerated at the " +
  "provider in under a minute, and including them would turn a stolen copy of this " +
  "file into a compromise of your ListenBrainz and Last.fm accounts. Connection " +
  "metadata is included so the export is still complete as a record of what was linked.";

export class ExportService {
  readonly #db: Database;
  readonly #keys: SigningKeys;
  readonly #quota: Redis;
  readonly #opts: ExportServiceOptions;

  constructor(
    db: Database,
    keys: SigningKeys,
    quota: Redis,
    opts: ExportServiceOptions,
  ) {
    this.#db = db;
    this.#keys = keys;
    this.#quota = quota;
    this.#opts = opts;
  }

  /**
   * Issues a download ticket, subject to a per-subject cooldown.
   *
   * The cooldown is the API4 control: without it, a loop over this route is a
   * self-inflicted denial of service on the database, and it is authenticated,
   * so the per-IP edge limit does not see it as abuse.
   */
  async requestExport(userId: string): Promise<ExportTicket> {
    const key = `quota:user:${userId}:export`;
    try {
      const { count, ttlSeconds } = await incrementWindow(
        this.#quota,
        key,
        this.#opts.cooldownSeconds,
      );
      if (count > 1) {
        throw errors.rateLimited(
          `An export was already requested. Try again in ${String(ttlSeconds)} seconds.`,
        );
      }
    } catch (err) {
      // A genuine 429 is rethrown; a Redis failure fails closed, because an
      // export cooldown that stops working is an unmetered database scan.
      if (err instanceof Error && "status" in err) throw err;
      throw errors.upstreamUnavailable("rate limiter");
    }

    const jti = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + this.#opts.linkTtlSeconds;
    const message = `${userId}|${jti}|${String(expiresAt)}`;
    const token = `${Buffer.from(message, "utf8").toString("base64url")}.${this.#keys.sign("exportLink", message)}`;

    return {
      token,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      downloadUrl: `${this.#opts.publicBaseUrl.replace(/\/+$/, "")}/v1/me/export/download?${new URLSearchParams(
        { token },
      ).toString()}`,
    };
  }

  /**
   * Verifies and atomically consumes a download ticket.
   *
   * Three things are checked and all three matter:
   *   - The signature, so the ticket was minted by us.
   *   - That the ticket's subject is the authenticated caller, so a ticket
   *     leaked into a URL bar, a referrer header, or a screenshot is useless to
   *     anyone else. The link is single-use AND session-bound; either alone is
   *     weaker than the pair.
   *   - The one-time claim, in Redis, atomically. Checking a "used" flag and
   *     then setting it is a time-of-check window two concurrent requests win.
   */
  async consumeTicket(userId: string, token: string): Promise<void> {
    const reject = (): never => {
      throw errors.badRequest(
        "This download link is not valid or has already been used.",
      );
    };

    const parts = token.split(".");
    if (parts.length !== 2) return reject();
    const [payload, mac] = parts as [string, string];

    let message: string;
    try {
      message = Buffer.from(payload, "base64url").toString("utf8");
    } catch {
      return reject();
    }
    if (!this.#keys.verify("exportLink", message, mac)) return reject();

    const fields = message.split("|");
    if (fields.length !== 3) return reject();
    const [ticketUserId, jti, expiresAtRaw] = fields as [
      string,
      string,
      string,
    ];
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() / 1000) {
      return reject();
    }
    if (ticketUserId !== userId) return reject();

    let claimed: boolean;
    try {
      claimed = await claimOnce(
        this.#quota,
        `export:ticket:${jti}`,
        this.#opts.linkTtlSeconds + 60,
      );
    } catch {
      throw errors.upstreamUnavailable("session store");
    }
    if (!claimed) return reject();
  }

  /**
   * Builds the document.
   *
   * Every query carries `user_id = $1`. The column lists are explicit and
   * enumerate exactly the non-credential columns: `SELECT *` here would ship
   * `access_token_ct`, `wrapped_dek`, and `kek_id` the first time someone added
   * a column, which is the failure this whole file exists to prevent.
   */
  async build(userId: string): Promise<ExportDocument> {
    const account = await this.#db.query(
      `SELECT id, email, display_name, created_at, updated_at
         FROM users WHERE id = $1`,
      [userId],
    );

    const connections = await this.#db.query(
      // No ciphertext, no wrapped_dek, no kek_id. Metadata only.
      `SELECT provider, provider_account_id, status, scopes,
              created_at, last_verified_at, access_expires_at
         FROM user_connections WHERE user_id = $1
        ORDER BY created_at`,
      [userId],
    );

    const wishlist = await this.#db.query(
      `SELECT id, recording_mbid, release_mbid, artist_mbid, artist_name, title,
              source, status, note, created_at, acquired_at
         FROM wishlist_items WHERE user_id = $1
        ORDER BY created_at`,
      [userId],
    );

    const tokens = await this.#db.query(
      // token_hash is excluded: it is not personal data, and publishing a
      // digest of a live credential is a gratuitous offline-attack surface.
      `SELECT id, name, token_prefix, last_four, scopes, created_at,
              expires_at, last_used_at, revoked_at
         FROM api_tokens WHERE user_id = $1
        ORDER BY created_at`,
      [userId],
    );

    const consents = await this.#db.query(
      `SELECT document_id, document_version, consent_epoch, content_sha256,
              accepted_at, gate, client_build, client_platform
         FROM legal_consents WHERE user_id = $1
        ORDER BY accepted_at`,
      [userId],
    );

    return {
      format: "pullfm-export",
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      notice: EXCLUSION_NOTICE,
      account: account.rows[0] ?? null,
      connections: connections.rows,
      wishlist: wishlist.rows,
      apiTokens: tokens.rows,
      legalConsents: consents.rows,
    };
  }
}

export { EXCLUSION_NOTICE };
