/**
 * Authentication and subject resolution.
 *
 * Two credential types reach this plugin and they are deliberately not
 * interchangeable:
 *
 *   Session   A WorkOS access token (a JWT), verified against the WorkOS JWKS.
 *             Carries full authority, including the irreversible operations.
 *   Token     A personal API token (`pfm_live_...`), verified by digest against
 *             `api_tokens`. Read-only, scoped, rate limited per token.
 *
 * A session arrives over one of TWO TRANSPORTS, which is not the same as being
 * a third credential type and must not be allowed to become one:
 *
 *   Authorization: Bearer <jwt>   what a mobile client sends.
 *   the sealed session cookie     what a browser client sends, because anything
 *                                 JavaScript can read an XSS can exfiltrate.
 *
 * The cookie is opened, the access token is taken OUT of it, and that token
 * goes through exactly the same `fromSession` verification a bearer token goes
 * through: same JWKS, same issuer and audience checks, same revocation deny
 * list, same active-subject lookup. Nothing is trusted because it came from a
 * cookie. See lib/session-cookie.ts for why the cookie is encrypted rather
 * than signed.
 *
 * Cookies bring CSRF, which bearer tokens structurally cannot have, so two
 * independent controls apply and both are needed. `SameSite=Strict` on the
 * cookie itself is the first. The second is here: a cookie-borne session is
 * only honoured when the request also carries the `X-Pullfm-Session` header.
 * A cross-site form post cannot set a custom header at all, and a cross-origin
 * XHR that tries triggers a CORS preflight, which this API answers only for the
 * exact origins in CORS_ORIGINS. Relying on SameSite alone would put the whole
 * control in browser behaviour we do not own and cannot test here.
 *
 * The asymmetry is the point. A personal token cannot mint another token,
 * cannot start or delete a connection, and cannot delete the account. If it
 * could, a leaked read-only token would be a persistence mechanism: the
 * attacker mints a second token, and revoking the first changes nothing.
 *
 * Everything the rest of the application knows about "who is calling" comes
 * from `request.subject`, which is populated only here and only from a verified
 * credential. THREAT-MODEL M14: a client-supplied `X-User-Id` header or a
 * `user_id` body field is rejected outright, never honoured and never silently
 * ignored, because silently ignoring it makes the next reviewer wonder.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preValidationHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Redis } from "ioredis";

import { errors } from "../lib/errors.js";
import { incrementWindow } from "../lib/redis.js";
import { readCookie, type SessionCookieCipher } from "../lib/session-cookie.js";
import type { TokenService } from "../services/tokens.js";
import type { UserService } from "../services/users.js";

/**
 * The header a cookie-authenticated request must carry.
 *
 * Its VALUE is irrelevant and is deliberately not checked: the security
 * property is that a cross-site attacker cannot cause the header to be sent at
 * all, not that they cannot guess a value. Checking a value would imply a
 * secret that this is not, and would invite someone to treat it as one.
 */
export const SESSION_TRANSPORT_HEADER = "x-pullfm-session";

/** WorkOS signs access tokens with RS256. Anything else is a downgrade. */
const ALLOWED_ALGORITHMS = ["RS256"] as const;

/** How a request proved who it is. */
export type AuthMethod = "session" | "token";

export interface Subject {
  readonly userId: string;
  readonly workosUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly method: AuthMethod;
  /** WorkOS session id (`sid`). Present for session auth, used for revocation. */
  readonly sessionId: string | null;
  /** `api_tokens.id`. Present for token auth. */
  readonly tokenId: string | null;
  readonly scopes: readonly string[];
  /** Unix seconds at which this credential was issued (JWT `iat`). */
  readonly authenticatedAt: number;
}

/**
 * Why a route refuses a personal API token, as a route CLASS.
 *
 * The 403 used to be one sentence for every session-only route: "This operation
 * requires an interactive session. Personal API tokens are read-only." On a
 * mutating route that is exactly right. On `GET /v1/search` and
 * `GET /v1/artists/{mbid}` it is self-contradictory - both are reads - and the
 * first thing a developer concludes is that they minted their token wrong.
 *
 * VERIFIED RATHER THAN ASSUMED, because the obvious inference is wrong. The
 * catalogue routes are NOT session-only because they reach a provider:
 * `security/zap/upstream-scope.tsv` classifies `GET /v1/search`,
 * `GET /v1/artists/{mbid}`, `GET /v1/tracks/{mbid}` and `GET /v1/albums/{mbid}`
 * as `none`, meaning no input can make them call a third party, and
 * services/discovery.ts confirms it: those paths are `CachedUpstream.peek` and
 * a Postgres trigram search. Only `/similar`, `/preview` and `/events` are
 * classified `egress`.
 *
 * The reason that IS true of the whole catalogue class is the licence one this
 * API already publishes in plugins/docs.ts: upstream providers licence their
 * data for use rather than redistribution, and a personal token is a long-lived
 * script-facing credential whose consumer we cannot see. That is the same
 * argument that keeps SeatGeek events session-only under their clause 7.13.
 *
 * The message is derived from this value alone, never from the request, so it
 * cannot become a discovery oracle: an MBID that exists, one that is merely
 * uncached, and one that was never real all produce the identical 403.
 */
export type SessionOnlyReason = "mutating" | "catalogue" | "catalogue-upstream";

const SESSION_ONLY_DETAIL: Readonly<Record<SessionOnlyReason, string>> = {
  mutating:
    "This operation requires an interactive session. Personal API tokens are read-only, " +
    "so a leaked token cannot mint another credential, change a connection, or delete the account.",
  catalogue:
    "This is a catalogue route and it requires an interactive session. Not because your token is " +
    "read-only - this is a read - but because the catalogue is third-party data licensed to Pull.fm " +
    "for use rather than redistribution, and a personal API token is a long-lived credential whose " +
    "consumer we cannot see. Your token works on your own data: /v1/feed, /v1/recommendations, " +
    "/v1/stations, /v1/me and /v1/wishlist.",
  "catalogue-upstream":
    "This is a catalogue route and it requires an interactive session, for two reasons and neither " +
    "is that your token is read-only. The catalogue is third-party data licensed to Pull.fm for use " +
    "rather than redistribution, and this route can make a request to a provider on your behalf out " +
    "of an allowance shared by every user. Your token works on your own data: /v1/feed, " +
    "/v1/recommendations, /v1/stations, /v1/me and /v1/wishlist.",
};

export interface RequireAuthOptions {
  /** Credential types accepted. Defaults to session only. */
  readonly allow?: readonly AuthMethod[];
  /** Scope a personal token must hold. Ignored for session auth. */
  readonly scope?: string;
  /**
   * Which explanation a personal token gets when this route refuses it.
   *
   * Defaults to `mutating`, which is the accurate answer for every platform
   * route and preserves the existing wording where it was already true. It
   * changes NO route's authorization: `allow` alone decides that.
   */
  readonly sessionOnlyReason?: SessionOnlyReason;
}

declare module "fastify" {
  interface FastifyRequest {
    subject: Subject | null;
  }
  interface FastifyInstance {
    requireAuth: (opts?: RequireAuthOptions) => preValidationHookHandler;
    /** Revokes a session id locally until its token would have expired. */
    revokeSessionLocally: (
      sessionId: string,
      expiresAt: number,
    ) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  readonly jwksUrl: string;
  readonly clientId: string;
  readonly workosApiBaseUrl: string;
  readonly users: UserService;
  readonly tokens: TokenService;
  /** The `noeviction` instance. A revocation entry must never be evicted. */
  readonly quotaRedis: Redis;
  /** Fails closed when the quota store is unreachable. */
  readonly failClosed?: boolean;
  /**
   * Called when a fail-closed path actually fires, with which store failed.
   *
   * This exists because the failure it reports is INVISIBLE otherwise. When the
   * quota Redis is unreachable the limiter refuses the request, correctly, and
   * the user gets a 503 that is indistinguishable from an upstream provider
   * being down. Nothing was logged, nothing was counted, and the only clue was
   * the word "rate limiter" inside a client-facing message. S3 in
   * docs/RUNBOOK-INCIDENT.md is exactly this condition and it was, until now,
   * unobservable from inside the service.
   */
  readonly onFailClosed?: (store: "rate limiter" | "session store") => void;
  /**
   * Opens the sealed session cookie. Absent disables the cookie transport
   * entirely, which is a valid deployment: bearer-only is the stricter mode.
   */
  readonly sessionCookie?: {
    readonly cipher: SessionCookieCipher;
    readonly name: string;
  };
}

/** Prefix under which locally revoked session ids are held. */
const REVOKED_PREFIX = "revoked:sid:";

/**
 * Session revocation is stored in the QUOTA Redis, not the cache Redis.
 *
 * This looks like a detail and is not. Eviction policy in Redis is per
 * instance. On the cache instance (`allkeys-lru`) a revocation entry is
 * evictable, so a cache-fill event would silently un-revoke every logged-out
 * session. The quota instance runs `noeviction`, where the failure mode is a
 * loud write error instead. Same reasoning as THREAT-MODEL T11, different key.
 */
export const revokedSessionKey = (sessionId: string): string =>
  `${REVOKED_PREFIX}${sessionId}`;

// eslint-disable-next-line @typescript-eslint/require-await
async function authPlugin(
  app: FastifyInstance,
  opts: AuthPluginOptions,
): Promise<void> {
  // `createRemoteJWKSet` caches the key set and refetches on a `kid` miss with
  // a cooldown. Refetch-on-miss rather than refetch-per-request is deliberate:
  // without the cooldown, an attacker sending random `kid` values turns our
  // auth path into a request amplifier aimed at WorkOS (M18).
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 3_000,
  });

  /**
   * The expected issuer.
   *
   * WorkOS mints access tokens with an issuer that embeds the client id, which
   * is what makes cross-application token replay fail: a token minted for a
   * different WorkOS application has a different `iss`. `aud` is additionally
   * enforced when the token carries one, so a future WorkOS change that starts
   * populating it is picked up rather than ignored. M18 asks for `iss`, `aud`,
   * `exp` and `nbf`; `exp` and `nbf` are enforced by `jwtVerify` itself.
   */
  const expectedIssuer = `${opts.workosApiBaseUrl.replace(/\/+$/, "")}/user_management/${opts.clientId}`;

  app.decorateRequest("subject", null);

  app.decorate(
    "revokeSessionLocally",
    async (sessionId: string, expiresAt: number): Promise<void> => {
      const ttl = Math.max(1, Math.ceil(expiresAt - Date.now() / 1000));
      await opts.quotaRedis.set(revokedSessionKey(sessionId), "1", "EX", ttl);
    },
  );

  async function isRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await opts.quotaRedis.exists(revokedSessionKey(sessionId))) === 1;
    } catch {
      // Fail closed. A revocation store we cannot read is a revocation store we
      // must assume says "revoked" for the security-relevant direction; the
      // alternative is honouring a session the user believes they ended.
      if (opts.failClosed !== false) {
        opts.onFailClosed?.("session store");
        throw errors.upstreamUnavailable("session store");
      }
      return false;
    }
  }

  async function fromSession(bearer: string): Promise<Subject> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearer, jwks, {
        issuer: expectedIssuer,
        algorithms: [...ALLOWED_ALGORITHMS],
        // Tokens are short-lived; a minute of clock skew is generous for a
        // system whose clocks are NTP-disciplined, and more would extend the
        // life of a leaked token for no operational benefit.
        clockTolerance: 60,
      }));
    } catch {
      // Uniform. The caller must not learn whether the signature, the issuer,
      // the algorithm, or the expiry was the problem.
      throw errors.unauthorized("The credential is not valid.");
    }

    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      throw errors.unauthorized("The credential is not valid.");
    }
    // Enforce `aud` when present. Absent-and-unchecked is the documented WorkOS
    // shape; present-and-wrong is a token for another application.
    if (payload.aud !== undefined) {
      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud];
      if (!audiences.includes(opts.clientId)) {
        throw errors.unauthorized("The credential is not valid.");
      }
    }

    const sid = typeof payload["sid"] === "string" ? payload["sid"] : null;
    if (sid !== null && (await isRevoked(sid))) {
      throw errors.unauthorized("This session has been signed out.");
    }

    const user = await opts.users.findActiveByWorkOsId(sub);
    if (user === null) {
      // A structurally valid token for a subject we have no active record of.
      // That is a deleted account or a user who has not completed the callback,
      // and in both cases the answer is 401 rather than an implicit signup:
      // creating a row here would resurrect a deleted account.
      throw errors.unauthorized("The credential is not valid.");
    }

    return {
      userId: user.id,
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: user.displayName,
      method: "session",
      sessionId: sid,
      tokenId: null,
      // A session holds every scope; scope only constrains personal tokens.
      scopes: ["*"],
      authenticatedAt:
        typeof payload.iat === "number"
          ? payload.iat
          : Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Per-token rate limiting, counted in the quota Redis.
   *
   * Separate from the global per-IP limiter because the thing being protected
   * is different: the global limiter stops one host flooding the edge, this one
   * stops one credential consuming a user's share of the backend regardless of
   * how many hosts it is used from. A per-token budget is also the only limit
   * that survives an attacker rotating IP addresses.
   *
   * Fails CLOSED. That is the whole reason the quota instance exists.
   */
  async function enforceTokenRateLimit(
    tokenId: string,
    limit: number,
    reply: FastifyReply,
  ): Promise<void> {
    const window = 60;
    const key = `quota:token:${tokenId}:${String(Math.floor(Date.now() / 1000 / window))}`;
    let count: number;
    let ttl: number;
    try {
      ({ count, ttlSeconds: ttl } = await incrementWindow(
        opts.quotaRedis,
        key,
        window,
      ));
    } catch {
      // A rate limiter that fails open is not a rate limiter. THREAT-MODEL T11
      // is about this exact failure being silent; here it is explicit.
      //
      // "Explicit" used to mean explicit to the CALLER only. The 503 it raises
      // is the same shape as an upstream provider outage, so from the outside a
      // dead quota store looked like a flaky music API. The notification is
      // what makes S3 detectable rather than merely designed.
      opts.onFailClosed?.("rate limiter");
      throw errors.upstreamUnavailable("rate limiter");
    }

    void reply.header("ratelimit-limit", String(limit));
    void reply.header(
      "ratelimit-remaining",
      String(Math.max(0, limit - count)),
    );
    void reply.header("ratelimit-reset", String(ttl));
    if (count > limit) {
      void reply.header("retry-after", String(ttl));
      throw errors.rateLimited(
        "This API token has exceeded its per-minute request budget.",
      );
    }
  }

  async function fromToken(
    bearer: string,
    reply: FastifyReply,
    request: FastifyRequest,
  ): Promise<Subject> {
    const authenticated = await opts.tokens.authenticate(bearer);
    if (authenticated === null) {
      // Identical response for unknown, expired, and revoked. Distinguishing
      // them tells an attacker which of their guesses were once real.
      throw errors.unauthorized("The credential is not valid.");
    }

    await enforceTokenRateLimit(
      authenticated.tokenId,
      authenticated.rateLimitPerMinute,
      reply,
    );

    const user = await opts.users.findActiveById(authenticated.userId);
    if (user === null) {
      throw errors.unauthorized("The credential is not valid.");
    }

    // Best effort and deliberately not awaited into the critical path's failure
    // mode: a throttled bookkeeping UPDATE must never fail the read it records.
    void opts.tokens
      .touch(opts.tokens.db, authenticated.tokenId, request.ip)
      .catch((err: unknown) => {
        request.log.warn({ err }, "failed to record token use");
      });

    return {
      userId: user.id,
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: user.displayName,
      method: "token",
      sessionId: null,
      tokenId: authenticated.tokenId,
      scopes: authenticated.scopes,
      authenticatedAt: Math.floor(Date.now() / 1000),
    };
  }

  app.decorate("requireAuth", (options: RequireAuthOptions = {}) => {
    const allow = options.allow ?? (["session"] as const);

    // An async preValidation hook is exactly what Fastify expects; the rule
    // cannot see that this variable's declared type is a hook rather than a
    // plain void callback.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const handler: preValidationHookHandler = async (request, reply) => {
      // M14: a client-supplied subject identifier is rejected, not ignored.
      // Rejecting is the version that shows up in a log and in a test.
      if (request.headers["x-user-id"] !== undefined) {
        throw errors.badRequest(
          "X-User-Id is not accepted. The subject is derived from the credential.",
        );
      }
      const body = request.body;
      if (
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Object.hasOwn(body, "user_id")
      ) {
        throw errors.badRequest(
          "user_id is not accepted in a request body. The subject is derived from the credential.",
        );
      }

      // Transport resolution. The Authorization header wins outright when it
      // is present: a request that sends both is a client with a stale cookie
      // and a fresh token, and honouring the explicit credential is the least
      // surprising answer. It also means the cookie can never silently upgrade
      // a request whose bearer token was rejected.
      const header = request.headers.authorization;
      let credential: string | null = null;
      let viaCookie = false;

      if (typeof header === "string") {
        if (!header.startsWith("Bearer ")) throw errors.unauthorized();
        credential = header.slice("Bearer ".length).trim();
      } else if (opts.sessionCookie !== undefined) {
        const sealed = readCookie(
          request.headers.cookie,
          opts.sessionCookie.name,
        );
        if (sealed !== null) {
          // CSRF control 2 of 2. See the header note at the top of this file:
          // the absence of the header is what a cross-site request cannot fix.
          if (request.headers[SESSION_TRANSPORT_HEADER] === undefined) {
            throw errors.forbidden(
              `A cookie session requires the ${SESSION_TRANSPORT_HEADER} header. ` +
                "This is the cross-site request forgery control; add the header to your client.",
            );
          }
          const opened = opts.sessionCookie.cipher.open(sealed);
          // A cookie that does not open is treated exactly like no cookie at
          // all. It has been tampered with, sealed under a rotated key, or has
          // passed its outer expiry, and the caller must not be able to tell
          // which.
          if (opened === null) throw errors.unauthorized();
          credential = opened.accessToken;
          viaCookie = true;
        }
      }

      if (credential === null || credential.length === 0) {
        throw errors.unauthorized();
      }

      // The prefix decides which verifier runs. A personal token is never fed
      // to the JWT verifier and a JWT is never hashed against api_tokens, so
      // there is no path where one credential type is accepted where the other
      // was required.
      const looksLikeApiToken = credential.startsWith("pfm_");

      // A personal API token has no business inside a session cookie. It could
      // only get there by our own code sealing one, which nothing does, so this
      // is a structural assertion rather than an expected case: without it, a
      // future bug that sealed the wrong value would silently grant a read-only
      // credential the cookie transport's CSRF surface.
      if (viaCookie && looksLikeApiToken) throw errors.unauthorized();

      if (looksLikeApiToken) {
        if (!allow.includes("token")) {
          // Constant per route. Nothing about the request, the subject, or the
          // state of the catalogue reaches this string; see SessionOnlyReason.
          throw errors.forbidden(
            SESSION_ONLY_DETAIL[options.sessionOnlyReason ?? "mutating"],
          );
        }
        const subject = await fromToken(credential, reply, request);
        if (
          options.scope !== undefined &&
          !subject.scopes.includes(options.scope)
        ) {
          throw errors.forbidden(
            `This token does not hold the required scope "${options.scope}".`,
          );
        }
        request.subject = subject;
        return;
      }

      if (!allow.includes("session")) {
        throw errors.unauthorized();
      }
      request.subject = await fromSession(credential);
    };

    return handler;
  });
}

export default fp(authPlugin, { name: "pullfm-auth" });

/**
 * Narrows `request.subject` for handlers that ran behind `requireAuth`.
 *
 * A handler that forgets the preHandler gets a 500 here rather than a null
 * dereference producing an unauthenticated read, which is the failure mode this
 * exists to make impossible.
 */
export function subjectOf(request: FastifyRequest): Subject {
  const subject = request.subject;
  if (subject === null) {
    throw new Error(
      "handler reached without an authenticated subject: requireAuth is missing from this route",
    );
  }
  return subject;
}
