/**
 * QUOTA REDIS FAIL-CLOSED GATE.
 *
 * THE CLAIM UNDER TEST
 * --------------------
 * `docker-compose.dev.yml` runs a SECOND Redis for quota counters, at
 * `noeviction`, and the comment on it is unusually direct: on a shared
 * `allkeys-lru` instance a cache-fill event evicts quota keys and every rate
 * limit then fails OPEN, with no error, no alert and no signal at all, while
 * the abuse protections are simply gone. That is THREAT-MODEL T11 and it is
 * named the highest-likelihood defect in the model.
 *
 * The application side matches. Three separate paths convert an unreachable
 * quota Redis into `errors.upstreamUnavailable(...)`, which is a 503:
 *
 *   enforceTokenRateLimit   apps/bff/src/plugins/auth.ts   "a rate limiter that
 *                                                           fails open is not a
 *                                                           rate limiter"
 *   isRevoked               apps/bff/src/plugins/auth.ts   session revocation
 *   magic-auth budgets      apps/bff/src/services/magic-auth.ts
 *
 * WHY THIS NEEDS A LOAD SCENARIO AND NOT A UNIT TEST
 * --------------------------------------------------
 * A unit test injects a throwing Redis stub and asserts the catch. That proves
 * the branch exists. It does not prove the branch is REACHED under load, and
 * there are two specific ways it might not be:
 *
 *   1. `ioredis` is configured with `maxRetriesPerRequest: 2`,
 *      `connectTimeout: 2000`, `commandTimeout: 1000`, and the offline queue
 *      deliberately LEFT ENABLED (apps/bff/src/lib/redis.ts). An enabled
 *      offline queue means commands issued while the connection is down are
 *      buffered rather than rejected. Under sustained load that queue is a
 *      growing backlog, and the interesting question is whether requests fail
 *      closed promptly or pile up until something else breaks first.
 *   2. A 503 is only the correct answer if it actually arrives. A request that
 *      hangs for the full command timeout on every call has technically failed
 *      closed and has practically taken the API down; the latency of failing is
 *      part of the behaviour and is measured here.
 *
 * WHAT THIS RUNS
 * --------------
 * Sustained authenticated load in three phases:
 *
 *   healthy    quota Redis up.     Gate: 2xx, no 503s.
 *   severed    quota Redis stopped. Gate: ZERO successful authenticated reads.
 *                                   Every one must be a 503. A 200 here is a
 *                                   request served with no working limiter,
 *                                   which is T11 happening.
 *   restored   quota Redis back.   Gate: recovery to 2xx inside RECOVER_SECONDS.
 *
 * The operator severs the connection; this scenario does not shell out. k6
 * cannot run docker commands and giving a load script the ability to stop
 * infrastructure is a worse idea than typing one line. `load/bin/fail-closed.sh`
 * drives both halves in the right order.
 *
 * IMPORTANT: the cache Redis is NOT touched. Stopping that one tests a
 * different and much less interesting thing (a cache miss). The whole point of
 * the two-instance split is that these two failures are not the same failure.
 *
 *   PHASE=healthy  k6 run load/scenarios/fail-closed.js
 *   PHASE=severed  k6 run load/scenarios/fail-closed.js
 *   PHASE=restored k6 run load/scenarios/fail-closed.js
 */
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { apiRequest } from "../lib/http.js";
import { quotaFailOpenLeaks } from "../lib/metrics.js";
import { buildSummary } from "../lib/summary.js";
import { userAt } from "../lib/users.js";

assertSafeTarget();

/** healthy | severed | restored. Decides which direction is the gate. */
const PHASE = __ENV.PHASE ?? "healthy";
const DURATION = __ENV.PHASE_DURATION ?? "45s";
const VUS = Number(__ENV.PHASE_VUS ?? 20);

if (!["healthy", "severed", "restored"].includes(PHASE)) {
  throw new Error(
    `PHASE must be healthy, severed or restored (got "${PHASE}")`,
  );
}

/**
 * The gate flips with the phase, which is the entire design.
 *
 * In `severed`, a 200 is the defect and a 503 is correct. Expressing that as
 * `quota_fail_open_leaks: count<1` rather than as an inverted http_req_failed
 * keeps the failing metric named after the thing that went wrong, so a red run
 * says "the limiter failed open" rather than "error rate too low".
 */
function thresholdsFor(phase) {
  const shared = {
    // problem+json on every error, in every phase. A 503 that is not
    // problem+json is a contract violation even when the 503 itself is right.
    problem_json_violations: ["count<1"],
  };

  if (phase === "severed") {
    return {
      ...shared,
      /** THE GATE. Any authenticated 2xx while the quota store is unreachable
       *  is T11: a request served with no working limiter. */
      quota_fail_open_leaks: ["count<1"],
      /** Failing closed must also be PROMPT. An enabled offline queue plus a
       *  1s command timeout could turn every request into a one-second hang;
       *  that is technically closed and practically an outage. */
      "http_req_duration{endpoint:wishlist_read}": ["p(95)<3000"],
      failed_closed: ["count>0"],
    };
  }

  return {
    ...shared,
    "http_req_failed{slo:yes}": ["rate<0.01"],
    api_error_rate: ["rate<0.01"],
    // In healthy and restored, failing closed is itself the defect.
    failed_closed: ["count<1"],
    "http_req_duration{slo:yes}": ["p(95)<300"],
  };
}

export const options = {
  scenarios: {
    probe: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: thresholdsFor(PHASE),
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export function setup() {
  const pre = preflight(http);
  if (PHASE === "severed") {
    console.error(
      "\n  PHASE=severed: expecting EVERY authenticated read to answer 503.\n" +
        "  Confirm the quota Redis is actually stopped before trusting a pass:\n" +
        "    docker compose -f docker-compose.dev.yml ps redis-quota\n",
    );
  }
  return pre;
}

export default function () {
  const user = userAt(exec.scenario.iterationInTest);

  // A token-authenticated read is the sharpest probe available: it goes through
  // `enforceTokenRateLimit`, which is the path whose catch block is the claim.
  const res = apiRequest("GET", "/v1/wishlist", {
    endpoint: "wishlist_read",
    user,
    credential: "token",
    // In `severed`, 503 is the correct answer, so it must not be scored as a
    // transport failure by the shared error accounting.
    expect: PHASE === "severed" ? [503] : [200],
    timeout: "10s",
  });

  if (PHASE === "severed") {
    const leaked = res.status >= 200 && res.status < 300;
    if (leaked) quotaFailOpenLeaks.add(1, { endpoint: "wishlist_read" });
    check(res, {
      "severed: answers 503, not 2xx": (r) =>
        !(r.status >= 200 && r.status < 300),
      "severed: the answer is upstream-unavailable": (r) =>
        r.status !== 503 ||
        String(r.body ?? "").includes("upstream-unavailable"),
    });
  } else {
    check(res, { [`${PHASE}: 200`]: (r) => r.status === 200 });
  }

  // A session-authenticated read exercises the OTHER fail-closed path,
  // `isRevoked`, which only runs for a JWT carrying `sid`. The seeder puts one
  // in every session for exactly this reason: without it this half of the
  // scenario would silently test nothing.
  const sess = apiRequest("GET", "/v1/me", {
    endpoint: "me",
    user,
    credential: "session",
    expect: PHASE === "severed" ? [503] : [200],
    timeout: "10s",
  });
  if (PHASE === "severed" && sess.status >= 200 && sess.status < 300) {
    quotaFailOpenLeaks.add(1, { endpoint: "me" });
  }

  sleep(0.2);
}

export function handleSummary(data) {
  return buildSummary(`fail-closed-${PHASE}`, data, {
    profile: `fail-closed:${PHASE}`,
    notes: [
      `phase ${PHASE} for ${DURATION} at ${VUS} VUs against ${CONFIG.baseUrl}`,
      PHASE === "severed"
        ? "GATE: quota_fail_open_leaks == 0. Any authenticated 2xx here is THREAT-MODEL T11."
        : "GATE: failed_closed == 0. A 503 in this phase means the quota store is not healthy.",
      "Only the QUOTA Redis is severed. The cache Redis stays up: the two-instance " +
        "split exists because these are different failures.",
      "Probes both fail-closed paths: enforceTokenRateLimit (token) and isRevoked (session sid).",
    ],
  });
}
