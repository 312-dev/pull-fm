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
 *
 * Cold cache is scored against PLAN.md gate 2 instead (p95 < 2s), because a
 * cold run is measuring upstream resolution, not steady state.
 *
 * Gate 2's "warm cache hit >= 90%" row is ABSENT rather than green. It depended
 * on an `x-cache` header the BFF does not emit, so it had zero samples and
 * passed by default on every run ever made. See CACHE_GATE_UNAVAILABLE below.
 *
 * A NOTE ON EMPTY METRICS: k6 does not evaluate a threshold on a metric that
 * received no samples, and reports it as PASSING. That is how the cache gate
 * went green for its entire life. Every gate here that could legitimately have
 * zero samples is therefore paired with a presence assertion that always gets
 * one: `upstream_calls_per_key` is paired with `upstream_calls: count>0` in the
 * scenarios that read the guard.
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
    /**
     * Measured inside the BFF process by the egress guard.
     *
     * Any attempt to reach a host nobody modelled. Always zero in a healthy
     * run, and always worth investigating when it is not: it means the
     * application tried to talk to something this suite does not know about,
     * and the next place it would have gone is the real internet.
     */
    upstream_refused: ["count<1"],
    /**
     * Single-flight, asserted on every profile rather than only in
     * `coalescing.js`. A stampede is not a performance regression that shows up
     * as a slow p95; it shows up as a revoked API key.
     *
     * The bound is LOOSER here than the `max<=1` that `coalescing.js` gates on,
     * and the difference is not laziness. `coalescing.js` runs for seconds
     * against a fixed key set, so any key fetched twice is a coalescing
     * failure. A steady or soak run lasts long enough for cache entries to
     * reach their TTL and be legitimately refetched, and over four hours a hot
     * key SHOULD be fetched more than once. Gating those at `max<=1` would fail
     * a correct system for keeping its cache fresh.
     *
     * What must never happen at any duration is a key producing calls in the
     * tens, because that is a burst inside one window rather than refreshes
     * spread across it. 10 is the line between the two, and against
     * MusicBrainz's 1 req/s it is already ten seconds of the entire service's
     * global budget spent on one answer.
     */
    upstream_calls_per_key: ["max<10"],
  };
}

/**
 * THE CACHE GATE CANNOT BE EVALUATED, AND THIS IS WHY.
 * ---------------------------------------------------
 * Gate 2 requires "warm cache hit >= 90%", and this suite used to gate on
 * `cache_hit_rate` derived from an `x-cache: HIT | MISS | BYPASS` response
 * header. `load/README.md` listed that header as the first of four things the
 * BFF "must provide".
 *
 * It does not provide it. There is no `x-cache` header on any route, there is
 * no cache-statistics endpoint, and `GET /metrics` is a stub that emits only
 * `pullfm_build_info`. `CachedUpstream.stats()` and `SingleFlight.stats` exist
 * and are never read by anything in `apps/bff`.
 *
 * That left `cache_hit_rate` with zero samples on every run. k6 reports a
 * threshold on a metric with no samples as PASSING, so the cache gate was
 * green on every run and had been since it was written, measuring nothing.
 *
 * Rather than keep a green gate over an absent signal, the cache assertion is
 * removed here and replaced by one that CAN be measured from outside the
 * process: upstream calls per request, counted at the fetch boundary by the
 * egress guard. It answers the question Gate 2 was really asking, which is
 * whether the request path spends upstream quota, and it is strictly harder to
 * fake than a header the application sets about itself.
 *
 * Restoring the real gate needs `x-cache` on the crosswalk-backed reads, in
 * `apps/bff`. Tracked in docs/RUNBOOK-SCALE.md.
 */
const CACHE_GATE_UNAVAILABLE =
  "x-cache is not implemented by apps/bff; see lib/thresholds.js";

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

/** Exported so a run record can carry the reason the cache gate is absent. */
export const CACHE_GATE_NOTE = CACHE_GATE_UNAVAILABLE;

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
        // cache_hit_rate / cache_header_present intentionally absent:
        // CACHE_GATE_UNAVAILABLE.
      };

    case "50k":
      return {
        ...base,
        ...perEndpoint(800),
        "http_req_duration{slo:yes}": ["p(95)<800", "p(99)<1500"],
        "http_req_failed{slo:yes}": [failRate(0.01, abortOnFail)],
        api_error_rate: [failRate(0.01, abortOnFail)],
        // cache_hit_rate / cache_header_present intentionally absent:
        // CACHE_GATE_UNAVAILABLE.
      };

    case "cold":
      return {
        ...base,
        // PLAN.md gate 2: cold-cache p95 < 2s over a 1,000 request replay.
        "http_req_duration{slo:yes}": ["p(95)<2000"],
        "http_req_failed{slo:yes}": ["rate<0.01"],
        api_error_rate: ["rate<0.01"],
        // The inverted "a cold run reporting a high hit rate was not cold"
        // check is gone with the header it depended on: CACHE_GATE_UNAVAILABLE.
        // The equivalent signal is now upstream calls per request, which a warm
        // run drives toward zero and a cold one does not.
        upstream_calls: ["count>0"],
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
        chaos_recovery_seconds: ["p(95)<60"],
        // Cache hit rate was never gated during chaos (an open circuit
        // legitimately changes what is cacheable) and is now unavailable
        // everywhere: CACHE_GATE_UNAVAILABLE.
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
