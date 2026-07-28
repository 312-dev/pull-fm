/**
 * SLO thresholds.
 *
 * These are pass/fail gates, not report lines. A crossed threshold makes k6
 * exit 99, which fails the build. That is the entire point: PLAN.md section 7
 * requires every gate to be machine checkable, and a number printed in a
 * summary that nobody diffs is not a gate.
 *
 *   Metric        @10k        @50k burst
 *   API p95       < 300 ms    < 800 ms
 *   API p99       < 600 ms    < 1500 ms
 *   Error rate    < 0.1%      < 1%
 *   Cache hit     > 90%       > 90%
 *
 * Cold cache is scored against PLAN.md gate 2 instead (p95 < 2s), because a
 * cold run is measuring upstream resolution, not steady state.
 *
 * A NOTE ON EMPTY METRICS: k6 does not evaluate a threshold on a metric that
 * received no samples, and reports it as passing. Any gate that could
 * legitimately have zero samples is therefore paired with a presence metric
 * that always gets one (cache_hit_rate is paired with cache_header_present).
 */

/** Thresholds every profile shares: correctness, not performance. */
function correctnessThresholds() {
  return {
    // Any check failing is a contract violation. The check names say what.
    checks: ["rate>0.99"],
    // PLAN.md section 6: RFC 9457 problem+json on every error response.
    problem_json_violations: ["count<1"],
    // Gate 7: a 200 carrying no sections is not availability.
    feed_empty_responses: ["count<1"],
    // Measured from the mock's own egress accounting in teardown. Nonzero
    // means we exceeded a real provider's published ceiling.
    upstream_quota_violations: ["count<1"],
    // PLAN.md 1a rule 4: a Deezer preview URL was cached and had expired by
    // the time it was played.
    expired_preview_urls: ["count<1"],
  };
}

/** Per-endpoint budgets. The aggregate p95 can pass while the endpoint that
 *  matters is slow, because the fast endpoints outnumber it. */
function perEndpoint(
  p95,
  { feed = p95, preview = p95, search = p95, config = Math.min(p95, 150) } = {},
) {
  return {
    "http_req_duration{endpoint:feed}": [`p(95)<${feed}`],
    "http_req_duration{endpoint:track_preview}": [`p(95)<${preview}`],
    "http_req_duration{endpoint:search}": [`p(95)<${search}`],
    // /v1/config is served from memory on every cold start. If it is slow,
    // every app launch is slow.
    "http_req_duration{endpoint:config}": [`p(95)<${config}`],
  };
}

/**
 * @param {'10k'|'50k'|'cold'|'chaos'} profile
 * @param {{smoke?:boolean, abortOnFail?:boolean}} opts
 */
export function sloThresholds(profile, opts = {}) {
  const { smoke = false, abortOnFail = false } = opts;

  if (smoke) {
    // Deliberately weak. A smoke run proves the harness works, not that the
    // system meets its SLO, and lib/summary.js marks the result unusable for a
    // gate record.
    return {
      "http_req_duration{slo:yes}": ["p(95)<5000"],
      "http_req_failed{slo:yes}": ["rate<0.5"],
      cache_header_present: ["rate>0.5"],
    };
  }

  const base = correctnessThresholds();

  switch (profile) {
    case "10k":
      return {
        ...base,
        ...perEndpoint(300),
        "http_req_duration{slo:yes}": ["p(95)<300", "p(99)<600"],
        "http_req_failed{slo:yes}": [failRate(0.001, abortOnFail)],
        api_error_rate: [failRate(0.001, abortOnFail)],
        cache_hit_rate: ["rate>0.90"],
        // Guards the metric above: if the BFF stops sending x-cache, this
        // fails instead of the cache gate passing on no data.
        cache_header_present: ["rate>0.99"],
      };

    case "50k":
      return {
        ...base,
        ...perEndpoint(800),
        "http_req_duration{slo:yes}": ["p(95)<800", "p(99)<1500"],
        "http_req_failed{slo:yes}": [failRate(0.01, abortOnFail)],
        api_error_rate: [failRate(0.01, abortOnFail)],
        cache_hit_rate: ["rate>0.90"],
        cache_header_present: ["rate>0.99"],
      };

    case "cold":
      return {
        ...base,
        // PLAN.md gate 2: cold-cache p95 < 2s over a 1,000 request replay.
        "http_req_duration{slo:yes}": ["p(95)<2000"],
        "http_req_failed{slo:yes}": ["rate<0.01"],
        api_error_rate: ["rate<0.01"],
        cache_header_present: ["rate>0.99"],
        // A cold run that reports a high hit rate was not cold. This inverted
        // threshold is a false-green detector, not a performance gate.
        cache_hit_rate: ["rate<0.50"],
      };

    case "chaos":
      return {
        ...base,
        // Gate 7, verbatim: /feed returns 200 with degraded sections,
        // p95 < 800ms, errors < 1%, recovery < 60s.
        "http_req_duration{endpoint:feed}": ["p(95)<800"],
        "http_req_duration{slo:yes}": ["p(95)<800"],
        "http_req_failed{endpoint:feed}": ["rate<0.01"],
        api_error_rate: ["rate<0.01"],
        chaos_recovery_seconds: ["p(95)<60", "max<120"],
        cache_header_present: ["rate>0.99"],
        // Cache hit rate is not gated during chaos: an open circuit legitimately
        // changes what is cacheable.
      };

    default:
      throw new Error(`unknown SLO profile: ${profile}`);
  }
}

/**
 * Aborting early matters for the 4 hour soak: discovering at minute 5 that the
 * error rate is 40% and then waiting 235 more minutes helps nobody. The delay
 * gives caches and pools time to settle before the threshold starts counting.
 */
function failRate(rate, abort) {
  return abort
    ? { threshold: `rate<${rate}`, abortOnFail: true, delayAbortEval: "3m" }
    : `rate<${rate}`;
}
