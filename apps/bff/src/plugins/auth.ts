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
import type { TokenService } from "../services/tokens.js";
import type { UserService } from "../services/users.js";

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

export interface RequireAuthOptions {
  /** Credential types accepted. Defaults to session only. */
  readonly allow?: readonly AuthMethod[];
  /** Scope a personal token must hold. Ignored for session auth. */
  readonly scope?: string;
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

      const header = request.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        throw errors.unauthorized();
      }
      const credential = header.slice("Bearer ".length).trim();
      if (credential.length === 0) throw errors.unauthorized();

      // The prefix decides which verifier runs. A personal token is never fed
      // to the JWT verifier and a JWT is never hashed against api_tokens, so
      // there is no path where one credential type is accepted where the other
      // was required.
      const looksLikeApiToken = credential.startsWith("pfm_");

      if (looksLikeApiToken) {
        if (!allow.includes("token")) {
          throw errors.forbidden(
            "This operation requires an interactive session. Personal API tokens are read-only.",
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
