/**
 * chaos: the Gate 7 failure-injection matrix.
 *
 * GATE 7, verbatim from PLAN.md:
 *   "Under a failure-injection matrix (each upstream forced to 429/500/timeout
 *    in turn) /feed returns 200 with degraded sections, p95 <800ms, errors <1%,
 *    no pool exhaustion, recovery <60s."
 *
 * STRUCTURE
 *   Two k6 scenarios run concurrently:
 *     traffic    normal sessions, at a reduced rate, throughout
 *     conductor  a single VU that walks the matrix: force a fault on one
 *                provider, hold it, clear it, then measure recovery
 *
 *   The schedule is a pure function of the configuration (lib/chaos-plan.js),
 *   so traffic VUs can tag their requests with the active phase without any
 *   coordination channel. Every request is therefore attributable to the fault
 *   that was in effect when it was made.
 *
 * DEFAULT MATRIX: 6 providers x 3 faults x (45s hold + 30s recover) + 60s
 * warmup, about 23 minutes. Trim it with CHAOS_PROVIDERS / CHAOS_FAULTS.
 *
 * WHAT "RECOVERY" MEANS HERE
 *   Time from clearing the fault until /v1/feed is fast and undegraded twice in
 *   a row. Each probe uses a fresh synthetic subject and a cache-busting
 *   cursor, because probing a cached feed would report instant recovery for a
 *   system that has not recovered at all.
 *
 *   node load/mock-upstreams/server.js
 *   k6 run load/scenarios/chaos.js
 *   CHAOS_PROVIDERS=musicbrainz CHAOS_FAULTS=timeout k6 run load/scenarios/chaos.js
 */
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { runSession } from "../lib/journey.js";
import { sloThresholds } from "../lib/thresholds.js";
import { buildSummary } from "../lib/summary.js";
import { buildPlan, phaseAt, planDuration } from "../lib/chaos-plan.js";
import {
  setFault,
  clearFaults,
  resetMock,
  assertUpstreamQuota,
  logUpstreamReport,
} from "../lib/mock-control.js";
import { chaosRecoverySeconds } from "../lib/metrics.js";

assertSafeTarget();

const PLAN = buildPlan();
const TOTAL = planDuration(PLAN);

// Chaos runs at half the steady rate: the question is whether degradation is
// graceful, not where the throughput ceiling is. Mixing the two experiments
// makes a failure ambiguous.
const RATE_PER_10S = Math.max(1, Math.round(CONFIG.arrivalRate * 10 * 0.5));

export const options = {
  scenarios: {
    traffic: {
      executor: "constant-arrival-rate",
      rate: RATE_PER_10S,
      timeUnit: "10s",
      duration: TOTAL,
      preAllocatedVUs: Math.min(CONFIG.preAllocatedVUs, 200),
      maxVUs: CONFIG.maxVUs,
      exec: "traffic",
      gracefulStop: "30s",
    },
    conductor: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: TOTAL,
      exec: "conductor",
      gracefulStop: "30s",
    },
  },
  thresholds: sloThresholds("chaos", { smoke: CONFIG.smoke }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  discardResponseBodies: false,
};

export function setup() {
  const state = preflight(http, { requireMock: true });
  // Start from a known state: a fault left set by an aborted previous run would
  // silently invalidate everything measured here.
  resetMock("all");
  console.log(
    `chaos matrix: ${PLAN.phases.length} phases, ${PLAN.holdSeconds}s hold, ` +
      `${PLAN.recoverSeconds}s recovery window, total ${TOTAL}`,
  );
  return state;
}

export function traffic() {
  const elapsed = exec.instance.currentTestRunDuration / 1000;
  // Tagging with the active phase is what makes a failure diagnosable: "p95 was
  // fine except while MusicBrainz was timing out" is a different report from
  // "p95 was fine".
  runSession({ phase: phaseAt(PLAN, elapsed) });
}

export function conductor() {
  for (const phase of PLAN.phases) {
    sleepUntil(phase.startS);
    console.log(`[chaos] INJECT ${phase.provider} -> ${phase.fault}`);
    setFault(phase.provider, phase.fault, phase.label);

    sleepUntil(phase.faultEndS);
    console.log(`[chaos] CLEAR  ${phase.provider}`);
    clearFaults(`${phase.label}:recovering`);

    measureRecovery(phase);
    sleepUntil(phase.endS);
  }
  clearFaults("done");
  console.log("[chaos] matrix complete, all faults cleared");
}

/**
 * Poll until the feed is healthy twice in a row, or the recovery window ends.
 * Records the elapsed seconds as chaos_recovery_seconds (gate: p95 < 60s).
 */
function measureRecovery(phase) {
  const startedAt = Date.now();
  const deadline = startedAt + PLAN.recoverSeconds * 1000;
  let consecutiveGood = 0;
  let recoveredAfter = null;

  while (Date.now() < deadline) {
    const probeId = `recovery_probe_${phase.label}_${Date.now()}`;
    const res = http.get(`${CONFIG.baseUrl}/v1/feed?cursor=${probeId}`, {
      // A fresh subject and cursor every probe: a cached feed would report
      // recovery that has not happened.
      headers: {
        accept: "application/json",
        "x-load-test-user": probeId,
        "user-agent": "PullFM-LoadTest/1.0 (k6 recovery probe)",
        ...(CONFIG.authToken
          ? { authorization: `Bearer ${CONFIG.authToken}` }
          : {}),
      },
      // Excluded from the SLO metrics: these are diagnostics, not user traffic.
      tags: { endpoint: "recovery_probe", slo: "no", phase: phase.label },
      timeout: "5s",
    });

    const healthy =
      res.status === 200 && res.timings.duration < 800 && !isDegraded(res);
    consecutiveGood = healthy ? consecutiveGood + 1 : 0;
    if (consecutiveGood >= 2) {
      recoveredAfter = (Date.now() - startedAt) / 1000;
      break;
    }
    sleep(2);
  }

  if (recoveredAfter === null) {
    // Record a value that cannot pass, rather than the window length, which
    // would look like a pass for a system that never came back.
    chaosRecoverySeconds.add(999);
    console.error(
      `[chaos] ${phase.label}: NOT recovered within ${PLAN.recoverSeconds}s observation window`,
    );
  } else {
    chaosRecoverySeconds.add(recoveredAfter);
    console.log(
      `[chaos] ${phase.label}: recovered in ${recoveredAfter.toFixed(1)}s`,
    );
  }

  check(null, {
    "recovered within the observation window": () => recoveredAfter !== null,
  });
}

function isDegraded(res) {
  try {
    const body = res.json();
    if (!body) return true;
    if (Array.isArray(body.degraded) && body.degraded.length > 0) return true;
    const sections = body.sections ?? [];
    return (
      sections.length === 0 || sections.some((s) => s && s.degraded === true)
    );
  } catch {
    return true;
  }
}

function sleepUntil(targetSeconds) {
  const remaining = targetSeconds - exec.instance.currentTestRunDuration / 1000;
  if (remaining > 0) sleep(remaining);
}

export function teardown(data) {
  // Non-negotiable: leaving a fault set would poison every later run against
  // this mock, and the symptom would look like a real regression.
  clearFaults("idle");
  resetMock("config");
  if (!data || !data.mockAvailable) return;
  // Quota is deliberately not asserted here. Forced 429s are the experiment,
  // so refusal counts carry no information about our own behavior.
  const { report } = assertUpstreamQuota({
    tolerance: Number.MAX_SAFE_INTEGER,
  });
  logUpstreamReport(report);
}

export function handleSummary(data) {
  return buildSummary("chaos", data, {
    profile: "chaos",
    notes: [
      `matrix: ${PLAN.phases.map((p) => p.label).join(", ")}`,
      `hold ${PLAN.holdSeconds}s, recovery window ${PLAN.recoverSeconds}s, warmup ${PLAN.warmupSeconds}s`,
      "gate 7: feed 200 with degraded sections, p95<800ms, errors<1%, recovery<60s",
      "a recovery sample of 999 means the feed never came back inside the observation window",
      "upstream quota is NOT asserted in this scenario: the refusals are injected on purpose",
    ],
  });
}
