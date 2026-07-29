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
import { credentialFor } from "./subjects.js";
import {
  apiErrorRate,
  cacheHitRate,
  cacheHeaderPresent,
  failedClosed,
  failedOpen,
  problemJsonViolations,
  expiredPreviewUrls,
  stubResponses,
  tokenFallbacks,
  tokenRateLimited,
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

/**
 * Headers for one request, carrying a REAL credential for the acting subject.
 *
 * An earlier revision sent one shared bearer token plus `X-Load-Test-User:
 * <subject>` and asserted that the BFF "must honour that header behind its own
 * LOAD_TEST_MODE flag". No such flag exists, no such header is read, and
 * `requireAuth` rejects any request carrying an `X-User-Id` header with a 400
 * precisely because impersonation-by-header is the thing it is defending
 * against. Sending it would have produced a run in which every request was
 * unauthenticated.
 *
 * Each subject now holds two real credentials (`load/lib/subjects.js`) and the
 * caller says which one the route admits.
 */
function baseHeaders(user, credentialKind) {
  const h = {
    accept: "application/json",
    // Identifies the traffic in the BFF's own logs. A load run that cannot be
    // separated from real traffic after the fact is a load run you cannot
    // explain to anyone.
    "user-agent":
      "PullFM-LoadTest/1.0 (+https://github.com/312-dev/pull-fm; k6)",
  };

  if (user && user.subject) {
    const cred = credentialFor(user.subject, credentialKind);
    if (cred.value) {
      h.authorization = `Bearer ${cred.value}`;
      if (credentialKind === "token" && cred.kind !== "token") {
        // Asked for the token surface, got the session instead. Counted so the
        // summary can say the token path was under-exercised rather than the
        // run silently measuring the session path twice.
        tokenFallbacks.add(1);
      }
    }
  } else if (CONFIG.authToken) {
    // Escape hatch for a single-credential probe against a target where the
    // manifest is not available. Not a load path.
    h.authorization = `Bearer ${CONFIG.authToken}`;
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
    /** 'token' where requireAuth admits a personal API token, else 'session'. */
    credential = "session",
  } = opts;

  if (!endpoint)
    throw new Error(`apiRequest to ${path} is missing an endpoint tag`);

  // Warm-up traffic is real traffic (it is what warms the cache) but it is not
  // evidence: measuring the SLO or the hit rate while the cache is still being
  // filled scores the warm-up rather than the system. See lib/phase.js.
  const warming = isWarmup(phase);
  const countForSlo = slo && !warming;
  const countForCache = cacheable && !warming;

  const headers = {
    ...baseHeaders(user, credential),
    ...(opts.headers ?? {}),
  };
  if (method === "POST" || method === "DELETE") {
    // `POST /v1/wishlist` requires Idempotency-Key (8-255 chars) and answers
    // 409 when the same key arrives with a different body, so the value has to
    // be unique per call rather than per session.
    headers["idempotency-key"] ??=
      `${user ? user.index : "anon"}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      /**
       * Teach k6 which statuses are correct answers for THIS request.
       *
       * By default `http_req_failed` counts every response >= 400 as a failure.
       * That is wrong here in a way that made the metric unusable: the
       * catalogue routes (`/v1/artists/:mbid`, `/v1/tracks/:mbid`,
       * `/v1/albums/:mbid`, and the preview route) read the crosswalk and
       * `track_previews` without ever calling out, so a 404 on an unresolved
       * MBID is the documented behaviour and the whole reason those routes are
       * safe to expose. A first run against the real BFF reported a 64% "http
       * failed rate" that was almost entirely correct 404s.
       *
       * With this, `http_req_failed` means "not one of the answers this call
       * considers correct", which is what the gate was always supposed to say.
       */
      responseCallback: http.expectedStatuses(...expect),
    },
  );

  record(res, { endpoint, cacheable: countForCache, expect, credential });
  return res;
}

function record(res, { endpoint, cacheable, expect, credential }) {
  if (header(res, "X-Pullfm-Stub") === "1") {
    stubResponses.add(1);
  }

  // A 429 on a token-authenticated call is the per-token budget
  // (`rate_limit_per_minute`, 60/min by default), not the global per-IP
  // limiter. Separated because the remedies are opposite: one means the load
  // shape is wrong, the other means the fixtures are under-provisioned.
  if (res.status === 429 && credential === "token") tokenRateLimited.add(1);

  // Fail-closed accounting. `enforceTokenRateLimit`, `isRevoked` and the
  // auth-flow budgets all convert an unreachable quota Redis into
  // `upstream_unavailable`, which is a 503. Under the fail-closed scenario a
  // 503 is the CORRECT answer and a 200 is the defect, so both directions are
  // counted and the scenario decides which one is the gate.
  if (res.status === 503) failedClosed.add(1, { endpoint });
  else if (res.status >= 200 && res.status < 300)
    failedOpen.add(1, { endpoint });

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
