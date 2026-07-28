/**
 * Fastify application assembly.
 *
 * Kept separate from `index.ts` so tests can build an app instance without
 * binding a port or starting the shutdown machinery.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import type { Config } from "./config.js";
import { loggerOptions } from "./lib/logger.js";
import {
  ApiError,
  errors,
  internalProblem,
  PROBLEM_CONTENT_TYPE,
} from "./lib/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerV1Routes } from "./routes/v1.js";

export async function buildServer(cfg: Config): Promise<FastifyInstance> {
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

  await app.register(helmet, {
    // This is a JSON API with no browsable HTML, so the CSP only needs to
    // ensure nothing is ever framed or executed if a response is mis-rendered.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
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
    ],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
    ],
  });

  /**
   * Global rate limit.
   *
   * This is a floor, not the real control: the endpoints that spend metered
   * upstream quota (search, preview resolution) get their own tighter per-user
   * limits, because one scraper can otherwise burn the shared Last.fm and
   * MusicBrainz quota for every user at once.
   */
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Prefer the authenticated subject so a shared NAT does not throttle a
    // whole office, falling back to IP for anonymous traffic.
    keyGenerator: (req) => req.headers["x-subject-id"]?.toString() ?? req.ip,
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

  await app.register(registerHealthRoutes, { version: cfg.BUILD_SHA });
  await app.register(registerV1Routes, { prefix: "/v1" });

  return app;
}
