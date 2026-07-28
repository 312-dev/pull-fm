/**
 * soak: 10k-shaped load held for 4 hours to expose leaks and slow degradation.
 *
 * WHAT A SOAK CATCHES THAT A 30 MINUTE RUN CANNOT
 *   - unbounded caches and maps that only matter after a few million requests
 *   - connection or file descriptor leaks that need hours to exhaust a limit
 *   - Postgres or PgBouncer pool creep under sustained churn
 *   - a Last.fm cache creeping toward the 100 MB ToS cap (PLAN.md 1a rule 2)
 *   - background jobs whose backlog grows slightly faster than it drains
 *
 * HOW DEGRADATION IS DETECTED
 * k6 has no windowed thresholds, so requests are tagged with the phase of the
 * run they belong to and the LATE phase is held to the same SLO as the EARLY
 * phase. A leak shows up as the late sub-metric failing while the aggregate
 * still passes, which is exactly the failure a whole-run p95 hides: four hours
 * of good numbers dilute twenty minutes of bad ones.
 *
 * The summary also reports the late/early p95 ratio. Anything above about 1.3
 * is worth investigating even when both phases pass.
 *
 * Load is held at 60% of peak by default, because a soak models a sustained
 * plateau rather than a peak hour, and running at peak for four hours would be
 * a different (also useful, but not this) experiment.
 *
 *   k6 run load/scenarios/soak.js                 4 hours
 *   DURATION=20m k6 run load/scenarios/soak.js    short rehearsal
 */
import http from "k6/http";
import exec from "k6/execution";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  durationSeconds,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { runSession } from "../lib/journey.js";
import { sloThresholds } from "../lib/thresholds.js";
import { buildSummary } from "../lib/summary.js";
import { assertUpstreamQuota, logUpstreamReport } from "../lib/mock-control.js";

assertSafeTarget();

// A soak is four hours unless told otherwise. CONFIG is mutated so the summary
// reports the duration that actually ran.
if (!__ENV.DURATION) CONFIG.duration = "4h";
if (!__ENV.RAMP_UP) CONFIG.rampUp = "5m";
if (!__ENV.RAMP_DOWN) CONFIG.rampDown = "2m";

const RATE_FACTOR = Number(__ENV.SOAK_RATE_FACTOR ?? 0.6);
const RATE_PER_10S = Math.max(
  1,
  Math.round(CONFIG.arrivalRate * 10 * RATE_FACTOR),
);

const RAMP_UP_S = durationSeconds(CONFIG.rampUp);
const WARMUP_S = durationSeconds(CONFIG.warmup);
const HOLD_S = durationSeconds(CONFIG.duration);
/** Share of the hold treated as early and late. 15% of four hours is 36
 *  minutes at each end, enough samples for a stable p95. */
const EDGE = Number(__ENV.SOAK_EDGE_SHARE ?? 0.15);

export const options = {
  scenarios: {
    soak: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "10s",
      preAllocatedVUs: CONFIG.preAllocatedVUs,
      maxVUs: CONFIG.maxVUs,
      stages: [
        { target: RATE_PER_10S, duration: CONFIG.rampUp },
        // Unmeasured warm-up, so "early" is a warm baseline and the early/late
        // comparison is not just measuring the cache filling up.
        { target: RATE_PER_10S, duration: CONFIG.warmup },
        { target: RATE_PER_10S, duration: CONFIG.duration },
        { target: 0, duration: CONFIG.rampDown },
      ],
      gracefulStop: "60s",
    },
  },
  thresholds: {
    // abortOnFail: four hours is too long to spend confirming a failure that
    // was obvious at minute five.
    ...sloThresholds("10k", { smoke: CONFIG.smoke, abortOnFail: true }),
    // The whole point of the scenario: the end of the run must be as fast as
    // the beginning.
    "http_req_duration{phase:early}": ["p(95)<300"],
    "http_req_duration{phase:late}": ["p(95)<300", "p(99)<600"],
    "http_req_failed{phase:late}": ["rate<0.001"],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  discardResponseBodies: false,
};

/** Which part of the run this request belongs to. Derived from elapsed time so
 *  no coordination between VUs is needed. */
function currentPhase() {
  const elapsed = exec.instance.currentTestRunDuration / 1000;
  // "warmup" is the name lib/http.js keys off to exclude a request from the
  // SLO and cache metrics, so the ramp is labelled with it too.
  if (elapsed < RAMP_UP_S + WARMUP_S) return "warmup";
  const intoHold = elapsed - RAMP_UP_S - WARMUP_S;
  if (intoHold < HOLD_S * EDGE) return "early";
  if (intoHold > HOLD_S * (1 - EDGE)) return "late";
  return "mid";
}

export function setup() {
  return preflight(http);
}

export default function () {
  runSession({ phase: currentPhase() });
}

export function teardown(data) {
  if (!data || !data.mockAvailable) return;
  const { report } = assertUpstreamQuota();
  logUpstreamReport(report);
}

export function handleSummary(data) {
  const early = pick(data, "http_req_duration{phase:early}", "p(95)");
  const late = pick(data, "http_req_duration{phase:late}", "p(95)");
  const ratio = early && late ? late / early : null;

  return buildSummary("soak", data, {
    profile: "10k",
    notes: [
      `held ${CONFIG.duration} at ${(CONFIG.arrivalRate * RATE_FACTOR).toFixed(2)} sessions/s (${Math.round(RATE_FACTOR * 100)}% of peak)`,
      `early p95 ${fmt(early)}, late p95 ${fmt(late)}, late/early ratio ${ratio ? ratio.toFixed(2) : "n/a"}`,
      ratio && ratio > 1.3
        ? "DEGRADATION: late p95 is more than 1.3x early p95. Investigate before certifying, even if thresholds passed."
        : "no significant early-to-late degradation detected",
    ],
  });
}

function pick(data, metric, key) {
  const m = data.metrics ? data.metrics[metric] : null;
  return m && m.values ? (m.values[key] ?? null) : null;
}

function fmt(v) {
  return v === null ? "n/a" : `${v.toFixed(1)}ms`;
}
