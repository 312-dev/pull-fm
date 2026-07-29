/**
 * Deletes expired idempotency records and connect states.
 *
 *   pnpm --filter @pull-fm/bff sweep:expired
 *
 * SCHEDULE: HOURLY.
 *
 * The cadence follows from what is being promised. `idempotency_keys.expires_at`
 * is 24 hours and the privacy policy says so, so a daily job would leave a row
 * holding a verbatim copy of an API response - email address, display name,
 * wishlist note - alive for up to 48 hours against a 24-hour promise. Hourly
 * makes the worst case 25 hours, which is the schema's number plus the hour of
 * clock-skew slack the sweeper deliberately allows. `connect_states` expire in
 * minutes, so hourly is already generous for them.
 *
 * Running it more often than hourly buys nothing: expiry is a duration, not a
 * cadence, and a row becomes eligible when it is old enough regardless of when
 * the job next looks.
 *
 * Why a scheduled command and not an in-process timer. A BFF node is
 * horizontally scaled, so an interval inside it fires once per node and turns
 * one sweep into an N-way race. The advisory lock would catch it, but a job
 * whose correctness depends on a lock catching a race we introduced on purpose
 * is a worse design than one invocation.
 *
 * EXIT CODES:
 *
 *   0  the sweep ran, or declined because another run held the lock.
 *   1  the sweep could not run at all and NOTHING WAS DELETED. Worth paging:
 *      until it succeeds, `idempotency_keys` is an unbounded store of copied
 *      API responses whose stated retention is 24 hours.
 *   2  the sweep ran, and either a table failed or a table hit its batch
 *      ceiling with rows still waiting. Both are self-healing on the next run;
 *      a ceiling hit on every run means rows are expiring faster than they are
 *      being cleared, which is worth a look rather than a page.
 */

import { loadConfig } from "../config.js";
import { buildServices, closeServices } from "../wiring.js";
import {
  ExpirySweeper,
  EXPIRY_SWEEPER_DEFAULTS,
} from "../services/expiry-sweeper.js";
import { intFromEnv, jobLogger, runJob } from "./job-env.js";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = jobLogger();
  const d = EXPIRY_SWEEPER_DEFAULTS;

  const services = buildServices(cfg, log);
  try {
    const job = new ExpirySweeper(services.db, {
      slackSeconds: intFromEnv("EXPIRY_SWEEP_SLACK_S", d.slackSeconds),
      rowsPerBatch: intFromEnv("EXPIRY_SWEEP_ROWS_PER_BATCH", d.rowsPerBatch),
      maxBatchesPerTable: intFromEnv(
        "EXPIRY_SWEEP_MAX_BATCHES",
        d.maxBatchesPerTable,
      ),
    });

    const outcome = await job.run();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);

    if (!outcome.ran) return 0;

    if (outcome.capped) {
      process.stderr.write(
        "note: a table reached its batch ceiling, so a backlog is draining over " +
          "several runs. Every run hitting the ceiling means expired rows are " +
          "accumulating faster than they are being removed.\n",
      );
    }

    return outcome.failed > 0 || outcome.capped ? 2 : 0;
  } finally {
    await closeServices(services);
  }
}

runJob("the expired-row sweep", main);
