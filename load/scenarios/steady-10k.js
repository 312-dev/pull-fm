/**
 * steady-10k: sustained representative traffic for the 10,000 user target.
 *
 * This is the scenario the pre-launch capacity claim rests on. It is the
 * baseline every other scenario is compared against.
 *
 * TRAFFIC MODEL (derivation in README.md, encoded in lib/journey.js)
 *   10,000 registered, 2,000 DAU, ~1.5 sessions/day  ->  ~3,000 sessions/day
 *   ~22 requests per session (1 config, 1 feed, ~15 previews, the rest browse
 *   and wishlist), so roughly 66,000 requests/day, which is under 1 req/s
 *   averaged over 24 hours.
 *
 *   That average is not the thing to engineer for. The default arrival rate of
 *   2.3 sessions/s holds roughly 250 concurrent sessions, about 10x the peak
 *   the naive model implies. The headroom is deliberate and is justified in the
 *   README under "Why 250 concurrent and not 25".
 *
 * OPEN MODEL, on purpose: ramping-arrival-rate keeps starting sessions at the
 * configured rate even when the system slows down. A closed model (ramping-vus)
 * would quietly reduce load exactly when the system is struggling, which is how
 * a load test reports a healthy p95 for a service that is falling over.
 *
 *   k6 run load/scenarios/steady-10k.js
 *   DURATION=1m RAMP_UP=10s RAMP_DOWN=10s SMOKE=1 k6 run load/scenarios/steady-10k.js
 */
import http from "k6/http";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  durationSeconds,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { warmupPhaser } from "../lib/phase.js";
import { runSession } from "../lib/journey.js";
import { sloThresholds } from "../lib/thresholds.js";
import { buildSummary } from "../lib/summary.js";
import { assertUpstreamQuota, logUpstreamReport } from "../lib/mock-control.js";

assertSafeTarget();

// k6 requires an integer arrival target, and the model produces a fractional
// sessions/second. Expressing the rate per 10 seconds keeps one decimal place
// of resolution without rounding 2.3 up to 3 (a silent 30% overload).
const RATE_PER_10S = Math.max(1, Math.round(CONFIG.arrivalRate * 10));

/** Phase boundary: everything before this is warm-up and is excluded from
 *  every threshold. Wall clock for the default run is
 *  2m ramp + 5m warm-up + 30m measured + 1m ramp down = 38m. */
const phaseOf = warmupPhaser(
  durationSeconds(CONFIG.rampUp),
  durationSeconds(CONFIG.warmup),
);

export const options = {
  scenarios: {
    sessions: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "10s",
      preAllocatedVUs: CONFIG.preAllocatedVUs,
      maxVUs: CONFIG.maxVUs,
      stages: [
        { target: RATE_PER_10S, duration: CONFIG.rampUp },
        // Warm-up at full rate. Same load, not counted.
        { target: RATE_PER_10S, duration: CONFIG.warmup },
        { target: RATE_PER_10S, duration: CONFIG.duration },
        { target: 0, duration: CONFIG.rampDown },
      ],
      gracefulStop: "30s",
    },
  },
  thresholds: sloThresholds("10k", { smoke: CONFIG.smoke }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  // Bodies are parsed (feed items, wishlist ids), so they cannot be discarded.
  discardResponseBodies: false,
  // Mirrors a mobile client: connections are reused within a session.
  noConnectionReuse: false,
};

export function setup() {
  return preflight(http);
}

export default function () {
  runSession({ phase: phaseOf() });
}

export function teardown(data) {
  if (!data || !data.mockAvailable) {
    console.warn(
      "mock control plane unavailable: upstream quota was not verified",
    );
    return;
  }
  // The mock is the only witness to our egress, so the quota assertion happens
  // here rather than in handleSummary (which cannot make HTTP calls).
  const { report } = assertUpstreamQuota();
  logUpstreamReport(report);
}

export function handleSummary(data) {
  return buildSummary("steady-10k", data, {
    profile: "10k",
    notes: [
      `arrival ${CONFIG.arrivalRate} sessions/s for ${CONFIG.duration}, after ${CONFIG.warmup} of unmeasured warm-up (ramp ${CONFIG.rampUp} up, ${CONFIG.rampDown} down)`,
      `popularity head ${CONFIG.hotSetSize} recordings taking ${Math.round(CONFIG.hotSetShare * 100)}% of requests, tail drawn from ${CONFIG.tailSetSize}`,
      "SLO: p95<300ms, p99<600ms, errors<0.1%, warm cache hit>90%",
    ],
  });
}
