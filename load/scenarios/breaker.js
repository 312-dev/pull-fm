/**
 * CIRCUIT BREAKER OPEN: what the API serves while an upstream is cut off.
 *
 * WHY THIS IS SEPARATE FROM chaos.js
 * ----------------------------------
 * `chaos.js` walks a fault matrix and measures the system across it. That
 * answers "does it survive faults". It does not isolate the specific state this
 * scenario is about, because a breaker takes FIVE consecutive
 * provider-attributable failures to open (`DEFAULT_BREAKER` in
 * `packages/upstream/src/provider-client.ts`) and then stays open for 30
 * seconds at a time. A matrix cell that holds a fault for 45 seconds spends
 * part of that time in "failing", part in "open", and part in "half-open", and
 * reports one blended percentile over all three.
 *
 * The states behave completely differently and only one of them is fast:
 *
 *   failing    every request pays the provider timeout (5s, or 10s for
 *              MusicBrainz) plus up to 3 retry attempts with jittered backoff.
 *              This is the SLOWEST the system ever is.
 *   open       no upstream call happens at all. Requests should be FASTER than
 *              healthy, because the network hop is skipped entirely.
 *   half_open  two trial requests are admitted; the rest are still short
 *              circuited.
 *
 * A p95 that averages those is a number about nothing. This scenario drives the
 * breaker to `open` deliberately, confirms it is open from outside, and only
 * then measures.
 *
 * WHAT "CONFIRMS FROM OUTSIDE" MEANS
 * ----------------------------------
 * `GET /v1/config` exposes a `providers` map derived live from
 * `killSwitch.isEnabled && breaker.state`: `ok` when closed, `degraded` when
 * open OR half-open, `disabled` when killed. It is public and cheap, and it is
 * the only breaker signal the BFF emits. `GET /metrics` is a stub that carries
 * only `pullfm_build_info`.
 *
 * THE GATE, FROM PLAN.md GATE 7 VERBATIM
 * --------------------------------------
 * "/feed returns 200 with degraded sections, p95 <800ms, errors <1%, no pool
 * exhaustion, recovery <60s."
 *
 * The load-bearing word is "degraded". A 200 carrying zero sections passes an
 * availability probe while serving nothing, so `feed_empty_responses` is gated
 * at zero SEPARATELY from the status code. That distinction is the whole
 * difference between "the API stayed up" and "the API stayed useful".
 *
 * THIS SCENARIO REQUIRES A COLD UPSTREAM CACHE, AND WILL LIE IF IT DOES NOT
 * GET ONE
 * ---------------------------------------------------------------------------
 * The fault can only reach the breaker through a cache MISS. ListenBrainz feed
 * rows are cached for an hour, so a second run inside that hour never calls the
 * provider, the breaker never opens, and the run measures a healthy system
 * while reporting confidently on a broken one. The "breaker reached degraded"
 * check below is what catches it: if that check fails, the run is void, not
 * merely disappointing.
 *
 *   docker exec pullfm-postgres psql -U pullfm -d pullfm -c 'TRUNCATE upstream_cache'
 *   BREAKER_PROVIDER=listenbrainz k6 run load/scenarios/breaker.js
 */
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

import {
  CONFIG,
  assertSafeTarget,
  durationSeconds,
  preflight,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { setFault, clearFaults } from "../lib/mock-control.js";
import { apiRequest } from "../lib/http.js";
import { chaosRecoverySeconds } from "../lib/metrics.js";
import { buildSummary } from "../lib/summary.js";
import { userAt } from "../lib/users.js";

assertSafeTarget();

/**
 * ListenBrainz by default, because it is the only provider the request path
 * reaches synchronously in a way the feed depends on. MusicBrainz and iTunes
 * are unreachable from the request path by design (`peek` only), so forcing
 * their breakers open changes nothing a load test can observe, which is itself
 * the architecture working.
 */
const PROVIDER = __ENV.BREAKER_PROVIDER ?? "listenbrainz";

/** Long enough to exceed failureThreshold=5 with margin under any arrival rate. */
const TRIP_SECONDS = Number(__ENV.BREAKER_TRIP_SECONDS ?? 45);
/** Measured while open. */
const OPEN_SECONDS = Number(__ENV.BREAKER_OPEN_SECONDS ?? 60);

/**
 * How long to WATCH for recovery. Not a gate, and much larger than one.
 *
 * The gate is 60 seconds (PLAN.md gate 7). The window is 300 so that a run
 * which misses the gate still says BY HOW MUCH: 61 seconds and permanently
 * broken need completely different responses, and a 60 second window collapses
 * them into the same 999 sentinel.
 *
 * That distinction earned its keep. This scenario recorded 999 on every run it
 * had ever made, against a runbook that said 62 seconds, and the gap between
 * those two numbers was the whole defect: recovery was waiting on the upstream
 * CACHE to expire, not on the breaker's reset window, because a warm cache
 * means the provider is never called and the breaker's half-open trial never
 * happens. Fixed by a half-open probe in `CachedUpstream`
 * (packages/upstream/src/cache/cache-first.ts), wired in
 * apps/bff/src/services/upstream.ts.
 */
const RECOVER_SECONDS = Number(__ENV.BREAKER_RECOVER_SECONDS ?? 300);

const TOTAL = TRIP_SECONDS + OPEN_SECONDS + RECOVER_SECONDS;

export const options = {
  scenarios: {
    // The conductor owns the fault timeline. One VU, so the schedule is
    // unambiguous; traffic VUs derive the current phase from the clock rather
    // than from a channel k6 does not have.
    conductor: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: `${TOTAL + 60}s`,
      exec: "conduct",
    },
    traffic: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.BREAKER_RATE ?? 10),
      timeUnit: "1s",
      duration: `${TOTAL}s`,
      preAllocatedVUs: 30,
      maxVUs: 100,
      exec: "traffic",
    },
  },
  thresholds: {
    // Gate 7, verbatim, but scoped to the OPEN window. Measuring across the
    // failing window would gate on the provider's timeout rather than on our
    // behaviour, and the provider's timeout is not ours to meet.
    "http_req_duration{phase:open}": ["p(95)<800"],
    "http_req_failed{phase:open}": ["rate<0.01"],
    // A 200 with no sections is not availability. This is the difference
    // between the API being up and the API being useful.
    feed_empty_responses: ["count<1"],
    /**
     * Gate 7: recovery under 60s after the fault clears.
     *
     * Was RED on every run this scenario ever made, at the 999 "never came
     * back" sentinel rather than the 62s the runbook recorded. The threshold
     * was held at the plan's number throughout rather than relaxed to fit the
     * observation. See docs/RUNBOOK-SCALE.md section 6.1 for what it turned out
     * to be, and for the plausible-looking breaker-side fix that was rejected
     * because it made this threshold pass by making it measure nothing.
     */
    chaos_recovery_seconds: ["p(95)<60"],
    problem_json_violations: ["count<1"],
    // While open, the breaker skips the network entirely, so the feed should be
    // FASTER than a healthy call, not slower. A regression here means requests
    // are still reaching the provider and the breaker is not doing its job.
    "http_req_duration{phase:open,endpoint:feed}": ["p(95)<800"],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

const startedAt = Date.now();

/** Which window a request belongs to, derived from the clock. */
function phaseNow() {
  const t = (Date.now() - startedAt) / 1000;
  if (t < TRIP_SECONDS) return "failing";
  if (t < TRIP_SECONDS + OPEN_SECONDS) return "open";
  return "recovering";
}

export function setup() {
  const pre = preflight(http, { requireMock: true });
  clearFaults();
  return pre;
}

export function conduct() {
  // Force the provider to fail. `500` rather than `429`: a 429 is recorded as a
  // breaker SUCCESS in provider-client.ts (quota exhaustion must never trip a
  // circuit), so driving the breaker with 429s would wait forever.
  setFault(PROVIDER, "500", `${PROVIDER}-breaker-trip`);
  sleep(TRIP_SECONDS);

  // Confirm the breaker is actually open before the measured window opens. If
  // it is not, the "open" thresholds would be measured against a provider that
  // is merely slow, and would pass or fail for the wrong reason.
  const state = providerState(PROVIDER);
  check(
    { state },
    {
      "breaker reached degraded (open or half-open) before the measured window":
        (s) => s.state === "degraded" || s.state === "disabled",
    },
  );
  console.error(`  breaker: /v1/config reports ${PROVIDER} = ${state}`);

  sleep(OPEN_SECONDS);

  // Clear and time the recovery. The breaker will not close until it has been
  // open for resetTimeoutMs AND two consecutive half-open trials succeed, so
  // recovery is genuinely a system property here rather than a mock property.
  clearFaults();
  const clearedAt = Date.now();

  let healthy = 0;
  for (let i = 0; i < RECOVER_SECONDS; i++) {
    if (providerState(PROVIDER) === "ok") {
      healthy++;
      // Two consecutive clean reads, because a single one can land on a
      // half-open trial that has not yet closed the circuit.
      if (healthy >= 2) {
        chaosRecoverySeconds.add((Date.now() - clearedAt) / 1000, {
          provider: PROVIDER,
        });
        return;
      }
    } else {
      healthy = 0;
    }
    sleep(1);
  }

  // 999 is the sentinel for "never came back inside the window". Recorded
  // rather than omitted: a missing sample would make the threshold pass on no
  // data.
  chaosRecoverySeconds.add(999, { provider: PROVIDER });
}

export function traffic() {
  const phase = phaseNow();
  const user = userAt(exec.scenario.iterationInTest);

  const feed = apiRequest("GET", "/v1/feed", {
    endpoint: "feed",
    user,
    credential: "token",
    phase,
    timeout: "20s",
  });

  check(feed, {
    "feed answers 200 even with the breaker open": (r) => r.status === 200,
  });

  if (feed.status === 200) {
    let body = null;
    try {
      body = feed.json();
    } catch {
      /* counted by the shared accounting */
    }
    if (body) {
      check(body, {
        // Gate 7's "degraded sections": the response must SAY it is degraded
        // rather than silently returning less. A client that cannot tell the
        // difference renders an empty state as if it were the truth.
        "degraded state is declared, not implied": (b) =>
          phase === "open" ? b.degraded === true : true,
        "unavailable providers are named": (b) =>
          phase !== "open" ||
          (Array.isArray(b.unavailableProviders) &&
            b.unavailableProviders.length > 0),
      });
    }
  }

  sleep(0.5);
}

/** Coarse provider health from the public config document. */
function providerState(provider) {
  const res = http.get(`${CONFIG.baseUrl}/v1/config`, {
    timeout: "5s",
    tags: { endpoint: "config_probe", slo: "no" },
  });
  if (res.status !== 200) return "unknown";
  try {
    return res.json().providers[provider] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function teardown() {
  // Never leave the mock in a faulted state: the next scenario would inherit it
  // and blame itself.
  clearFaults();
}

export function handleSummary(data) {
  return buildSummary("breaker", data, {
    profile: "breaker",
    notes: [
      `provider ${PROVIDER}: ${TRIP_SECONDS}s failing, ${OPEN_SECONDS}s measured open, ${RECOVER_SECONDS}s recovery window`,
      "GATE (PLAN.md gate 7): /feed 200 with declared degradation, p95<800ms while OPEN, errors<1%, recovery<60s",
      "Thresholds are scoped to phase:open. The failing window is dominated by the " +
        "provider timeout (5s, 10s for MusicBrainz) plus retries, which is not our SLO to meet.",
      "Driven with 500s, not 429s: provider-client.ts records quota exhaustion as a " +
        "breaker SUCCESS, so a 429-driven run would never trip the circuit.",
      "Recovery is bounded by the breaker's reset window only because CachedUpstream " +
        "spends a fresh hit on a half-open trial. Without that probe a warm cache " +
        "answers every request, the provider is never called, and recovery waits for " +
        "the cache TTL instead. See docs/RUNBOOK-SCALE.md section 6.1.",
      `duration derived: ${durationSeconds(`${TOTAL}s`)}s total`,
    ],
  });
}
