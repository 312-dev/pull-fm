/**
 * The scheduled jobs' environment overrides.
 *
 * These knobs are deliberately absent from `config.ts` (see lib/job-env.ts):
 * they are read by nobody on the request path, and the retention figures among
 * them are policy numbers published in legal/privacy-policy.md and
 * docs/compliance/data-retention-policy.md, so their home is the defaults
 * constant beside the job that enforces them.
 *
 * That choice buys one thing and costs another. It buys an API node that cannot
 * be taken down by a typo in a nightly window. It costs the validation Zod would
 * otherwise have done for free, which is why these tests exist and why they are
 * weighted almost entirely towards the REJECTION cases. A retention override
 * that is silently ignored is the dangerous failure: the operator believes a
 * window was tightened, the document still states the old number, and the job
 * quietly enforces a third thing. Every resolver below therefore throws on a
 * value that is present but not a positive integer, rather than falling back.
 *
 * A pure unit test with no database: these are functions from an environment to
 * an options object, and the wiring that carries the result onto the service
 * bundle is asserted in the integration suites for each job.
 */

import { describe, expect, test } from "vitest";

import {
  AUDIT_RETENTION_DEFAULTS,
  auditRetentionOptionsFromEnv,
} from "./audit-retention.js";
import {
  CACHE_WARMER_DEFAULTS,
  cacheWarmerOptionsFromEnv,
} from "./cache-warmer.js";
import {
  EXPIRY_SWEEPER_DEFAULTS,
  expirySweeperOptionsFromEnv,
} from "./expiry-sweeper.js";

describe("an empty environment yields exactly the shipped defaults", () => {
  // Not a tautology. These are the numbers the compliance and privacy documents
  // state as fact, so a resolver that quietly substituted its own would make a
  // published statement false without failing anything.
  test("the expiry sweeper", () => {
    expect(expirySweeperOptionsFromEnv({})).toEqual(EXPIRY_SWEEPER_DEFAULTS);
  });

  test("the audit retention purge", () => {
    expect(auditRetentionOptionsFromEnv({})).toEqual(AUDIT_RETENTION_DEFAULTS);
  });

  test("the cache warmer", () => {
    expect(cacheWarmerOptionsFromEnv({})).toEqual(CACHE_WARMER_DEFAULTS);
  });
});

describe("an override is applied, and only where it was aimed", () => {
  test("the expiry sweeper", () => {
    const opts = expirySweeperOptionsFromEnv({
      EXPIRY_SWEEP_ROWS_PER_BATCH: "7",
    });
    expect(opts.rowsPerBatch).toBe(7);
    expect(opts.slackSeconds).toBe(EXPIRY_SWEEPER_DEFAULTS.slackSeconds);
    expect(opts.maxBatchesPerTable).toBe(
      EXPIRY_SWEEPER_DEFAULTS.maxBatchesPerTable,
    );
  });

  test("the audit retention purge", () => {
    const opts = auditRetentionOptionsFromEnv({
      AUDIT_FULL_FIDELITY_DAYS: "30",
    });
    expect(opts.fullFidelityDays).toBe(30);
    expect(opts.hardDeleteDays).toBe(AUDIT_RETENTION_DEFAULTS.hardDeleteDays);
  });

  test("the cache warmer", () => {
    const opts = cacheWarmerOptionsFromEnv({ WARM_ITUNES_MAX_CALLS: "5" });
    expect(opts.itunesMaxCalls).toBe(5);
    expect(opts.musicbrainzIntervalMs).toBe(
      CACHE_WARMER_DEFAULTS.musicbrainzIntervalMs,
    );
  });

  test("an empty string is an absent value, not a zero", () => {
    // Shell plumbing produces `FOO=` far more often than anyone intends. Read
    // as zero it would mean "delete nothing" or "call nobody" depending on the
    // job, which is a job that reports a clean run while doing nothing at all.
    expect(
      expirySweeperOptionsFromEnv({ EXPIRY_SWEEP_MAX_BATCHES: "" }),
    ).toEqual(EXPIRY_SWEEPER_DEFAULTS);
  });

  test("the warmer's clock and sleep are not reachable from the environment", () => {
    // The pacing sleep is the control that keeps the service inside
    // MusicBrainz's one-request-per-second limit. An environment that could
    // replace it could turn the job into a terms violation while every interval
    // it appears to respect stayed at its documented value.
    const opts = cacheWarmerOptionsFromEnv({
      WARM_SLEEP_MS: "0",
      WARM_NOW: "0",
    });
    expect(opts).not.toHaveProperty("sleep");
    expect(opts).not.toHaveProperty("now");
  });
});

describe("a malformed override refuses to resolve rather than being ignored", () => {
  // The whole point of hand-rolling this reader. Falling back to the default on
  // a bad value is the one behaviour that must never happen here: the operator
  // sees no error, the published window is unchanged, and the job enforces
  // something nobody chose.
  // "1e3" is deliberately absent: Number() reads it as 1000 and it is accepted.
  // That is a documented consequence of using Number() rather than parseInt,
  // and it is harmless here because the result is still a positive integer.
  const bad = ["0", "-1", "12.5", "twenty", " ", "20d"];

  for (const value of bad) {
    test(`the expiry sweeper rejects ${JSON.stringify(value)}`, () => {
      expect(() =>
        expirySweeperOptionsFromEnv({ EXPIRY_SWEEP_ROWS_PER_BATCH: value }),
      ).toThrow(/EXPIRY_SWEEP_ROWS_PER_BATCH/);
    });
  }

  test("the audit purge names the variable it rejected", () => {
    // The message has to name the variable: an operator tightening a window
    // during an incident needs to know which of eight it fat-fingered.
    expect(() =>
      auditRetentionOptionsFromEnv({ AUDIT_HARD_DELETE_DAYS: "-30" }),
    ).toThrow(/AUDIT_HARD_DELETE_DAYS/);
  });

  test("the cache warmer names the variable it rejected", () => {
    expect(() =>
      cacheWarmerOptionsFromEnv({ WARM_MUSICBRAINZ_INTERVAL_MS: "0" }),
    ).toThrow(/WARM_MUSICBRAINZ_INTERVAL_MS/);
  });
});
