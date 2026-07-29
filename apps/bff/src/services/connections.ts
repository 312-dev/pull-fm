/**
 * The per-user credential vault: connect, list, disconnect.
 *
 * This is asset A1. A bug here does not leak our data, it leaks other people's
 * third-party accounts on systems we do not operate and cannot revoke.
 * Everything below is written against THREAT-MODEL AT-1 branch 3 (steal at the
 * source) and branch 2 (make the application decrypt for you).
 *
 * The four rules that matter:
 *
 *   1. **No route ever returns a credential** (M12). Not to an attacker, not to
 *      the owner, not in an export. The public shape of a connection has no
 *      field that could hold one, and the response schema on the route is a
 *      second, structural enforcement of that.
 *
 *   2. **A connection is resolved from the subject, never addressed by the
 *      client** (M10). The only client-supplied key is `:service`, and every
 *      lookup is `where user_id = $subject and provider = $service`. There is
 *      no connection id in the API surface at all, which removes the object
 *      whose id could be substituted.
 *
 *   3. **Connect state is single-use, subject-bound, and expiring** (M20).
 *      Consumption is a `DELETE ... RETURNING`, so a replay loses the race
 *      rather than being checked and then deleted.
 *
 *   4. **AAD binds user, provider, and column** into the GCM tag, so a
 *      ciphertext moved between rows or columns by an attacker with database
 *      write access fails to authenticate rather than decrypting into the wrong
 *      user's session (M02/T08).
 */

import { createHash, randomBytes } from "node:crypto";

import { EnvelopeCipher } from "@pull-fm/crypto";

import { errors } from "../lib/errors.js";
import type { Database } from "../lib/db.js";

export const PROVIDERS = ["listenbrainz", "lastfm"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * The public shape of a connection.
 *
 * Note what is absent and note that the absence is the feature: no token, no
 * session key, no wrapped DEK, no kek id, no ciphertext. There is nothing here
 * that a serialization bug could turn into a credential disclosure.
 */
export interface ConnectionView {
  readonly provider: Provider;
  readonly providerAccountId: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly connectedAt: string;
  readonly lastVerifiedAt: string | null;
}

interface ConnectionRow {
  provider: string;
  provider_account_id: string;
  status: string;
  scopes: string[] | null;
  created_at: Date;
  last_verified_at: Date | null;
}

function toView(row: ConnectionRow): ConnectionView {
  return {
    provider: row.provider as Provider,
    providerAccountId: row.provider_account_id,
    status: row.status,
    scopes: row.scopes ?? [],
    connectedAt: row.created_at.toISOString(),
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
  };
}

/**
 * What a provider needs from the world to complete a connection.
 *
 * An interface rather than a concrete client for two reasons. First, the real
 * upstream clients live in `packages/upstream`, which is a separate work
 * stream. Second, and more importantly, security/BOLA-TESTING.md section 4
 * requires that the BOLA suite can create a real connection row through the
 * real service-layer code without contacting a third party. A registry the
 * tests can populate with a mock provider is what makes that possible without
 * the suite reaching below the service layer.
 */
export interface ProviderAdapter {
  /**
   * Returns the URL the user is sent to, given a state value we minted.
   * `null` means this provider has no redirect flow (ListenBrainz: the user
   * pastes a token they generated themselves).
   */
  authorizeUrl(state: string, callbackUrl: string): string | null;
  /**
   * Exchanges whatever the callback carried for a durable credential.
   * Called with the raw query of the callback request.
   */
  completeCallback(query: Record<string, string>): Promise<ProviderCredential>;
  /** Verifies a credential the user supplied directly (ListenBrainz). */
  verifyDirect?(credential: string): Promise<ProviderCredential>;
}

export interface ProviderCredential {
  readonly providerAccountId: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly scopes?: readonly string[] | undefined;
}

export type ProviderRegistry = Partial<Record<Provider, ProviderAdapter>>;

/** State lifetime. Long enough for a slow OAuth round trip, short enough that a
 *  stolen state is dead before it can be used. */
const STATE_TTL_MS = 10 * 60 * 1000;

const hashState = (state: string): string =>
  createHash("sha256").update(state, "utf8").digest("hex");

export interface ConnectionServiceOptions {
  readonly publicBaseUrl: string;
  readonly providers: ProviderRegistry;
}

export class ConnectionService {
  readonly #db: Database;
  readonly #cipher: EnvelopeCipher;
  readonly #opts: ConnectionServiceOptions;

  constructor(
    db: Database,
    cipher: EnvelopeCipher,
    opts: ConnectionServiceOptions,
  ) {
    this.#db = db;
    this.#cipher = cipher;
    this.#opts = opts;
  }

  callbackUrl(provider: Provider): string {
    return `${this.#opts.publicBaseUrl.replace(/\/+$/, "")}/v1/connections/${provider}/callback`;
  }

  async list(userId: string): Promise<ConnectionView[]> {
    const { rows } = await this.#db.query<ConnectionRow>(
      `SELECT provider, provider_account_id, status, scopes, created_at, last_verified_at
         FROM user_connections
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at`,
      [userId],
    );
    return rows.map(toView);
  }

  /**
   * Starts a connect flow.
   *
   * The state is 32 random bytes, returned to the caller in plaintext and
   * stored only as a digest, for the same reason an API token is: the row is
   * the thing an attacker with read access to the database would otherwise be
   * able to replay.
   *
   * The unique index on (user_id, provider) means starting a second flow
   * replaces the first rather than accumulating, so this cannot be used to fill
   * the table.
   */
  async startConnect(
    userId: string,
    provider: Provider,
  ): Promise<{
    authorizeUrl: string | null;
    state: string;
    expiresAt: string;
  }> {
    const adapter = this.#opts.providers[provider];
    if (adapter === undefined) {
      throw errors.notImplemented(
        `The ${provider} connector is not enabled on this deployment.`,
      );
    }

    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    const callback = this.callbackUrl(provider);

    await this.#db.query(
      `INSERT INTO connect_states (state_hash, user_id, provider, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider) DO UPDATE
          SET state_hash = EXCLUDED.state_hash,
              redirect_uri = EXCLUDED.redirect_uri,
              created_at = now(),
              expires_at = EXCLUDED.expires_at`,
      [hashState(state), userId, provider, callback, expiresAt],
    );

    return {
      authorizeUrl: adapter.authorizeUrl(state, callback),
      state,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Consumes a connect state exactly once, for one specific subject.
   *
   * Three properties, and dropping any one of them reopens T22:
   *
   *   Atomic       `DELETE ... RETURNING`. A replay loses the race rather than
   *                being checked and then deleted, which is a window two
   *                concurrent callbacks both win.
   *
   *   Subject-bound `user_id = $subject` is a predicate of the DELETE, not a
   *                comparison afterwards. This is what defeats connection
   *                grafting: an attacker who gets a victim's browser to follow
   *                a callback carrying the ATTACKER's state cannot complete it,
   *                because the victim's session does not own that state. It
   *                also means a foreign state is not consumed by the attempt,
   *                so an attacker cannot burn a victim's in-flight connect.
   *
   *   Uniform      Unknown, expired, foreign, and replayed states all produce
   *                the identical 400. A differential response here tells an
   *                attacker whether a guessed state was ever real.
   */
  async consumeState(
    userId: string,
    state: string,
    provider: Provider,
  ): Promise<{ redirectUri: string | null }> {
    const { rows } = await this.#db.query<{ redirect_uri: string | null }>(
      `DELETE FROM connect_states
        WHERE state_hash = $1 AND provider = $2 AND user_id = $3
          AND expires_at > now()
        RETURNING redirect_uri`,
      [hashState(state), provider, userId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw errors.badRequest(
        "This connect link is no longer valid. Start the connection again.",
      );
    }
    return { redirectUri: row.redirect_uri };
  }

  /**
   * Seals a credential into the vault.
   *
   * The plaintext is a parameter and a local. It is never assigned to the
   * request, the reply, a cache, or a log line, which is the M09 rule the
   * Semgrep rule `pullfm-no-decrypted-token-on-request` enforces mechanically.
   */
  async store(
    userId: string,
    provider: Provider,
    credential: ProviderCredential,
  ): Promise<ConnectionView> {
    const access = this.#cipher.seal(credential.accessToken, {
      userId,
      provider,
      field: "access_token",
    });
    const refresh =
      credential.refreshToken === undefined
        ? null
        : this.#cipher.seal(credential.refreshToken, {
            userId,
            provider,
            field: "refresh_token",
          });

    const { rows } = await this.#db.query<ConnectionRow>(
      `INSERT INTO user_connections
         (user_id, provider, provider_account_id, kek_id, wrapped_dek,
          access_token_ct, refresh_token_ct, access_expires_at, scopes,
          status, last_verified_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', now(), NULL)
       ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE
          SET kek_id            = EXCLUDED.kek_id,
              wrapped_dek       = EXCLUDED.wrapped_dek,
              access_token_ct   = EXCLUDED.access_token_ct,
              refresh_token_ct  = EXCLUDED.refresh_token_ct,
              access_expires_at = EXCLUDED.access_expires_at,
              scopes            = EXCLUDED.scopes,
              status            = 'active',
              last_error        = NULL,
              revoked_at        = NULL,
              last_verified_at  = now()
       RETURNING provider, provider_account_id, status, scopes, created_at, last_verified_at`,
      [
        userId,
        provider,
        credential.providerAccountId,
        access.kekId,
        access.wrappedDek,
        access.ciphertext,
        refresh?.ciphertext ?? null,
        credential.expiresAt ?? null,
        credential.scopes === undefined ? null : [...credential.scopes],
      ],
    );

    const row = rows[0];
    /* c8 ignore next 3 -- RETURNING on an upsert always yields a row */
    if (row === undefined) throw new Error("connection upsert returned no row");
    return toView(row);
  }

  /**
   * Disconnects a provider.
   *
   * The ownership predicate is in the DELETE itself. A foreign or unknown
   * service matches zero rows, and the route answers 404 rather than 403 so the
   * response cannot be used to learn which services another user has connected.
   */
  async disconnect(userId: string, provider: Provider): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      `DELETE FROM user_connections
        WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return (rowCount ?? 0) > 0;
  }

  adapterFor(provider: Provider): ProviderAdapter {
    const adapter = this.#opts.providers[provider];
    if (adapter === undefined) {
      throw errors.notImplemented(
        `The ${provider} connector is not enabled on this deployment.`,
      );
    }
    return adapter;
  }
}
