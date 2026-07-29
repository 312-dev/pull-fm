/**
 * Maintenance mode, and the reason it is not only an environment variable.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ALREADY TRUE
 *
 * `MAINTENANCE_MODE=true` in the process environment makes every application
 * route answer 503 with `Retry-After`, while `/healthz` and `/readyz` keep
 * answering so an orchestrator can tell intentional downtime from a crash. That
 * part works and is not changed here.
 *
 * WHAT WAS NOT
 *
 * Changing an environment variable means restarting the container. Gate 6 says
 * "maintenance flag -> 100% of requests 503 within 60 seconds; cleared -> 100%
 * 200 within 60 seconds", and a restart-based flip cannot honestly claim the
 * second half: the window between "container stopped" and "container serving
 * again" is downtime of a different kind, during which the service returns
 * connection failures rather than an honest 503 with a retry hint. The distinction
 * matters most in the exact scenario maintenance mode exists for - the SEV-1
 * containment step in docs/RUNBOOK-INCIDENT.md section 4, where the instruction
 * is "contain first, preserve evidence second" and a restart destroys the
 * process state the next step asks you to collect.
 *
 * So there is a second, file-based lever:
 *
 *   touch /etc/pullfm/maintenance     # on within MAINTENANCE_POLL_MS
 *   rm    /etc/pullfm/maintenance     # off within MAINTENANCE_POLL_MS
 *
 * No restart, no dropped connection, no deploy, and it composes with the
 * environment variable rather than replacing it: EITHER being set means
 * maintenance. That direction is deliberate. A file that could turn maintenance
 * OFF while the environment says on would be a way to accidentally serve
 * traffic from a node an operator believed was contained.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STAT IS CACHED
 *
 * The check runs in an `onRequest` hook, so an uncached `existsSync` is one
 * filesystem syscall per request on the hot path. The cache window is the
 * latency of the lever, and it is set at one second: two orders of magnitude
 * inside Gate 6's sixty, and small enough that an operator typing `touch` sees
 * it take effect before they have finished reading the next line of the runbook.
 *
 * `existsSync` rather than a watcher on purpose. `fs.watch` does not fire
 * reliably for a bind-mounted path inside a container, which is exactly how
 * `/etc/pullfm` reaches this process, and a lever that works in development and
 * silently does not work in production is worse than no lever.
 */

import { existsSync } from "node:fs";

export interface MaintenanceOptions {
  /** The environment variable. Wins on its own; never overridden by the file. */
  readonly envFlag: boolean;
  /** Path whose existence means maintenance. Empty disables the file lever. */
  readonly flagFile: string;
  /** Milliseconds a filesystem answer may be reused. */
  readonly pollMs: number;
  /** Test seam. */
  readonly now?: () => number;
  /** Test seam. */
  readonly exists?: (path: string) => boolean;
}

export interface MaintenanceGate {
  /** True while the service should refuse application traffic. */
  active(): boolean;
  /** Which lever is responsible, for the 503 log line and for `/v1/config`. */
  reason(): "off" | "env" | "file";
}

export function createMaintenanceGate(
  opts: MaintenanceOptions,
): MaintenanceGate {
  const now = opts.now ?? Date.now;
  const exists = opts.exists ?? existsSync;

  let cachedAt = -Infinity;
  let cachedFile = false;

  const fileActive = (): boolean => {
    if (opts.flagFile === "") return false;
    const t = now();
    if (t - cachedAt < opts.pollMs) return cachedFile;
    cachedAt = t;
    try {
      cachedFile = exists(opts.flagFile);
    } catch {
      // An unreadable flag path must not be read as "not in maintenance". The
      // previous answer is kept, because flapping to "serving" on a transient
      // filesystem error is the one failure mode that would let a contained
      // node start answering again by itself.
    }
    return cachedFile;
  };

  return {
    active: () => opts.envFlag || fileActive(),
    reason: () => (opts.envFlag ? "env" : fileActive() ? "file" : "off"),
  };
}
