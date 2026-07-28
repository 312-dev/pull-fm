/**
 * burst-50k: DEFERRED TO POST-LAUNCH. NOT PART OF ANY PRE-LAUNCH GATE.
 *
 * ===========================================================================
 *  PLAN.md section 8 and section 9 both defer this scenario, and the reason is
 *  not that it is hard to run:
 *
 *    "burst-50k is deferred to post-launch, when the traffic shape is known
 *     rather than invented. It is replaced pre-launch by a written capacity
 *     model: measured cost per request type (CPU-ms, DB queries, upstream
 *     calls), extrapolated with the arithmetic shown, plus a documented scale
 *     trigger."
 *
 *    "Invented traffic model produces false confidence."
 *
 *  A 50k burst shaped by guesswork tells you how the system behaves under a
 *  load pattern that will never occur. Worse, it produces a number that gets
 *  quoted later as if it were evidence. The pre-launch artifact is the capacity
 *  model in the README, derived from steady-10k measurements.
 *
 *  There is also a hard external ceiling that no amount of tuning moves: at 50k
 *  users the binding constraint is upstream API quota, not our infrastructure
 *  (PLAN.md section 3). Relieving it requires a local MusicBrainz mirror. A
 *  green burst-50k against mocks would say nothing about that constraint, which
 *  is precisely why it must not be treated as a scale certification.
 * ===========================================================================
 *
 * The scenario exists and is runnable so that when the deferral ends there is
 * nothing to build, only a number to update. It refuses to run unless the
 * deferral is explicitly acknowledged:
 *
 *   I_UNDERSTAND_BURST_50K_IS_DEFERRED=1 k6 run load/scenarios/burst-50k.js
 *
 * Thresholds use the 50k burst column of the SLO table: p95 < 800ms,
 * p99 < 1500ms, errors < 1%, cache hit > 90%.
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

if (!CONFIG.acknowledgedBurst) {
  // A comment can be skimmed past. An exception cannot.
  throw new Error(
    [
      "",
      "burst-50k is DEFERRED to post-launch (PLAN.md sections 8 and 9).",
      "",
      "  It is not part of the pre-launch gate. The pre-launch artifact is the",
      "  written capacity model in load/README.md, extrapolated from steady-10k",
      "  measurements, plus the documented scale trigger.",
      "",
      "  At 50k the binding constraint is upstream API quota, not our compute.",
      "  A green result here would not address that and must not be quoted as",
      "  if it did.",
      "",
      "  To run it anyway (post-launch, or to exercise the harness):",
      "    I_UNDERSTAND_BURST_50K_IS_DEFERRED=1 k6 run load/scenarios/burst-50k.js",
      "",
    ].join("\n"),
  );
}

/** 50k users at the same per-user behavior is 5x the 10k arrival rate. The
 *  burst multiplier on top models a spike (a press mention, a playlist going
 *  around) rather than a new steady state. */
const SCALE = Number(__ENV.BURST_SCALE ?? 5);
const BURST_MULTIPLIER = Number(__ENV.BURST_MULTIPLIER ?? 2);
const STEADY_RATE_10S = Math.max(
  1,
  Math.round(CONFIG.arrivalRate * 10 * SCALE),
);
const PEAK_RATE_10S = Math.round(STEADY_RATE_10S * BURST_MULTIPLIER);

const RAMP_UP = __ENV.RAMP_UP ?? "3m";
const STEADY_HOLD = __ENV.DURATION ?? "5m";

/** The pre-burst steady segment doubles as the warm-up: the question a burst
 *  test asks is how the system handles the step, not how fast it fills a cold
 *  cache. Measurement therefore starts when the step does. */
const phaseOf = warmupPhaser(
  durationSeconds(RAMP_UP),
  durationSeconds(STEADY_HOLD),
);

export const options = {
  scenarios: {
    burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "10s",
      // A burst needs headroom to allocate VUs fast, or the executor's own
      // allocation becomes the bottleneck and gets misread as server latency.
      preAllocatedVUs: Math.max(CONFIG.preAllocatedVUs, 500),
      maxVUs: Math.max(CONFIG.maxVUs, 2000),
      stages: [
        // Climb to the 50k steady state, then hold it. Both segments are
        // warm-up: unmeasured, but they are what makes the cache warm.
        { target: STEADY_RATE_10S, duration: RAMP_UP },
        { target: STEADY_RATE_10S, duration: STEADY_HOLD },
        // The burst itself: a sharp step, not a ramp. Gradual arrival lets
        // autoscaling and cache warming hide the behavior being tested.
        { target: PEAK_RATE_10S, duration: "30s" },
        { target: PEAK_RATE_10S, duration: __ENV.BURST_HOLD ?? "3m" },
        // Recovery back to steady state matters as much as the peak.
        { target: STEADY_RATE_10S, duration: "1m" },
        { target: 0, duration: CONFIG.rampDown },
      ],
      gracefulStop: "60s",
    },
  },
  thresholds: sloThresholds("50k", { smoke: CONFIG.smoke }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  discardResponseBodies: false,
};

export function setup() {
  console.warn(
    "burst-50k is DEFERRED. This run is not gate evidence for the pre-launch phase.",
  );
  return preflight(http);
}

export default function () {
  runSession({ phase: phaseOf() });
}

export function teardown(data) {
  if (!data || !data.mockAvailable) return;
  const { report } = assertUpstreamQuota();
  logUpstreamReport(report);
}

export function handleSummary(data) {
  return buildSummary("burst-50k", data, {
    profile: "50k",
    notes: [
      "DEFERRED SCENARIO (PLAN.md sections 8 and 9). Not a pre-launch gate.",
      `steady ${(CONFIG.arrivalRate * SCALE).toFixed(1)} sessions/s, burst peak ${(CONFIG.arrivalRate * SCALE * BURST_MULTIPLIER).toFixed(1)} sessions/s`,
      "SLO: p95<800ms, p99<1500ms, errors<1%, cache hit>90%",
      "At 50k the real ceiling is upstream quota (PLAN.md section 3), which this scenario cannot measure.",
    ],
  });
}
