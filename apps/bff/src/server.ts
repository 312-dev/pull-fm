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
import { quotaRateLimitStore } from "./lib/rate-limit-store.js";
import { UpstreamBudget } from "./lib/upstream-budget.js";
import authPlugin from "./plugins/auth.js";
import upstreamBudgetPlugin from "./plugins/upstream-budget.js";
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
   * A named fail-closed notification, shared by every control that has one.
   *
   * Three now do: the global limiter, the per-token limiter and the per-subject
   * upstream budget, plus the session revocation store. Each refuses traffic
   * when the quota Redis cannot be consulted, and each refusal is a 503 that
   * looks exactly like an upstream provider being down. The counter is what an
   * alert fires on (S3); the log line is what tells the operator WHICH of them
   * broke, at the moment it broke, which a counter alone cannot.
   */
  const failClosed = (store: string): void => {
    opts.services.metrics.counter(
      "pullfm_fail_closed_total",
      "Requests refused because a fail-closed dependency was unreachable (S3).",
      { store },
    );
    app.log.error({ store }, "fail-closed: refusing traffic");
  };

  /**
   * Global rate limit.
   *
   * This is a floor, not the real control. Personal API tokens carry their own
   * per-token budget (plugins/auth.ts) and every subject carries an
   * upstream-call budget (plugins/upstream-budget.ts). All three are counted in
   * the `noeviction` quota Redis so none can be silently disabled by cache
   * pressure.
   *
   * `store` IS LOAD-BEARING AND USED TO BE ABSENT. Without it the plugin uses
   * its in-process `LocalStore`, a 5,000-entry LRU, and the whole limiter is
   * defeated by rotating source addresses: the audit demonstrated 5,600 distinct
   * addresses evicting a throttled counter and restoring a full budget. See
   * lib/rate-limit-store.ts for the transcript and for why this reuses
   * `incrementWindow` rather than the plugin's own Redis store.
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
   *   Per-subject budgets belong where the subject exists: the upstream budget
   *   at `preHandler`, and the per-token limiter in plugins/auth.ts.
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
    /**
     * The plugin THROWS whatever this returns, so it must return an `ApiError`
     * rather than a problem DOCUMENT.
     *
     * It used to return `.toProblem()`, a plain object. `setErrorHandler` sees
     * no `ApiError` and no `statusCode` on a plain object, so an exceeded rate
     * limit answered 500 with the generic internal body instead of 429 with the
     * problem document. The defect was invisible because the limiter's counters
     * were per-process and every suite raised the ceiling out of reach; moving
     * the counters to a shared store is what surfaced it. Returning the error
     * itself also gets the request id into `instance`, which the hand-built
     * document could not carry.
     */
    errorResponseBuilder: () => errors.rateLimited(),
    store: quotaRateLimitStore({
      redis: opts.services.quotaRedis,
      onFailClosed: () => {
        failClosed("global_limiter");
      },
    }),
  });

  /**
   * Maintenance mode.
   *
   * Three endpoints stay up, and each is a different argument:
   *
   *   /healthz  so the orchestrator can tell "intentionally down" from
   *             "crashed" and does not restart a node an operator contained.
   *   /readyz   so the load balancer's view stays truthful.
   *   /metrics  so the service is still OBSERVABLE while it is refusing
   *             traffic. Losing observability at the moment of an incident is
   *             the opposite of what maintenance mode is for, and Gate 6 asks
   *             for evidence of the flip, which has to come from somewhere.
   *
   * `services.maintenance` rather than `cfg.MAINTENANCE_MODE` directly: the
   * gate also honours a flag FILE, so the mode can be entered and left without
   * a restart. See lib/maintenance.ts for why that difference matters to Gate
   * 6 and to the SEV-1 containment step.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!opts.services.maintenance.active()) return;
    if (
      req.url.startsWith("/healthz") ||
      req.url.startsWith("/readyz") ||
      req.url.startsWith("/metrics")
    ) {
      return;
    }

    opts.services.metrics.counter(
      "pullfm_maintenance_refusals_total",
      "Requests refused because maintenance mode was active.",
      { reason: opts.services.maintenance.reason() },
    );

    const problem = errors.maintenance().toProblem(req.id);
    await reply
      .code(503)
      .header("retry-after", "300")
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem);
  });

  /**
   * Request counters and the latency histogram.
   *
   * Keyed on `routeOptions.url`, the TEMPLATE (`/v1/wishlist/:id`), never the
   * concrete path. A metric labelled with a real id is one time series per id,
   * which is how a metrics endpoint becomes the outage it was added to detect.
   * An unrouted request has no template, so it is labelled `unrouted` rather
   * than by whatever the caller sent.
   */
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unrouted";
    opts.services.metrics.counter(
      "pullfm_http_requests_total",
      "HTTP responses by route template, method and status.",
      { route, method: req.method, status: reply.statusCode },
    );
    opts.services.metrics.observe(
      "pullfm_http_request_duration_seconds",
      "HTTP response time in seconds, by route template. A6 alerts on p95 over 0.8.",
      { route },
      reply.elapsedTime / 1000,
    );
  });

  // Every response carries its request id so a user-reported failure is
  // traceable without asking them to reproduce it.
  app.addHook("onSend", async (req, reply) => {
    void reply.header("x-request-id", req.id);

    /**
     * Cacheability, defaulting to "not cacheable".
     *
     * AUDIT 2026-07-29, first ZAP baseline ever run against staging. Rule 10015
     * fired on GET /v1/me, GET /v1/connections, GET /v1/config, /healthz and
     * /readyz: every one answered 200 with per-subject data and NO
     * `Cache-Control` at all. security/zap/rules/alert-filters.yaml already
     * called this out as a true positive rather than noise -- "every
     * authenticated response is per-user data and must be Cache-Control:
     * no-store. A shared cache holding a /v1/feed or /v1/me body is a
     * cross-subject disclosure" -- and security/zap/rules/baseline-rules.tsv
     * grades it FAIL. The intent was written down; only product.ts implemented
     * it, via its local `personalised()` helper, so the catalogue routes were
     * covered and the account routes were not.
     *
     * Fixed here rather than by copying `personalised()` into four more route
     * files, because a per-handler opt-in is a control that a new route silently
     * misses. THREAT-MODEL T12 is a shared cache serving one subject's body to
     * another, and the safe direction of the default is the whole point: a route
     * is uncacheable unless it says otherwise.
     *
     * Handlers that HAVE said otherwise keep their value. product.ts sets
     * `public, max-age=300` on catalogue reads, which is correct and deliberate
     * (that data is not per-subject), so this only fills the gap rather than
     * overriding a decision.
     *
     * `private` as well as `no-store` is belt and braces: `no-store` alone is
     * the modern directive, but `private` is what an older intermediary
     * understands, and this response may pass through Cloudflare and an
     * arbitrary corporate proxy on the way to a phone.
     */
    if (reply.getHeader("cache-control") === undefined) {
      void reply.header("cache-control", "private, no-store");
    }
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
    onFailClosed: (store) => {
      failClosed(store === "rate limiter" ? "quota_limiter" : "session_store");
    },
    sessionCookie: {
      cipher: opts.services.sessionCookies,
      name: cfg.sessionCookieName,
    },
  });

  /**
   * The per-subject upstream-call budget.
   *
   * Registered AFTER the auth plugin so `request.subject` is decorated before
   * this plugin reads it, and it enforces at `preHandler`, which is after
   * `requireAuth` runs at `preValidation`. That ordering is the point: this is
   * the first limiter in the chain that gets to see a VERIFIED identity, which
   * is what makes it survive an attacker rotating source addresses.
   *
   * It is also the limiter that budgets the resource that is actually scarce.
   * The two above it count requests; the ListenBrainz labs allowance (~30 per
   * 10s, app-wide, no per-user token) and the Last.fm app-wide key are spent by
   * cache MISSES, and `/v1/artists/{mbid}/similar` turns any well-formed UUID
   * into exactly one such call with no existence check first. Not MusicBrainz:
   * its 1 req/s is unreachable from a route, because every request-path read of
   * it is `peek`. See lib/upstream-budget.ts.
   */
  await app.register(upstreamBudgetPlugin, {
    budget: new UpstreamBudget(opts.services.quotaRedis, {
      authenticatedMax: cfg.UPSTREAM_BUDGET_AUTHENTICATED_MAX,
      anonymousMax: cfg.UPSTREAM_BUDGET_ANONYMOUS_MAX,
      windowSeconds: cfg.UPSTREAM_BUDGET_WINDOW_S,
      onFailClosed: () => {
        failClosed("upstream_budget");
      },
      onSettleFailure: (err) => {
        // Not a refusal: the response has already been sent. Counted separately
        // so it cannot be mistaken for a request that was denied, and logged so
        // a store that accepts reservations and refuses settles - which would
        // over-charge every subject until they were locked out - is visible
        // before the support tickets arrive.
        opts.services.metrics.counter(
          "pullfm_upstream_budget_settle_failures_total",
          "Upstream-budget reservations that could not be settled. The reserved unit stands, so the subject is over-charged rather than under-charged.",
        );
        app.log.warn({ err }, "upstream budget settle failed");
      },
    }),
  });

  await app.register(registerHealthRoutes, {
    version: cfg.BUILD_SHA,
    metricsToken: cfg.METRICS_TOKEN,
    renderMetrics: () => opts.services.metrics.render(),
    observeReadiness: (checks: Record<string, string>) => {
      for (const [dependency, verdict] of Object.entries(checks)) {
        opts.services.metrics.gauge(
          "pullfm_dependency_up",
          "1 ok, 0 fail, -1 not checked. Written by the last /readyz probe (A2).",
          { dependency },
          verdict === "ok" ? 1 : verdict === "fail" ? 0 : -1,
        );
      }
    },
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
