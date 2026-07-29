/**
 * Anonymizes and expires the audit trail.
 *
 *   pnpm --filter @pull-fm/bff purge:audit
 *
 * SCHEDULE: DAILY, off-peak.
 *
 * Daily is the right cadence and the reason is in the windows rather than in
 * the cost. Every window this job enforces is measured in tens of days, so the
 * finest granularity that means anything is a day; running hourly would rewrite
 * the same rows twenty-four times to move a 90-day boundary by an hour. Running
 * it WEEKLY is the one thing that would be wrong: docs/compliance/data-
 * retention-policy.md promises anonymization "on the first job run after the
 * row reaches 30 days old, normally within 24 hours", and a weekly job turns
 * that published sentence into a false statement of fact.
 *
 * Why a scheduled command and not an in-process timer. A BFF node is
 * horizontally scaled, so an interval inside it fires once per node and turns
 * one sweep into an N-way race. The advisory lock would make that safe, but
 * "safe because a lock catches it" is worse than not doing it: the losing nodes
 * still pay for the wiring, and the behaviour changes silently when the node
 * count does.
 *
 * EXIT CODES, which are what a scheduler acts on:
 *
 *   0  the sweep ran, or declined because another run held the lock.
 *   1  the sweep could not run at all and NOTHING WAS CHANGED. This is the one
 *      worth paging about: until it succeeds, `audit_log` is once again an
 *      unbounded store of account identifiers and IP addresses, which is the
 *      exact condition this job exists to end.
 *   2  the sweep ran and something needs a look. Three causes, all reported in
 *      the summary and none of them urgent on their own:
 *        - a statement failed, or would not say how many rows it touched
 *        - a statement hit its batch ceiling, so a backlog is draining
 *        - the standing invariant is still violated, or the freshness signal
 *          says nothing had been anonymized for two days while rows past the
 *          window were already waiting. That combination is the ONLY symptom a
 *          silently dead scheduler produces, which is why it is not folded into
 *          the general failure count.
 */

import { loadConfig } from "../config.js";
import { buildServices, closeServices } from "../wiring.js";
import {
  AuditRetention,
  AUDIT_RETENTION_DEFAULTS,
} from "../services/audit-retention.js";
import { intFromEnv, jobLogger, runJob } from "./job-env.js";

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = jobLogger();
  const d = AUDIT_RETENTION_DEFAULTS;

  const services = buildServices(cfg, log);
  try {
    const job = new AuditRetention(services.db, {
      fullFidelityDays: intFromEnv(
        "AUDIT_FULL_FIDELITY_DAYS",
        d.fullFidelityDays,
      ),
      postDeletionDays: intFromEnv(
        "AUDIT_POST_DELETION_DAYS",
        d.postDeletionDays,
      ),
      hardDeleteDays: intFromEnv("AUDIT_HARD_DELETE_DAYS", d.hardDeleteDays),
      tokenIpDays: intFromEnv("AUDIT_TOKEN_IP_DAYS", d.tokenIpDays),
      usersPerBatch: intFromEnv("AUDIT_USERS_PER_BATCH", d.usersPerBatch),
      rowsPerBatch: intFromEnv("AUDIT_ROWS_PER_BATCH", d.rowsPerBatch),
      maxBatchesPerStatement: intFromEnv(
        "AUDIT_MAX_BATCHES",
        d.maxBatchesPerStatement,
      ),
      freshnessHours: intFromEnv("AUDIT_FRESHNESS_HOURS", d.freshnessHours),
    });

    const outcome = await job.run();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);

    if (!outcome.ran) return 0;

    if (outcome.stale) {
      process.stderr.write(
        "warning: nothing had been anonymized within the freshness window while " +
          "rows past the retention window were already pending. That is the " +
          "signature of a scheduler that stopped running rather than of a job " +
          "that failed, because a dead scheduler produces no errors at all.\n",
      );
    }
    if (outcome.pendingBeyondWindow > 0) {
      process.stderr.write(
        `warning: ${String(outcome.pendingBeyondWindow)} audit row(s) are past the ` +
          "retention window and still carry their identifiers. The standing " +
          "invariant in docs/compliance/data-retention-policy.md section 8.5 " +
          "requires this to be zero.\n",
      );
    }
    if (outcome.capped) {
      process.stderr.write(
        "note: a statement reached its batch ceiling, so a backlog is draining " +
          "over several runs. Repeated across many runs this means the windows " +
          "are being enforced more slowly than they are being breached.\n",
      );
    }

    return outcome.failed > 0 ||
      outcome.capped ||
      outcome.stale ||
      outcome.pendingBeyondWindow > 0
      ? 2
      : 0;
  } finally {
    await closeServices(services);
  }
}

runJob("the audit-log retention purge", main);
