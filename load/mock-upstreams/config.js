/**
 * Provider behavior profiles for the mock upstream server.
 *
 * WHY THESE NUMBERS
 * -----------------
 * A mock that answers 200/1ms proves nothing: it makes every client look fast
 * and every retry policy look correct. The point of this file is to reproduce
 * the three properties that actually break us in production - how slow each
 * upstream is, how it refuses us when we exceed quota, and what its failure
 * looks like on the wire.
 *
 * Quota numbers come from docs/UPSTREAM-TERMS.md (audited 2026-07-28).
 * Latency numbers are modeled from typical observed behavior, not measured
 * over a long window, and are the least trustworthy values here. Re-measure
 * before treating a gate result as precise; every one of them is tunable at
 * runtime through POST /__admin/config, so a re-audit does not need a code
 * change.
 *
 * Refusal shapes deliberately differ per provider because they really do
 * differ, and a client written against "429 plus Retry-After" is wrong for
 * three of the six:
 *
 *   MusicBrainz  503 + X-RateLimit-* headers, no Retry-After
 *   Last.fm      429 + its own JSON error envelope (code 29)
 *   ListenBrainz 429 + X-RateLimit-Reset-In
 *   iTunes       403 + plain text
 *   Deezer       200 (!) with an error object in the body
 *   ReccoBeats   undocumented, modeled as 429
 *
 * The Deezer case is the one worth staring at: a client that branches on
 * res.ok caches a quota error as if it were a track.
 */

/** @returns a fresh, mutable copy of the default profiles. */
export function defaultProviders() {
  return {
    musicbrainz: {
      label: "MusicBrainz",
      prefix: "/musicbrainz",
      hosts: ["musicbrainz.org", "www.musicbrainz.org"],
      // Slow: heavy relational includes, community hardware.
      latency: {
        min: 90,
        p50: 400,
        p95: 1200,
        p99: 2500,
        tailMultiplier: 3,
        jitter: 0.12,
      },
      // 1 req/s, GLOBAL PER IP. This is the binding constraint on the whole
      // product (PLAN.md section 3) and the reason the mock enforces it rather
      // than merely reporting it.
      rateLimit: {
        limit: 1,
        windowMs: 1000,
        keyBy: "global",
        status: 503,
        sendRetryAfter: false,
        headerStyle: "musicbrainz",
        headersAlways: true,
      },
      // MusicBrainz rejects requests without a descriptive User-Agent. Enforced
      // because forgetting it is a silent 403 in production, and a load test
      // that never sends one would never catch it.
      requireUserAgent: /.+\/.+ \(.+\)/,
      faults: emptyFaults(),
    },

    listenbrainz: {
      label: "ListenBrainz",
      prefix: "/listenbrainz",
      hosts: ["api.listenbrainz.org", "labs.api.listenbrainz.org"],
      latency: {
        min: 60,
        p50: 180,
        p95: 700,
        p99: 1800,
        tailMultiplier: 3,
        jitter: 0.15,
      },
      // 30 requests / 10s, per token. keyBy token so a per-user fan-out is
      // modeled correctly: 200 users do NOT share one bucket here.
      rateLimit: {
        limit: 30,
        windowMs: 10_000,
        keyBy: "token",
        status: 429,
        sendRetryAfter: true,
        headerStyle: "listenbrainz",
        headersAlways: true,
      },
      faults: emptyFaults(),
    },

    lastfm: {
      label: "Last.fm",
      prefix: "/lastfm",
      hosts: ["ws.audioscrobbler.com"],
      latency: {
        min: 70,
        p50: 250,
        p95: 900,
        p99: 2000,
        tailMultiplier: 3.5,
        jitter: 0.15,
      },
      // Undocumented, widely reported as roughly 5/s per API key. Every user
      // shares one key, so this is effectively a global ceiling for us.
      rateLimit: {
        limit: 5,
        windowMs: 1000,
        keyBy: "apiKey",
        status: 429,
        sendRetryAfter: true,
        headerStyle: "none",
        headersAlways: false,
      },
      faults: emptyFaults(),
    },

    itunes: {
      label: "iTunes Search",
      prefix: "/itunes",
      hosts: ["itunes.apple.com"],
      // Apple is consistently quick, which is exactly why it is tempting to put
      // on the hot path. The quota below is the reason not to.
      latency: {
        min: 90,
        p50: 270,
        p95: 600,
        p99: 1200,
        tailMultiplier: 2.5,
        jitter: 0.1,
      },
      rateLimit: {
        limit: 20,
        windowMs: 60_000,
        keyBy: "global",
        status: 403,
        sendRetryAfter: false,
        headerStyle: "none",
        headersAlways: false,
        bodyShape: "text",
      },
      faults: emptyFaults(),
    },

    deezer: {
      label: "Deezer",
      prefix: "/deezer",
      hosts: ["api.deezer.com"],
      latency: {
        min: 40,
        p50: 120,
        p95: 350,
        p99: 800,
        tailMultiplier: 3,
        jitter: 0.12,
      },
      rateLimit: {
        limit: 50,
        windowMs: 5000,
        keyBy: "global",
        // Deezer answers 200 with an error envelope. Modeled deliberately.
        status: 200,
        sendRetryAfter: false,
        headerStyle: "none",
        headersAlways: false,
      },
      faults: emptyFaults(),
    },

    reccobeats: {
      label: "ReccoBeats",
      prefix: "/reccobeats",
      hosts: ["api.reccobeats.com"],
      // No SLA, anonymous operator: modeled with a fat tail on purpose so the
      // circuit breaker around it gets exercised.
      latency: {
        min: 80,
        p50: 200,
        p95: 800,
        p99: 2500,
        tailMultiplier: 4,
        jitter: 0.2,
      },
      rateLimit: {
        limit: 20,
        windowMs: 1000,
        keyBy: "global",
        status: 429,
        sendRetryAfter: true,
        headerStyle: "generic",
        headersAlways: false,
      },
      faults: emptyFaults(),
    },
  };
}

/**
 * force: null | '429' | '500' | 'timeout' | 'down'
 *   Applies to 100% of requests. This is the lever Gate 7 pulls: "each upstream
 *   forced to 429/500/timeout in turn".
 * errorRate / timeoutRate / rateLimitRate: 0..1 probabilistic injection, for
 *   background noise during long runs rather than a directed experiment.
 * latencyMultiplier: brownout without hard failure, the failure mode that
 *   actually exhausts connection pools.
 */
function emptyFaults() {
  return {
    force: null,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    latencyMultiplier: 1,
  };
}

export const SERVER_DEFAULTS = {
  port: Number(process.env.MOCK_PORT ?? 8787),
  host: process.env.MOCK_HOST ?? "127.0.0.1",
  // Deezer preview URL lifetime. Short on purpose: a 5 minute expiry surfaces
  // a wrongly cached preview URL inside a single load run instead of a day
  // later in production.
  previewTtlSeconds: Number(process.env.MOCK_PREVIEW_TTL ?? 300),
  // Signing key for mock Deezer URLs. Not a secret: it protects nothing, it
  // only makes forged or stale URLs detectable. Never used for real traffic.
  previewSigningKey:
    process.env.MOCK_PREVIEW_KEY ?? "pullfm-mock-preview-key-not-a-secret",
  verbose: process.env.MOCK_VERBOSE === "1",
};
