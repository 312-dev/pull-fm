/**
 * Deletes WorkOS records that were auto-created and never verified.
 *
 *   pnpm --filter @pull-fm/bff reap:unverified
 *
 * Run on a schedule, hourly or daily. The window is a duration, not a cadence,
 * so running more often costs nothing and reaps nothing extra: a record becomes
 * eligible when it is older than AUTH_UNVERIFIED_REAP_AFTER_S, whenever the job
 * next happens to look. Running it less often than daily defeats the point,
 * because the window stops being an upper bound on how long an unconsented
 * record exists and becomes a lower one.
 *
 * Why a script rather than an in-process timer. A BFF node is horizontally
 * scaled, so an interval inside it runs once per node and turns a directory
 * sweep into an N-way race. The advisory lock in the reaper would make that
 * safe, but "safe because a lock catches it" is worse than not doing it: the
 * losing nodes still pay for the wiring, and the behaviour changes silently
 * when the node count does. A single scheduled invocation is what this is.
 *
 * Exit codes are for the scheduler, and they distinguish the three cases an
 * operator would want alerted differently:
 *
 *   0  the sweep ran, or declined because another run held the lock
 *   1  the sweep could not run at all, e.g. WorkOS refused the listing. Nothing
 *      was deleted; this is the case worth paging about, because the directory
 *      is unbounded until it succeeds.
 *   2  the sweep ran but at least one deletion failed, or the blast-radius cap
 *      was hit. Both are self-healing on the next run and neither is urgent,
 *      but a cap being hit repeatedly means something is generating records
 *      faster than they are being cleared, which is worth a look.
 */

import { loadConfig } from "../config.js";
import { buildServices, closeServices } from "../wiring.js";

async function main(): Promise<number> {
  const cfg = loadConfig();

  // stderr, never stdout: stdout is reserved so the summary below can be piped
  // into a monitor without log lines corrupting it.
  const log = {
    error: (obj: unknown, msg?: string) => {
      process.stderr.write(`${msg ?? "error"} ${JSON.stringify(obj)}\n`);
    },
    warn: (obj: unknown, msg?: string) => {
      process.stderr.write(`${msg ?? "warn"} ${JSON.stringify(obj)}\n`);
    },
  };

  const services = buildServices(cfg, log);
  try {
    const outcome = await services.directoryReaper.run();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);

    if (!outcome.ran) return 0;
    if (outcome.skippedUnknown > 0) {
      // Not a failure, but it must not be silent. A nonzero value here means
      // WorkOS stopped returning `email_verified` or `created_at`, and the job
      // would otherwise report a clean run while doing nothing at all.
      process.stderr.write(
        `warning: ${String(outcome.skippedUnknown)} record(s) skipped because their ` +
          "verification state or creation time could not be read. The reaper fails " +
          "closed, so nothing was deleted for them. Check the WorkOS response shape.\n",
      );
    }
    return outcome.failed > 0 || outcome.capped > 0 ? 2 : 0;
  } finally {
    await closeServices(services);
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `the unverified-directory sweep could not run, and nothing was deleted:\n${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  });
