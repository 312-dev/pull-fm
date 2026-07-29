/**
 * The egress guard. Load it into the BFF process, not into k6.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `apps/bff/src/services/upstream.ts` says it plainly: the only seam for
 * substituting a provider is the `FetchLike` passed to `buildUpstream`, and
 * that seam is reachable from the test harness and from nowhere else. There is
 * no `MUSICBRAINZ_BASE_URL`. `load/README.md` claimed there was, and the claim
 * was never true; it was written against a fake BFF that had no upstream
 * clients in it.
 *
 * So a load run against the REAL BFF, started the normal way, resolves
 * `musicbrainz.org` through DNS and calls it. MusicBrainz permits one request
 * per second globally per IP and revokes without appeal (docs/UPSTREAM-TERMS.md).
 * The request path is architecturally supposed to `peek` rather than call out,
 * but "supposed to" is the thing under test. A safety mechanism that assumes
 * the property it is meant to be checking is decoration.
 *
 * This closes the seam from outside the application, which is the only place
 * the load suite is allowed to touch:
 *
 *     node --import ./load/safety/upstream-guard.mjs apps/bff/dist/index.js
 *
 * WHAT IT DOES
 * ------------
 *  1. Wraps `globalThis.fetch`. Every provider origin is REWRITTEN to the mock
 *     upstream server. Nothing else changes: same path, same method, same
 *     headers, same body.
 *  2. Any host that is neither a known provider nor loopback is REFUSED, with a
 *     thrown error the caller sees as a normal fetch failure. An unrecognised
 *     host is not passed through, because the interesting failure is the one
 *     nobody predicted.
 *  3. Every attempt is counted, keyed by provider and by normalised URL. That
 *     accounting is the instrument, not just the seatbelt: "how many upstream
 *     calls did 100 concurrent cold requests for one key produce" is answerable
 *     only from inside the process making them, and single-flight is a
 *     PER-PROCESS map (packages/upstream/src/single-flight.ts) that no unit test
 *     can observe under real concurrency.
 *  4. Serves the counters over HTTP on GUARD_PORT so k6, which cannot read the
 *     BFF's memory, can assert on them from a scenario.
 *
 * THE SAFE PATH IS THE DEFAULT.
 * -----------------------------
 * Loading this module is what a `load/bin/*` script does for you. Not loading
 * it is caught in the other direction: every scenario preflights
 * `GET /__guard/health` and refuses to run if the guard is not answering, so
 * forgetting it is a failed run rather than a revoked API key. The dangerous
 * path exists, because pretending it does not just means somebody edits this
 * file at 2am, but it requires `PULLFM_ALLOW_REAL_UPSTREAMS=1`, it prints a
 * banner, and it reports `safe: false` so the run is recorded as inadmissible.
 */

import http from "node:http";

const REWRITE_ENABLED = process.env["PULLFM_ALLOW_REAL_UPSTREAMS"] !== "1";
const MOCK_URL = (process.env["MOCK_URL"] ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);
const GUARD_PORT = Number(process.env["GUARD_PORT"] ?? 8788);
const GUARD_HOST = process.env["GUARD_HOST"] ?? "127.0.0.1";
const VERBOSE = process.env["GUARD_VERBOSE"] === "1";

/**
 * Real provider origin -> mock prefix.
 *
 * Derived by grepping `packages/upstream/src` for literal origins rather than
 * from documentation, because the code is what makes the call. Re-derive with:
 *
 *     grep -rhoE 'https://[a-z0-9.-]+' packages/upstream/src --include='*.ts'
 *
 * `music.apple.com` and `www.last.fm` are not API hosts; they appear in
 * generated purchase and artist links. They are listed anyway: a link the BFF
 * decides to HEAD-check one day is still egress.
 */
const PROVIDER_ROUTES = [
  ["musicbrainz.org", "musicbrainz"],
  ["api.listenbrainz.org", "listenbrainz"],
  ["labs.api.listenbrainz.org", "listenbrainz"],
  ["listenbrainz.org", "listenbrainz"],
  ["ws.audioscrobbler.com", "lastfm"],
  ["www.last.fm", "lastfm"],
  ["itunes.apple.com", "itunes"],
  ["audio-ssl.itunes.apple.com", "itunes"],
  ["is1-ssl.mzstatic.com", "itunes"],
  ["music.apple.com", "itunes"],
  ["api.deezer.com", "deezer"],
  ["cdn-preview.dzcdn.net", "deezer"],
  ["api.reccobeats.com", "reccobeats"],
  ["api.seatgeek.com", "seatgeek"],
  ["seatgeek.com", "seatgeek"],
  ["api.workos.com", "workos"],
];

const ROUTE_BY_HOST = new Map(PROVIDER_ROUTES);

/** Hosts the BFF is allowed to reach untouched: its own dependencies. */
const LOOPBACK =
  /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;

const stats = {
  startedAt: new Date().toISOString(),
  rewritten: 0,
  refused: 0,
  passedThrough: 0,
  /** provider -> count. The Gate 1 egress number, measured at the caller. */
  byProvider: Object.create(null),
  /** provider -> { url -> count }. The single-flight instrument. */
  byKey: Object.create(null),
  /** host -> count, for hosts that were refused outright. */
  refusedHosts: Object.create(null),
  /** Kept small and bounded; a ring, not a log. */
  recent: [],
};

const RECENT_MAX = 200;

function bump(obj, key) {
  obj[key] = (obj[key] ?? 0) + 1;
}

/**
 * The key an upstream call is counted under.
 *
 * Query strings are kept because that is what distinguishes one MusicBrainz
 * lookup from another, but the ordering is normalised so two callers asking for
 * the same thing with parameters in a different order are counted as one key.
 * Getting that wrong would report coalescing as broken when it is working.
 */
function normaliseKey(u) {
  const params = [...u.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `${u.pathname}${qs ? `?${qs}` : ""}`;
}

function refusalError(host) {
  return new TypeError(
    `pull.fm load guard refused egress to ${host}. ` +
      `Only mocked providers and loopback are reachable under load. ` +
      `See load/safety/upstream-guard.mjs.`,
  );
}

const realFetch = globalThis.fetch;
if (typeof realFetch !== "function") {
  throw new Error(
    "upstream-guard: global fetch is unavailable (Node 18+ required)",
  );
}

globalThis.fetch = async function guardedFetch(input, init) {
  // `input` is a string, a URL, or a Request. Only the first two are used by
  // the upstream clients today, but a Request would silently bypass a guard
  // that only handled strings, so it is handled rather than assumed away.
  const original =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input?.url === "string"
          ? input.url
          : null;

  if (original === null) return realFetch(input, init);

  let u;
  try {
    u = new URL(original);
  } catch {
    return realFetch(input, init);
  }

  const host = u.hostname.toLowerCase();

  if (LOOPBACK.test(host)) {
    stats.passedThrough++;
    return realFetch(input, init);
  }

  const provider = ROUTE_BY_HOST.get(host);

  if (provider === undefined) {
    stats.refused++;
    bump(stats.refusedHosts, host);
    pushRecent({ verdict: "refused", host, path: u.pathname });
    throw refusalError(host);
  }

  const key = normaliseKey(u);
  stats.rewritten++;
  bump(stats.byProvider, provider);
  stats.byKey[provider] ??= Object.create(null);
  bump(stats.byKey[provider], key);
  pushRecent({ verdict: "rewritten", provider, key });

  if (!REWRITE_ENABLED) {
    // The deliberate dangerous path: counted, logged, and still real.
    return realFetch(input, init);
  }

  const target = new URL(`${MOCK_URL}/${provider}${u.pathname}${u.search}`);

  if (typeof input === "string" || input instanceof URL) {
    return realFetch(target.href, init);
  }
  return realFetch(new Request(target.href, input), init);
};

function pushRecent(entry) {
  if (VERBOSE) console.error("[guard]", JSON.stringify(entry));
  stats.recent.push({ at: Date.now(), ...entry });
  if (stats.recent.length > RECENT_MAX) stats.recent.shift();
}

/**
 * Peak concurrent-fan-out evidence, derived rather than stored: for each
 * provider, the key that was fetched the most times. A working single-flight
 * plus a working cache keeps this at 1 for a key that was requested once per
 * TTL, and the coalescing scenario asserts exactly that.
 */
function hottestKeys() {
  const out = Object.create(null);
  for (const [provider, keys] of Object.entries(stats.byKey)) {
    let best = null;
    let bestN = 0;
    let distinct = 0;
    for (const [k, n] of Object.entries(keys)) {
      distinct++;
      if (n > bestN) {
        bestN = n;
        best = k;
      }
    }
    out[provider] = {
      distinctKeys: distinct,
      hottestKey: best,
      hottestCount: bestN,
    };
  }
  return out;
}

function snapshot() {
  return {
    safe: REWRITE_ENABLED,
    guard: "pull.fm upstream egress guard",
    mockUrl: MOCK_URL,
    pid: process.pid,
    ...stats,
    hottest: hottestKeys(),
    recent: undefined,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://guard.local");
  const send = (code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  };

  if (url.pathname === "/__guard/health") {
    return send(200, { ok: true, safe: REWRITE_ENABLED, mockUrl: MOCK_URL });
  }
  if (url.pathname === "/__guard/stats") {
    return send(200, snapshot());
  }
  if (url.pathname === "/__guard/recent") {
    return send(200, { recent: stats.recent });
  }
  if (url.pathname === "/__guard/reset" && req.method === "POST") {
    stats.rewritten = 0;
    stats.refused = 0;
    stats.passedThrough = 0;
    stats.byProvider = Object.create(null);
    stats.byKey = Object.create(null);
    stats.refusedHosts = Object.create(null);
    stats.recent = [];
    stats.startedAt = new Date().toISOString();
    return send(200, { ok: true });
  }
  return send(404, { error: "not_found" });
});

// `unref` so the guard never keeps the BFF alive after it decides to exit. A
// load harness that turns a clean shutdown into a hang is its own outage.
server.listen(GUARD_PORT, GUARD_HOST, () => {
  server.unref();
  const banner = REWRITE_ENABLED
    ? `[guard] active: provider egress -> ${MOCK_URL}, stats on http://${GUARD_HOST}:${GUARD_PORT}/__guard/stats`
    : `[guard] *** PULLFM_ALLOW_REAL_UPSTREAMS=1: REAL PROVIDER TRAFFIC IS ENABLED. ***\n` +
      `[guard] *** MusicBrainz allows 1 req/s globally per IP and revokes without appeal. ***\n` +
      `[guard] *** Any run made in this state is not admissible as gate evidence. ***`;
  console.error(banner);
});

server.on("error", (err) => {
  // Refusing to start silently would leave the fetch wrapper installed but
  // unobservable, and every scenario preflight would then abort. Say why.
  console.error(
    `[guard] could not bind ${GUARD_HOST}:${GUARD_PORT}: ${err.message}. ` +
      `Egress is still guarded; only the stats endpoint is unavailable.`,
  );
});
