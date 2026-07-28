/**
 * A FAKE BFF. NOT a reference implementation. NOT the real service.
 *
 * WHY IT EXISTS
 * -------------
 * apps/bff does not exist yet, so without this the load suite could only be
 * checked for syntax. That is not enough: the parts of a load harness that
 * break are the metric wiring, the threshold expressions, the summary export
 * and the chaos choreography, and none of those can be verified without
 * something answering on the other end.
 *
 * It implements just enough of PLAN.md section 6 to exercise the harness:
 * an in-memory cache that produces a realistic warm hit ratio, upstream calls
 * on miss, a crude circuit breaker so injected chaos degrades instead of
 * failing, RFC 9457 errors, and an x-cache header.
 *
 * GUARDRAILS, because a stub that can be mistaken for the real thing is worse
 * than no stub:
 *   - it only runs behind the explicit --bff-stub flag
 *   - every response carries x-pullfm-stub: 1
 *   - lib/http.js sees that header and marks the k6 summary gate_valid=false,
 *     so a gate record can never be produced from a stub run
 */
import {
  artistFor,
  recordingFor,
  recordingMbid,
  fnv1a,
  mulberry32,
} from "../lib/catalog.js";

const V1 = "/v1";
const OWNED = ["/healthz", "/readyz", "/metrics", V1];

/** TTLs chosen so a steady-state run settles above the 90% warm-cache gate
 *  while a cold run (fresh MBID space) still misses on essentially everything. */
const TTL_MS = {
  feed: 60_000,
  preview: 600_000,
  artist: 600_000,
  search: 120_000,
};

/** Upstream call budget. Short on purpose: a feed section that cannot be
 *  resolved inside this window is dropped and the section is marked degraded,
 *  which is the Gate 7 behavior under test. */
const UPSTREAM_BUDGET_MS = 400;

export function attachBffStub({ publicBase }) {
  const cache = new Map();
  const wishlists = new Map();
  const breakers = new Map();

  const now = () => Date.now();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < now()) {
      cache.delete(key);
      return null;
    }
    return hit.value;
  }

  function cacheSet(key, value, ttl) {
    // Bounded so a 4 hour soak against the stub does not turn into a memory
    // leak that gets misread as a leak in the system under test.
    if (cache.size > 50_000) {
      for (const k of cache.keys()) {
        cache.delete(k);
        if (cache.size <= 40_000) break;
      }
    }
    cache.set(key, { value, expiresAt: now() + ttl });
    return value;
  }

  function breakerOpen(provider) {
    const b = breakers.get(provider);
    return Boolean(b && b.openUntil > now());
  }

  function breakerRecord(provider, ok) {
    const b = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
    if (ok) {
      b.failures = 0;
      b.openUntil = 0;
    } else {
      b.failures += 1;
      // Five consecutive failures opens for 5 seconds. Crude, but it produces
      // the shape Gate 7 measures: fast degradation, recovery well inside 60s.
      if (b.failures >= 5) b.openUntil = now() + 5_000;
    }
    breakers.set(provider, b);
  }

  async function callUpstream(provider, path) {
    if (breakerOpen(provider)) return { ok: false, reason: "circuit-open" };
    try {
      const res = await fetch(`${publicBase()}/${provider}${path}`, {
        signal: AbortSignal.timeout(UPSTREAM_BUDGET_MS),
        headers: {
          // MusicBrainz refuses anything else, and the mock enforces it.
          "user-agent": "PullFM-Stub/0.0.0 (ops@312.dev)",
          authorization: "Token mock-listenbrainz-token",
        },
      });
      if (!res.ok) {
        breakerRecord(provider, false);
        return { ok: false, reason: `status-${res.status}` };
      }
      const body = await res.json();
      // Deezer answers 200 with an error object. Treating that as success is
      // the exact bug the mock is built to expose, so the stub checks for it.
      if (body && body.error && provider === "deezer") {
        breakerRecord(provider, false);
        return { ok: false, reason: "deezer-error-envelope" };
      }
      breakerRecord(provider, true);
      return { ok: true, body };
    } catch (err) {
      breakerRecord(provider, false);
      return {
        ok: false,
        reason: err.name === "TimeoutError" ? "timeout" : "transport",
      };
    }
  }

  function subjectOf(req) {
    return req.headers["x-load-test-user"] ?? "anonymous";
  }

  function reply(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "x-pullfm-stub": "1",
      ...extraHeaders,
    });
    res.end(payload);
  }

  /** RFC 9457 problem+json, which PLAN.md section 6 requires everywhere. */
  function problem(res, status, title, detail) {
    const body = JSON.stringify({
      type: `https://pull.fm/problems/${title}`,
      title,
      status,
      detail,
    });
    res.writeHead(status, {
      "content-type": "application/problem+json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "x-pullfm-stub": "1",
    });
    res.end(body);
  }

  async function handleFeed(req, res, url) {
    const subject = subjectOf(req);
    const key = `feed:${subject}:${url.searchParams.get("cursor") ?? ""}`;
    const cached = cacheGet(key);
    if (cached) return reply(res, 200, cached, { "x-cache": "HIT" });

    const rnd = mulberry32(fnv1a(key));
    const sections = [];
    const degraded = [];

    // One locally derived section (always available, mirrors "cache first")
    sections.push({
      kind: "continue_listening",
      title: "Pick up where you left off",
      degraded: false,
      items: itemsFor(rnd, 12),
    });

    // One upstream derived section, which is what degrades under chaos.
    const rec = await callUpstream(
      "listenbrainz",
      `/1/cf/recommendation/user/${encodeURIComponent(subject)}/recording?count=20`,
    );
    if (rec.ok) {
      sections.push({
        kind: "recommended_for_you",
        title: "Recommended for you",
        degraded: false,
        items: (rec.body.payload?.mbids ?? [])
          .slice(0, 20)
          .map((m) => itemFor(m.recording_mbid)),
      });
    } else {
      degraded.push({ section: "recommended_for_you", reason: rec.reason });
    }

    const body = {
      sections,
      cursor: null,
      // Gate 7 asks for 200 with DEGRADED sections, not 200 with silence. The
      // client has to be able to tell the difference.
      degraded,
    };
    cacheSet(key, body, TTL_MS.feed);
    return reply(res, 200, body, { "x-cache": "MISS" });
  }

  async function handlePreview(req, res, mbid) {
    const key = `preview:${mbid}`;
    const cached = cacheGet(key);
    if (cached) return reply(res, 200, cached, { "x-cache": "HIT" });

    const r = recordingFor(mbid);
    const lookup = await callUpstream(
      "itunes",
      `/lookup?id=${r.itunesTrackId}&entity=song`,
    );
    if (!lookup.ok) {
      // Degrade rather than fail: the contract is a 200 with no preview, not a
      // 502. A 502 here would fail the Gate 7 error budget on its own.
      const body = {
        mbid,
        previewUrl: null,
        provider: null,
        degraded: true,
        reason: lookup.reason,
      };
      return reply(res, 200, body, { "x-cache": "MISS" });
    }
    const result = lookup.body.results?.[0];
    const body = {
      mbid,
      title: r.title,
      artist: r.artist.name,
      previewUrl: result?.previewUrl ?? null,
      provider: "itunes",
      // Apple preview URLs are unsigned and stable, so caching the URL is
      // allowed. The Deezer path deliberately does not cache (see PLAN 1a.4).
      degraded: false,
    };
    cacheSet(key, body, TTL_MS.preview);
    return reply(res, 200, body, { "x-cache": "MISS" });
  }

  async function handleArtist(req, res, mbid) {
    const key = `artist:${mbid}`;
    const cached = cacheGet(key);
    if (cached) return reply(res, 200, cached, { "x-cache": "HIT" });
    const upstream = await callUpstream(
      "musicbrainz",
      `/ws/2/artist/${mbid}?fmt=json`,
    );
    const a = artistFor(mbid);
    const body = {
      mbid,
      name: upstream.ok ? (upstream.body.name ?? a.name) : a.name,
      country: a.country,
      degraded: !upstream.ok,
      ...(upstream.ok ? {} : { reason: upstream.reason }),
    };
    cacheSet(key, body, TTL_MS.artist);
    return reply(res, 200, body, { "x-cache": "MISS" });
  }

  function handleSearch(req, res, url) {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return problem(res, 400, "missing-query", "q is required");
    const key = `search:${q}`;
    const cached = cacheGet(key);
    if (cached) return reply(res, 200, cached, { "x-cache": "HIT" });
    const rnd = mulberry32(fnv1a(`search:${q}`));
    const body = { query: q, results: itemsFor(rnd, 20), cursor: null };
    cacheSet(key, body, TTL_MS.search);
    return reply(res, 200, body, { "x-cache": "MISS" });
  }

  function handleWishlist(req, res, url) {
    const subject = subjectOf(req);
    const list = wishlists.get(subject) ?? [];

    if (req.method === "GET") {
      return reply(
        res,
        200,
        { items: list, cursor: null },
        { "x-cache": "BYPASS" },
      );
    }

    if (req.method === "POST") {
      const idem = req.headers["idempotency-key"];
      // PLAN.md section 6 makes Idempotency-Key mandatory on mutating calls.
      // Rejecting its absence here means the load scenario cannot quietly stop
      // sending it.
      if (!idem)
        return problem(
          res,
          400,
          "idempotency-key-required",
          "Idempotency-Key header is required",
        );
      const existing = list.find((i) => i.idempotencyKey === idem);
      if (existing)
        return reply(res, 200, existing, { "x-idempotent-replay": "1" });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          return problem(res, 400, "invalid-json", "body is not valid JSON");
        }
        const item = {
          id: `wl_${fnv1a(`${subject}:${idem}`).toString(16)}`,
          mbid: parsed.mbid ?? recordingMbid(1),
          addedAt: new Date().toISOString(),
          idempotencyKey: idem,
        };
        list.push(item);
        wishlists.set(subject, list);
        reply(res, 201, item);
      });
      return undefined;
    }

    if (req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const idx = list.findIndex((i) => i.id === id);
      if (idx === -1)
        return problem(res, 404, "not-found", `no wishlist item ${id}`);
      list.splice(idx, 1);
      wishlists.set(subject, list);
      res.writeHead(204, { "x-pullfm-stub": "1" });
      return res.end();
    }

    return problem(res, 405, "method-not-allowed", `${req.method} not allowed`);
  }

  function itemFor(mbid) {
    const r = recordingFor(mbid);
    return {
      mbid: r.mbid,
      title: r.title,
      artist: { mbid: r.artist.mbid, name: r.artist.name },
      release: r.releaseTitle,
      year: r.year,
    };
  }

  function itemsFor(rnd, n) {
    const out = [];
    for (let i = 0; i < n; i++)
      out.push(itemFor(recordingMbid(Math.floor(rnd() * 2_000_000))));
    return out;
  }

  return {
    owns(pathname) {
      return OWNED.some((p) => pathname === p || pathname.startsWith(p + "/"));
    },

    handle(req, res, url) {
      const p = url.pathname;

      if (p === "/healthz")
        return reply(res, 200, { status: "ok", stub: true });
      if (p === "/readyz")
        return reply(res, 200, { status: "ready", stub: true });
      if (p === "/metrics") {
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4",
          "x-pullfm-stub": "1",
        });
        return res.end(`pullfm_stub_cache_entries ${cache.size}\n`);
      }
      if (p === `${V1}/config`) {
        return reply(
          res,
          200,
          {
            minClientVersion: "0.0.1",
            maintenance: false,
            features: { events: false, wishlist: true },
            providers: { listenbrainz: "ok", musicbrainz: "ok", itunes: "ok" },
          },
          { "x-cache": "HIT" },
        );
      }
      if (p === `${V1}/feed`) return void handleFeed(req, res, url);
      if (p === `${V1}/search`) return handleSearch(req, res, url);
      if (p.startsWith(`${V1}/wishlist`)) return handleWishlist(req, res, url);

      let m = /^\/v1\/tracks\/([0-9a-f-]{36})\/preview$/.exec(p);
      if (m) return void handlePreview(req, res, m[1]);

      m = /^\/v1\/artists\/([0-9a-f-]{36})$/.exec(p);
      if (m) return void handleArtist(req, res, m[1]);

      if (/^\/v1\/artists\/[0-9a-f-]{36}\/events$/.test(p)) {
        // PLAN.md section 1: events are disabled, 501 by decision.
        return problem(res, 501, "not-implemented", "events are disabled");
      }

      return problem(res, 404, "not-found", `no route for ${p}`);
    },
  };
}
