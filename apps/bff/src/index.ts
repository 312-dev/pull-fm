/**
 * Process entrypoint.
 *
 * Responsible for exactly three things: load configuration, start the server,
 * and shut down cleanly. Application wiring lives in server.ts so tests can
 * build an app without any of this.
 */

import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  // Before the logger exists, so a configuration error prints plainly and the
  // process exits non-zero rather than starting up half-configured.
  const cfg = loadConfig();

  const app = await buildServer(cfg);

  /**
   * Graceful shutdown.
   *
   * Nomad sends SIGTERM and waits before SIGKILL. Draining in-flight requests
   * here is what makes a rolling deploy produce zero non-2xx responses, which
   * Gate 6 asserts directly.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutdown signal received, draining");

    const timer = setTimeout(() => {
      app.log.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
    // Do not keep the event loop alive purely for the bail-out timer.
    timer.unref();

    app
      .close()
      .then(() => {
        app.log.info("shutdown complete");
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  // An unhandled rejection leaves the process in an unknown state. Crashing and
  // letting the orchestrator restart is safer than continuing to serve traffic
  // from a corrupted one.
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ err: reason }, "unhandled promise rejection");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaught exception");
    process.exit(1);
  });

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
}

main().catch((err: unknown) => {
  console.error("fatal: failed to start\n", err);
  process.exit(1);
});
