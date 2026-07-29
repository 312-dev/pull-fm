/**
 * Health and readiness endpoints.
 *
 * The distinction matters operationally and is often collapsed by mistake:
 *
 *   /healthz  liveness. Is the process alive? Never touches a dependency.
 *             If this fails the orchestrator restarts the task.
 *   /readyz   readiness. Can this instance serve traffic right now? Checks
 *             dependencies. If it fails the load balancer removes the node but
 *             does NOT restart it.
 *
 * Collapsing them means a brief database blip restarts every application node
 * simultaneously, converting a recoverable dependency hiccup into an outage.
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { annotate } from "../lib/openapi.js";

export interface HealthDeps {
  /** Returns true when Postgres answers a trivial query. */
  checkDatabase?: () => Promise<boolean>;
  /** Returns true when Redis answers PING. */
  checkRedis?: () => Promise<boolean>;
  /** Git commit this build came from. Reported so a deploy is externally verifiable. */
  version?: string;
  /** Renders the Prometheus exposition body. Absent leaves `/metrics` a stub. */
  renderMetrics?: () => string;
  /**
   * Records a readiness result so `/metrics` reports the same dependency
   * verdicts `/readyz` just returned.
   *
   * The alternative was a second, independent set of dependency checks behind
   * `/metrics`, which is how a service ends up with a readiness probe and a
   * dashboard that disagree about whether Redis is up. One probe, two readers.
   */
  observeReadiness?: (checks: Record<string, string>) => void;
  /**
   * Bearer token required to scrape `/metrics`. Empty disables the token path,
   * leaving loopback as the only way in.
   */
  metricsToken?: string;
}

const startedAt = Date.now();

// eslint-disable-next-line @typescript-eslint/require-await
export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps = {},
): Promise<void> {
  /**
   * Liveness. Deliberately dependency-free and unlogged: it is polled every few
   * seconds and would otherwise dominate the logs.
   */
  app.get(
    "/healthz",
    {
      logLevel: "silent",
      schema: {
        operationId: "healthz",
        summary: "Liveness. Never touches a dependency.",
        tags: ["platform"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              uptimeSeconds: { type: "integer" },
              version: { type: "string" },
            },
            required: ["status", "version"],
          },
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    () => ({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // The commit actually serving traffic. A deploy pipeline that only
      // reports its own exit code proves the deployer ran, not that the code
      // shipped.
      version: deps.version ?? "unknown",
    }),
  );

  /**
   * Readiness. Reports per-dependency status so a failure names the culprit
   * rather than requiring a log dive.
   */
  app.get(
    "/readyz",
    {
      logLevel: "silent",
      schema: {
        operationId: "readyz",
        summary: "Readiness. Checks dependencies.",
        tags: ["platform"],
        response: {
          200: readinessSchema,
          503: readinessSchema,
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    async (_req, reply) => {
      const checks: Record<string, "ok" | "fail" | "skipped"> = {};

      // Checks run concurrently: a serial readiness probe that waits on a hung
      // database also delays the Redis answer, and the probe itself times out.
      const [db, redis] = await Promise.all([
        deps.checkDatabase ? safely(deps.checkDatabase) : Promise.resolve(null),
        deps.checkRedis ? safely(deps.checkRedis) : Promise.resolve(null),
      ]);

      checks["database"] = db === null ? "skipped" : db ? "ok" : "fail";
      checks["redis"] = redis === null ? "skipped" : redis ? "ok" : "fail";

      // A2 alerts on "any dependency fail for 2 minutes", which needs the
      // verdict to persist somewhere a scraper can see between probes.
      deps.observeReadiness?.(checks);

      const ready = !Object.values(checks).includes("fail");
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        checks,
      });
    },
  );

  /**
   * Prometheus scrape target.
   *
   * ---------------------------------------------------------------------------
   * WHO IS ALLOWED TO READ THIS
   *
   * Nothing here is a credential. All of it is reconnaissance: pool depth,
   * breaker state, upstream budgets, cache ratios, which providers are
   * configured. The origin's nginx serves `location /` to the edge, so this
   * endpoint is internet-facing by default and stops being harmless the moment
   * it stops being a stub.
   *
   * Two ways in, and the ordering is the security property:
   *
   *   1. THE SOCKET'S PEER ADDRESS IS LOOPBACK. Not `req.ip`. `trustProxy` is
   *      on, so `req.ip` is the leftmost `X-Forwarded-For` value and any client
   *      on earth can set it to 127.0.0.1. `req.socket.remoteAddress` is the
   *      TCP peer and cannot be forged by an HTTP header. This is what lets the
   *      node-local watchdog scrape with no credential while the same endpoint
   *      stays shut from the edge.
   *   2. A bearer token equal to METRICS_TOKEN, compared in constant time.
   *
   * A refusal is 404, not 403. A 403 confirms the endpoint exists and is worth
   * coming back to with a better guess; a 404 says nothing. The response is
   * identical to any other unrouted path, which is the point.
   */
  app.get(
    "/metrics",
    {
      logLevel: "silent",
      schema: {
        operationId: "metrics",
        summary: "Prometheus scrape target (must be unreachable from the edge)",
        tags: ["platform"],
        ...annotate({ authz: "system", dast: "include" }),
      },
    },
    async (req, reply) => {
      if (
        !metricsAllowed(
          req.socket.remoteAddress,
          req.headers.authorization,
          deps.metricsToken,
        )
      ) {
        return reply
          .code(404)
          .type("application/problem+json")
          .send({ type: "about:blank", title: "Not Found", status: 404 });
      }

      const body =
        deps.renderMetrics?.() ??
        "# HELP pullfm_build_info Build information.\n" +
          "# TYPE pullfm_build_info gauge\n" +
          `pullfm_build_info{version="${deps.version ?? "unknown"}"} 1\n`;

      return reply.type("text/plain; version=0.0.4").send(body);
    },
  );
}

/** IPv4 loopback, IPv6 loopback, and the IPv4-mapped-IPv6 form Node reports. */
function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/**
 * Length-safe, timing-safe bearer comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * token's length through the difference between a 500 and a 404, so the lengths
 * are compared first and an unequal length short-circuits to false.
 */
function bearerMatches(header: string | undefined, expected: string): boolean {
  if (expected === "" || header === undefined) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

export function metricsAllowed(
  peerAddress: string | undefined,
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  return isLoopback(peerAddress) || bearerMatches(authorization, token ?? "");
}

/** Shared by the 200 and 503 readiness responses so they cannot drift apart. */
const readinessSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    checks: {
      type: "object",
      additionalProperties: { type: "string", enum: ["ok", "fail", "skipped"] },
    },
  },
  required: ["status", "checks"],
} as const;

/** Runs a check, converting a throw or a hang into a clean false. */
async function safely(check: () => Promise<boolean>): Promise<boolean> {
  try {
    // A readiness probe must answer faster than the orchestrator's own timeout,
    // or a slow dependency looks identical to a dead process.
    return await Promise.race([
      check(),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 2000);
      }),
    ]);
  } catch {
    return false;
  }
}
