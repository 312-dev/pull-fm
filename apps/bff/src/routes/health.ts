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

import type { FastifyInstance } from "fastify";

export interface HealthDeps {
  /** Returns true when Postgres answers a trivial query. */
  checkDatabase?: () => Promise<boolean>;
  /** Returns true when Redis answers PING. */
  checkRedis?: () => Promise<boolean>;
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
  app.get("/healthz", { logLevel: "silent" }, () => ({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  /**
   * Readiness. Reports per-dependency status so a failure names the culprit
   * rather than requiring a log dive.
   */
  app.get("/readyz", { logLevel: "silent" }, async (_req, reply) => {
    const checks: Record<string, "ok" | "fail" | "skipped"> = {};

    // Checks run concurrently: a serial readiness probe that waits on a hung
    // database also delays the Redis answer, and the probe itself times out.
    const [db, redis] = await Promise.all([
      deps.checkDatabase ? safely(deps.checkDatabase) : Promise.resolve(null),
      deps.checkRedis ? safely(deps.checkRedis) : Promise.resolve(null),
    ]);

    checks["database"] = db === null ? "skipped" : db ? "ok" : "fail";
    checks["redis"] = redis === null ? "skipped" : redis ? "ok" : "fail";

    const ready = !Object.values(checks).includes("fail");
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
    });
  });

  /**
   * Prometheus scrape target.
   *
   * Stubbed until the metrics registry lands in the observability phase. It
   * exists now so the scrape config, dashboards, and alert rules can be written
   * and tested against a real endpoint rather than a promise.
   */
  app.get("/metrics", { logLevel: "silent" }, async (_req, reply) => {
    return reply
      .type("text/plain; version=0.0.4")
      .send(
        "# HELP pullfm_build_info Build information.\n" +
          "# TYPE pullfm_build_info gauge\n" +
          'pullfm_build_info{version="0.0.0"} 1\n',
      );
  });
}

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
