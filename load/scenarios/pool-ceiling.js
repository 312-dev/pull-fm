/**
 * CONNECTION POOL CEILING.
 *
 * THE QUESTION
 * ------------
 * Gate 1 asserts "the transaction pooler serves >= 200 client conns on <= 25
 * server conns (Neon's pooled endpoint in the cloud, PgBouncer locally)". Gate
 * 7 asserts "no pool exhaustion" under the failure-injection matrix. Both are
 * about the same thing from two directions: what happens when concurrent
 * database work exceeds the number of connections available to do it.
 *
 * There are TWO pools in series and they fail differently, which is why a
 * single number is not an answer:
 *
 *   1. The BFF's own `pg.Pool`, sized by `DATABASE_POOL_MAX` (default 10).
 *      Deliberately small: "concurrency is absorbed by PgBouncer in transaction
 *      mode, and every BFF node multiplies into the server's max_connections"
 *      (apps/bff/src/lib/db.ts). Saturating it makes requests QUEUE inside the
 *      process. Queueing is correct behaviour; the failure is when the queue
 *      grows without bound and latency goes to the request timeout.
 *   2. The transaction pooler in front of Postgres. Saturating it makes
 *      requests queue in PgBouncer or Neon instead, and exhausting
 *      `MAX_CLIENT_CONN` produces connection errors rather than slow answers.
 *
 * WHAT THIS SCENARIO CAN AND CANNOT SEE, STATED UP FRONT
 * -----------------------------------------------------
 * It ramps concurrency well past `DATABASE_POOL_MAX` on the most
 * database-heavy authenticated route and watches for the transition from
 * "queues, stays correct" to "errors". That is pool 1, and it is measurable.
 *
 * Pool 2 used to be unmeasurable on the local stack, and the reason was a real
 * defect rather than a missing feature: the BFF passes `statement_timeout` and
 * `idle_in_transaction_session_timeout` as connection parameters, and PgBouncer
 * rejected them with `unsupported startup parameter: statement_timeout`, so the
 * BFF could not connect through port 6432 at all. Fixed in
 * docker-compose.dev.yml plus infra/local/postgres-init/01-role-timeouts.sql -
 * both halves, because `ignore_startup_parameters` on its own lets the
 * connection through while silently discarding the timeout. The reasoning and
 * the measurements are in docs/RUNBOOK-SCALE.md section 6.2.
 *
 * So: point `DATABASE_URL` at 6432 and run with `POOL_ENDPOINT=pooled`.
 * `POOL_ENDPOINT` is recorded in the run record so a result can never be quoted
 * as evidence for the endpoint it did not use, and a run against 5432 is still
 * a legitimate measurement of pool 1 alone as long as it says so.
 *
 *   CEILING_VUS=200 k6 run load/scenarios/pool-ceiling.js
 */
import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { apiRequest } from "../lib/http.js";
import { poolExhaustionErrors } from "../lib/metrics.js";
import { buildSummary } from "../lib/summary.js";
import { userAt } from "../lib/users.js";

assertSafeTarget();

/** Peak concurrent in-flight requests. Default 200 because that is the number
 *  Gate 1 names for client connections through the pooler. */
const CEILING_VUS = Number(__ENV.CEILING_VUS ?? 200);
const STEP = __ENV.CEILING_STEP ?? "30s";

/** Recorded, never inferred. A pool result is meaningless without knowing which
 *  endpoint the BFF was pointed at. */
const POOL_ENDPOINT = __ENV.POOL_ENDPOINT ?? "unknown";

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 5,
      // A staircase rather than a smooth ramp: a plateau at each level is what
      // lets you read off WHERE the transition happened. A continuous ramp
      // gives one blended percentile and no answer to "at what concurrency".
      stages: [
        { duration: STEP, target: Math.round(CEILING_VUS * 0.1) },
        { duration: STEP, target: Math.round(CEILING_VUS * 0.25) },
        { duration: STEP, target: Math.round(CEILING_VUS * 0.5) },
        { duration: STEP, target: CEILING_VUS },
        { duration: STEP, target: CEILING_VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
  thresholds: {
    /**
     * THE GATE, and it is deliberately about ERRORS rather than latency.
     *
     * Queueing behind a small pool is the design working. Latency rising with
     * concurrency is arithmetic, not a defect, and gating on p95 here would
     * fail a correctly behaving system for being asked to do more work than it
     * has connections for. What must NOT happen is the pool giving up: a
     * connection error, a pool-timeout 500, or a transport failure.
     */
    pool_exhaustion_errors: ["count<1"],
    // `api_error_rate` rather than `http_req_failed`, because the two disagree
    // here on purpose: a 429 is a modelled refusal that the shared accounting
    // treats as expected, and gating on raw transport failure would score a
    // working rate limiter as a broken pool.
    api_error_rate: ["rate<0.01"],
    problem_json_violations: ["count<1"],
    // A ceiling that answers correctly but takes 30 seconds has not passed
    // anything useful. Generous, because this is a saturation run.
    "http_req_duration{slo:yes}": ["p(95)<5000", "p(99)<10000"],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export function setup() {
  const pre = preflight(http);
  if (POOL_ENDPOINT === "unknown") {
    console.warn(
      "\n  POOL_ENDPOINT is unset. Set it to 'pooled' or 'direct' so the run\n" +
        "  record says which endpoint produced these numbers.\n",
    );
  }
  return pre;
}

export default function () {
  const user = userAt(exec.scenario.iterationInTest);

  // `GET /v1/wishlist` is the most database-bound authenticated read on the
  // surface: it authenticates, then runs a paginated user-scoped query.
  // Discovery routes are dominated by upstream and cache work and would measure
  // something else.
  //
  // SESSION rather than token, and this is not a detail.
  //
  // A first version of this scenario used the personal API token. At 200 VUs
  // with no think time it produced 696,259 requests and a 95% failure rate, and
  // every one of those failures was a 429 from the PER-TOKEN budget
  // (`rate_limit_per_minute`, 600/min even when raised from the 60/min
  // default). The limiter refused long before the connection pool was under any
  // pressure at all, so the run measured the limiter working correctly and
  // learned nothing whatsoever about the pool.
  //
  // That is a real property worth stating rather than a bug worth hiding: the
  // per-token budget is the binding constraint on token-authenticated
  // throughput, and no database tuning moves it. Sessions carry no per-token
  // bucket, so they are the only credential that can reach the pool.
  const res = apiRequest("GET", "/v1/wishlist?limit=100", {
    endpoint: "wishlist_read",
    user,
    credential: "session",
    // A 429 is a correct refusal, not a transport failure. Counting it as an
    // error would make the limiter's success look like the pool's failure.
    expect: [200, 429],
    timeout: "30s",
  });

  // Distinguish "queued and answered" from "gave up". Status 0 is a transport
  // failure; 500 and 503 here are the pool refusing rather than the limiter
  // deciding, because the limiter's own refusal is a 429.
  if (res.status === 0 || res.status === 500) {
    poolExhaustionErrors.add(1, { status: String(res.status) });
  }

  check(res, {
    "answered at all": (r) => r.status !== 0,
    "answered 200 or a modelled refusal": (r) =>
      r.status === 200 || r.status === 429 || r.status === 503,
  });

  // Also exercise a WRITE, which takes a connection out of the pool for the
  // length of a transaction rather than a single statement. A read-only ramp
  // understates pool pressure by exactly the factor that matters.
  if (exec.vu.iterationInInstance % 10 === 0) {
    const n = exec.scenario.iterationInTest;
    apiRequest("POST", "/v1/wishlist", {
      endpoint: "wishlist_add",
      user,
      credential: "session",
      body: {
        artistName: `Pool Artist ${n % 1000}`,
        title: `Pool Title ${n}`,
        source: "recommendation",
      },
      expect: [200, 201],
      timeout: "30s",
    });
  }
}

export function handleSummary(data) {
  return buildSummary("pool-ceiling", data, {
    profile: "pool-ceiling",
    notes: [
      `staircase to ${CEILING_VUS} concurrent VUs, ${STEP} per step, against ${CONFIG.baseUrl}`,
      `POOL_ENDPOINT=${POOL_ENDPOINT}`,
      "GATE: pool_exhaustion_errors == 0. Queueing is correct; giving up is not.",
      "Uses SESSION auth: the per-token budget (600/min even when raised) refuses " +
        "long before the pool is under pressure, so a token-authenticated ramp " +
        "measures the limiter rather than the pool.",
      "Measures the BFF's own pg.Pool (DATABASE_POOL_MAX). The transaction pooler " +
        "in front of it is a SEPARATE ceiling and is not measured when " +
        "POOL_ENDPOINT=direct.",
      "Latency thresholds are deliberately loose: rising latency under saturation " +
        "is arithmetic, not a defect. The defect is a connection error.",
    ],
  });
}
