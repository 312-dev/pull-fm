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
