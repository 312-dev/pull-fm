/**
 * Fastify application assembly.
 *
 * Kept separate from `index.ts` so tests can build an app instance without
 * binding a port or starting the shutdown machinery. The security suites build
 * a REAL application here, with a real database and a substituted identity
 * provider, which is only possible because every dependency arrives as a
 * parameter (security/BOLA-TESTING.md section 3).
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import type { Config } from "./config.js";
import { loggerOptions } from "./lib/logger.js";
import { redisHealthy } from "./lib/redis.js";
import {
  ApiError,
  errors,
  internalProblem,
  PROBLEM_CONTENT_TYPE,
} from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import { registerDocs, registerOpenApi } from "./plugins/docs.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { Services } from "./routes/deps.js";
import { registerV1Routes } from "./routes/v1/index.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Retain the exact request bytes for signature verification. */
    rawBody?: boolean;
  }
  interface FastifyRequest {
    /** Populated only for routes that opt in with `config: { rawBody: true }`. */
    rawBody?: Buffer;
  }
}

export interface BuildOptions {
  readonly services: Services;
  /** Overrides DOCS_ENABLED, so the security suites do not pay for the bundle. */
  readonly enableDocsBrowser?: boolean;
  /**
   * Called once per registered route, before any route exists.
   *
   * Exists so a test can compare the ROUTER against the emitted document.
   * "The OpenAPI spec is the source of truth" (Gate 2) is only true if a route
   * cannot exist without appearing in it, and that comparison needs the
   * router's own view rather than a parsed pretty-printed tree.
   */
  readonly onRouteRegistered?: (route: {
    method: string | string[];
    url: string;
    hidden: boolean;
  }) => void;
}

export async function buildServer(
  cfg: Config,
  opts: BuildOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions({
      level: cfg.LOG_LEVEL,
      isProduction: cfg.isProduction,
      deployEnv: cfg.DEPLOY_ENV,
    }),
    // Trust the proxy chain: we sit behind Cloudflare and a Hetzner load
    // balancer, so without this every client IP is the load balancer's and
    // per-IP rate limiting silently protects nothing.
    trustProxy: true,
    // Surfaced to clients as the problem `instance` and logged with every
    // record, so a user-reported error maps to a log line.
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
    // Cap request bodies. The largest legitimate write is a wishlist item.
    bodyLimit: 64 * 1024,
    disableRequestLogging: false,
  });

  /**
   * JSON parsing, with the raw bytes retained where a route asks for them.
   *
   * The WorkOS webhook signature covers the RAW body. Verifying against a
   * re-serialised object is the classic mistake: `JSON.parse` followed by
   * `JSON.stringify` reorders keys and normalises escapes and number
   * formatting, so the signature verifies almost always, which means it fails
   * in production on the one payload that differs.
   *
   * The buffer is kept only for routes that opt in, so no memory is spent on
   * the other 99% of requests. Routing runs before body parsing in Fastify, so
   * `routeOptions.config` is already available here.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const buffer = body as Buffer;
      if (request.routeOptions.config.rawBody === true) {
        request.rawBody = buffer;
      }
      if (buffer.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(buffer.toString("utf8")) as unknown);
      } catch {
        const err = errors.badRequest("The request body is not valid JSON.");
        done(err, undefined);
      }
    },
  );

  await app.register(helmet, {
    /**
     * This is a JSON API with no browsable HTML, so the policy that fits it is
     * the one THREAT-MODEL M27 names: deny everything, then deny framing,
     * base-tag rewriting, and form submission explicitly because those are not
     * covered by `default-src`.
     *
     * `useDefaults` is off deliberately. Helmet's defaults are written for a
     * page that renders something, so they add `script-src 'self'`,
     * `style-src 'self' https: 'unsafe-inline'`, and `font-src ... https:`,
     * every one of which is a permission this API has no use for. Merging them
     * in would mean the API advertises a laxer policy than it needs, which is
     * exactly the kind of drift a header audit is supposed to catch.
     *
     * The documentation prefix relaxes this inside its own encapsulation
     * context and nowhere else; see plugins/docs.ts.
     */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts:
      cfg.DEPLOY_ENV !== "local"
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
  });

  await app.register(cors, {
    origin: cfg.CORS_ORIGINS.length > 0 ? cfg.CORS_ORIGINS : false,
    credentials: true,
    // Idempotency-Key must be accepted or every mutating call fails from a
    // browser client.
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
      // The cookie transport's CSRF control (plugins/auth.ts). It must be
      // allowlisted here or a legitimate browser client's preflight fails, and
      // it must NOT be allowlisted for a wildcard origin, which loadConfig
      // already refuses outside local development.
      "X-Pullfm-Session",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
    ],
  });

  /**
   * Global rate limit.
   *
   * This is a floor, not the real control. Personal API tokens carry their own
   * per-token budget (plugins/auth.ts), counted in the `noeviction` quota Redis
   * so it cannot be silently disabled by cache pressure, and the endpoints that
   * spend metered upstream quota get tighter limits still.
   *
   * Keyed on the client IP and on nothing else. Two things are deliberately
   * NOT used:
   *
   *   A client-supplied header. Keying on anything the caller controls lets an
   *   attacker reset their own bucket by changing a value (T02), which is worse
   *   than having no limiter because it looks like one.
   *
   *   The authenticated subject. This limiter runs at `onRequest`, before the
   *   credential has been verified, so the subject genuinely is not known yet.
   *   Per-subject budgets belong where the subject exists: the per-token
   *   limiter in plugins/auth.ts, counted in the `noeviction` quota Redis.
   *
   * `req.ip` is trustworthy here only because `trustProxy` is set and the
   * origin accepts connections from Cloudflare alone (M24); without that
   * property this would be attacker-controlled too.
   */
  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => errors.rateLimited().toProblem(),
  });

  /**
   * Maintenance mode.
   *
   * Health endpoints stay up so the orchestrator and uptime checker can still
   * distinguish "intentionally down" from "crashed".
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!cfg.MAINTENANCE_MODE) return;
    if (req.url.startsWith("/healthz") || req.url.startsWith("/readyz")) return;

    const problem = errors.maintenance().toProblem(req.id);
    await reply
      .code(503)
      .header("retry-after", "300")
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem);
  });

  // Every response carries its request id so a user-reported failure is
  // traceable without asking them to reproduce it.
  app.addHook("onSend", async (req, reply) => {
    void reply.header("x-request-id", req.id);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(errors.notFound().toProblem(req.id));
  });

  /**
   * Central error handler.
   *
   * Only `ApiError` is echoed to the client. Everything else returns a fixed
   * body, because an arbitrary thrown error may carry upstream request details
   * including an Authorization header.
   */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      void reply
        .code(err.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(err.toProblem(req.id));
      return;
    }

    // Fastify's own validation and rate-limit errors carry a statusCode. The
    // value is untyped at this boundary, so it is narrowed rather than trusted.
    const maybeStatus: unknown = (err as { statusCode?: unknown }).statusCode;
    const status = typeof maybeStatus === "number" ? maybeStatus : 500;

    if (status < 500) {
      req.log.info({ err, status }, "client error");
      // Safe to echo: 4xx errors below originate from schema validation, not
      // from an upstream client that may have attached credentials.
      const detail = err instanceof Error ? err.message : "Invalid request.";
      void reply
        .code(status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(errors.badRequest(detail).toProblem(req.id));
      return;
    }

    // Full detail to the log, nothing to the client.
    req.log.error({ err }, "unhandled error");
    void reply
      .code(500)
      .type(PROBLEM_CONTENT_TYPE)
      .send(internalProblem(req.id));
  });

  if (opts.onRouteRegistered !== undefined) {
    const notify = opts.onRouteRegistered;
    app.addHook("onRoute", (route) => {
      notify({
        method: route.method,
        url: route.url,
        hidden: (route.schema as { hide?: boolean } | undefined)?.hide === true,
      });
    });
  }

  const enableDocsBrowser = opts.enableDocsBrowser ?? cfg.DOCS_ENABLED;

  // Order matters: spec generation works by `onRoute` hooks, so it must be
  // registered before any route exists.
  await registerOpenApi(app, { cfg, enableBrowser: enableDocsBrowser });

  await app.register(authPlugin, {
    jwksUrl: cfg.workosJwksUrl,
    clientId: cfg.WORKOS_CLIENT_ID,
    workosApiBaseUrl: cfg.workosApiBaseUrl,
    users: opts.services.users,
    tokens: opts.services.tokens,
    quotaRedis: opts.services.quotaRedis,
    sessionCookie: {
      cipher: opts.services.sessionCookies,
      name: cfg.sessionCookieName,
    },
  });

  await app.register(registerHealthRoutes, {
    version: cfg.BUILD_SHA,
    checkDatabase: () => opts.services.db.healthy(),
    checkRedis: async () => {
      // BOTH instances are checked. A node that can reach the cache but not
      // the quota store cannot rate limit, and serving traffic in that state is
      // precisely the silent failure THREAT-MODEL T11 describes.
      const [cache, quota] = await Promise.all([
        redisHealthy(opts.services.cacheRedis),
        redisHealthy(opts.services.quotaRedis),
      ]);
      return cache && quota;
    },
  });

  await app.register(registerV1Routes, {
    prefix: "/v1",
    services: opts.services,
  });

  await registerDocs(app, { cfg, enableBrowser: enableDocsBrowser });

  return app;
}
