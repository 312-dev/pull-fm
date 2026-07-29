/**
 * Custom metrics.
 *
 * Declared once, in one module, because k6 metrics must be constructed in the
 * init context and a duplicate name in two files is a silent merge that makes
 * a threshold mean something other than what it says.
 */
import { Counter, Rate, Trend } from "k6/metrics";

/** Warm cache hit ratio. The gate is >90% at 10k (PLAN.md gate 2 and the SLO
 *  table). Recorded only for endpoints whose responses are cacheable. */
export const cacheHitRate = new Rate("cache_hit_rate");

/** Did the response carry an x-cache header at all? Separate from the hit rate
 *  on purpose: if the BFF stops emitting the header, cache_hit_rate silently
 *  loses its samples and a threshold over an empty metric PASSES in k6. This
 *  metric always gets a sample, so the gate fails loudly instead. */
export const cacheHeaderPresent = new Rate("cache_header_present");

/** Business-level error rate. Narrower than http_req_failed: a 404 on a
 *  deliberately absent resource is a correct response, not an error. */
export const apiErrorRate = new Rate("api_error_rate");

/** Errors returned as something other than RFC 9457 problem+json, which
 *  PLAN.md section 6 requires everywhere. A contract regression shows up here
 *  before a client ever sees it. */
export const problemJsonViolations = new Counter("problem_json_violations");

/** Feed responses that were 200 but carried no sections at all. Gate 7 asks
 *  for "200 with degraded sections", and an empty 200 is the way a system
 *  passes an availability check while serving nothing. */
export const feedEmpty = new Counter("feed_empty_responses");
export const feedDegraded = new Rate("feed_degraded_rate");

/** Seconds from clearing an injected fault to the feed being healthy again.
 *  Gate 7 requires recovery <60s. */
export const chaosRecoverySeconds = new Trend("chaos_recovery_seconds");

/** Set in teardown from the mock's own accounting. Nonzero means our client
 *  exceeded a real provider's published ceiling, which no amount of good p95
 *  makes acceptable. */
export const upstreamQuotaViolations = new Counter("upstream_quota_violations");

/** Deezer preview URLs that had expired by the time they were played. Nonzero
 *  means a signed, short-lived URL was cached somewhere it should not have
 *  been (PLAN.md section 1a rule 4). */
export const expiredPreviewUrls = new Counter("expired_preview_urls");

/** Responses that came from the fake BFF in mock-upstreams/bff-stub.js.
 *  Carried as a metric rather than a module variable because handleSummary runs
 *  in its own context and cannot see VU state. Any sample here makes the run
 *  unusable as gate evidence. */
export const stubResponses = new Counter("stub_responses");

/** Sessions completed end to end. Divided by run duration this is the real
 *  throughput number for the capacity model in PLAN.md section 8. */
export const sessionsCompleted = new Counter("sessions_completed");
export const sessionDuration = new Trend("session_duration", true);

// ---------------------------------------------------------------------------
// Upstream fan-out, measured inside the BFF process by the egress guard.
// ---------------------------------------------------------------------------

/**
 * The most calls any ONE cache key produced during the measured window.
 *
 * This is the single-flight gate as a single number. N concurrent cold misses
 * for one key must produce exactly 1 upstream call
 * (`packages/upstream/src/single-flight.ts`); anything more is the stampede the
 * coalescer exists to prevent, and against MusicBrainz's 1 req/s global ceiling
 * a stampede is a terms violation rather than a latency problem.
 *
 * Set in teardown from `GET /__guard/stats`, because k6 cannot make HTTP calls
 * from `handleSummary`.
 */
export const upstreamCallsPerKey = new Trend("upstream_calls_per_key");

/** Total provider calls the BFF attempted during the run. The numerator of the
 *  capacity model's "upstream calls per request" row. */
export const upstreamCalls = new Counter("upstream_calls");

/** Attempts to reach a host the guard did not recognise. Any sample means the
 *  BFF tried to talk to something no one modelled, which is a finding whether
 *  or not it was refused. */
export const upstreamRefused = new Counter("upstream_refused");

// ---------------------------------------------------------------------------
// Authentication and limiter behaviour.
// ---------------------------------------------------------------------------

/** Requests that wanted the personal-API-token surface and had to fall back to
 *  a session, because the seeder could not mint a token for that subject. */
export const tokenFallbacks = new Counter("token_auth_fallbacks");

/** 429s attributable to the per-token budget rather than the global per-IP
 *  limiter. Under-provisioned fixtures, not a system defect. */
export const tokenRateLimited = new Counter("token_rate_limited");

/**
 * Fail-closed accounting for the quota-Redis scenario.
 *
 * `failed_closed` counts 503s and `failed_open` counts 2xx. Under normal load
 * the gate is on the first; while the quota Redis is refusing writes the gate
 * inverts, because a 200 served with no working limiter is the T11 failure the
 * separate `noeviction` instance exists to make impossible.
 */
export const failedClosed = new Counter("failed_closed");
export const failedOpen = new Counter("failed_open");

/** Requests served while the quota Redis was deliberately unavailable that did
 *  NOT fail closed. The gate for the fail-closed scenario: must be zero. */
export const quotaFailOpenLeaks = new Counter("quota_fail_open_leaks");

/** Database errors surfaced to the client while the connection pool was
 *  saturated. Distinguishes queueing (fine) from exhaustion (not). */
export const poolExhaustionErrors = new Counter("pool_exhaustion_errors");
