/**
 * The single request path used by every scenario.
 *
 * Centralised so that auth, tagging, cache accounting and the RFC 9457 contract
 * check cannot drift between scenarios. A scenario that builds its own
 * http.get() call is a scenario whose numbers do not line up with the others.
 */
import http from "k6/http";
import { check } from "k6";

import { CONFIG } from "./config.js";
import { isWarmup } from "./phase.js";
import {
  apiErrorRate,
  cacheHitRate,
  cacheHeaderPresent,
  problemJsonViolations,
  expiredPreviewUrls,
  stubResponses,
} from "./metrics.js";

function header(res, name) {
  // k6 canonicalises header names, but a proxy in front of the BFF may not.
  const direct = res.headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const k of Object.keys(res.headers)) {
    if (k.toLowerCase() === lower) return res.headers[k];
  }
  return undefined;
}

function baseHeaders(user) {
  const h = {
    accept: "application/json",
    // Identifies the traffic in the BFF's own logs. A load run that cannot be
    // separated from real traffic after the fact is a load run you cannot
    // explain to anyone.
    "user-agent":
      "PullFM-LoadTest/1.0 (+https://github.com/312-dev/pull-fm; k6)",
  };
  if (CONFIG.authToken) h.authorization = `Bearer ${CONFIG.authToken}`;
  if (user) {
    // One staging token, many synthetic subjects. The BFF must honour this
    // ONLY under its own LOAD_TEST_MODE flag, never in production. See README.
    h["x-load-test-user"] = user.id;
  }
  return h;
}

/**
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} path e.g. '/v1/feed'
 * @param {object} opts
 *   endpoint    stable low-cardinality tag, e.g. 'track_preview'. REQUIRED:
 *               tagging by URL would create one metric per MBID.
 *   user        synthetic user, supplies the subject header
 *   cacheable   record cache hit/miss metrics for this call
 *   slo         count this request against the API SLO thresholds (default yes)
 *   expect      status codes that are correct answers, not errors
 *   phase       optional extra tag, used by the soak and chaos scenarios
 */
export function apiRequest(method, path, opts = {}) {
  const {
    endpoint,
    user,
    body,
    cacheable = false,
    slo = true,
    expect = [200, 201, 204],
    phase,
    timeout = "10s",
  } = opts;

  if (!endpoint)
    throw new Error(`apiRequest to ${path} is missing an endpoint tag`);

  // Warm-up traffic is real traffic (it is what warms the cache) but it is not
  // evidence: measuring the SLO or the hit rate while the cache is still being
  // filled scores the warm-up rather than the system. See lib/phase.js.
  const warming = isWarmup(phase);
  const countForSlo = slo && !warming;
  const countForCache = cacheable && !warming;

  const headers = { ...baseHeaders(user), ...(opts.headers ?? {}) };
  if (method === "POST" || method === "DELETE") {
    // PLAN.md section 6 requires Idempotency-Key on every mutating call. Sent
    // unconditionally so the requirement is exercised, not assumed.
    headers["idempotency-key"] ??=
      `${user ? user.id : "anon"}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
  }

  const tags = { endpoint, slo: countForSlo ? "yes" : "no" };
  if (phase) tags.phase = phase;

  const res = http.request(
    method,
    `${CONFIG.baseUrl}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers,
      tags,
      timeout,
    },
  );

  record(res, { endpoint, cacheable: countForCache, expect });
  return res;
}

function record(res, { endpoint, cacheable, expect }) {
  if (header(res, "X-Pullfm-Stub") === "1") {
    stubResponses.add(1);
  }

  const ok = expect.includes(res.status);
  // status 0 is a transport failure (connect error, timeout, reset). Always an
  // error, and the one people forget to count.
  apiErrorRate.add(!ok || res.status === 0, { endpoint });

  if (cacheable) {
    const raw = header(res, "X-Cache");
    const present = raw !== undefined;
    cacheHeaderPresent.add(present, { endpoint });
    if (present) {
      // BYPASS (uncacheable by design) is neither a hit nor a miss and must not
      // dilute the ratio the gate is measured on.
      const v = String(raw).toUpperCase();
      if (v === "HIT" || v === "MISS")
        cacheHitRate.add(v === "HIT", { endpoint });
    }
  }

  if (res.status >= 400 && res.status !== 0) {
    const ct = String(header(res, "Content-Type") ?? "");
    if (!ct.includes("application/problem+json")) {
      problemJsonViolations.add(1, { endpoint, status: String(res.status) });
    }
  }
}

/**
 * Play the resolved preview URL, as a client would.
 *
 * This is the only way a wrongly cached Deezer URL becomes visible: the mock's
 * CDN verifies the signature and the expiry for real, so a stored URL starts
 * returning 403 once its TTL lapses. Off by default because it doubles the
 * request count; on for the runs where cache correctness is the question.
 */
export function playPreview(url, user) {
  if (!url) return null;
  const res = http.get(url, {
    headers: {
      "user-agent": baseHeaders(user)["user-agent"],
      range: "bytes=0-1023",
    },
    tags: { endpoint: "preview_media", slo: "no" },
    timeout: "10s",
  });
  const reason = header(res, "X-Pullfm-Mock-Reason");
  if (res.status === 403 && reason === "expired") {
    expiredPreviewUrls.add(1);
  }
  check(res, {
    "preview url is playable (not expired or forged)": (r) =>
      r.status === 200 || r.status === 206,
  });
  return res;
}
