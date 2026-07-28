#!/usr/bin/env node
/**
 * Pull.fm mock upstream server.
 *
 * WHY THIS EXISTS
 * ---------------
 * PLAN.md section 8: load tests run exclusively against mocked upstreams,
 * because the original Gate 7 (a cold-cache run at 50k-equivalent load against
 * real providers) would have burned our MusicBrainz and Last.fm access before
 * launch. MusicBrainz allows 1 req/s globally and Last.fm revokes without
 * appeal. A single 30 minute load run against the real thing is a product
 * ending event.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   1. It makes ZERO outbound network connections. There is no proxy path, no
 *      fallback to a real provider, no "record and replay" mode. Grep the
 *      imports: node:http, node:crypto, and local files. That is the whole
 *      dependency list. Nothing here can leak to a real API even if
 *      misconfigured.
 *   2. It enforces each provider's real quota rather than reporting it, so a
 *      BFF that exceeds MusicBrainz's 1 req/s gets refused here exactly as it
 *      would in production.
 *   3. It reproduces each provider's latency profile, refusal shape, and error
 *      body. See config.js and lib/respond.js for the per-provider details and
 *      which values are verified versus modeled.
 *
 * USAGE
 *   node load/mock-upstreams/server.js
 *   node load/mock-upstreams/server.js --bff-stub     also serve a fake BFF
 *
 * Point the BFF's provider base URLs at:
 *   MUSICBRAINZ_BASE_URL=http://127.0.0.1:8787/musicbrainz
 *   LISTENBRAINZ_BASE_URL=http://127.0.0.1:8787/listenbrainz
 *   LASTFM_BASE_URL=http://127.0.0.1:8787/lastfm
 *   ITUNES_BASE_URL=http://127.0.0.1:8787/itunes
 *   DEEZER_BASE_URL=http://127.0.0.1:8787/deezer
 *   RECCOBEATS_BASE_URL=http://127.0.0.1:8787/reccobeats
 *
 * Host-header routing also works (Host: musicbrainz.org), for the case where
 * the BFF's URLs cannot be overridden and /etc/hosts is used instead.
 */
import http from "node:http";

import { defaultProviders, SERVER_DEFAULTS } from "./config.js";
import { RateLimiter, bucketKeyFor } from "./lib/ratelimit.js";
import { ProviderStats } from "./lib/stats.js";
import { sampleLatency } from "./lib/latency.js";
import {
  rateLimitHeaders,
  rateLimitBody,
  serverErrorBody,
  send,
} from "./lib/respond.js";
import { musicbrainz } from "./providers/musicbrainz.js";
import { listenbrainz } from "./providers/listenbrainz.js";
import { lastfm } from "./providers/lastfm.js";
import { itunes } from "./providers/itunes.js";
import { deezer } from "./providers/deezer.js";
import { reccobeats } from "./providers/reccobeats.js";
import { attachBffStub } from "./bff-stub.js";

const HANDLERS = {
  musicbrainz,
  listenbrainz,
  lastfm,
  itunes,
  deezer,
  reccobeats,
};

/** How long a forced-timeout request is held open before the socket is
 *  destroyed. Long enough to trip any sane client timeout, short enough that a
 *  4 hour soak does not accumulate sockets. */
const HANG_MS = Number(process.env.MOCK_HANG_MS ?? 120_000);

const state = {
  startedAt: Date.now(),
  providers: defaultProviders(),
  stats: Object.fromEntries(
    Object.keys(HANDLERS).map((k) => [k, new ProviderStats()]),
  ),
  limiter: new RateLimiter(),
  /** Free-form marker set by the chaos scenario so the server log and the k6
   *  timeline can be lined up after the fact. */
  label: "idle",
  openHangs: new Set(),
};

const options = {
  ...SERVER_DEFAULTS,
  bffStub:
    process.argv.includes("--bff-stub") || process.env.MOCK_BFF_STUB === "1",
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function resolveProvider(req, url) {
  for (const [name, cfg] of Object.entries(state.providers)) {
    if (
      url.pathname === cfg.prefix ||
      url.pathname.startsWith(cfg.prefix + "/")
    ) {
      return {
        name,
        cfg,
        pathname: url.pathname.slice(cfg.prefix.length) || "/",
      };
    }
  }
  // Host-header fallback, for /etc/hosts style redirection of a BFF whose
  // provider URLs are not configurable.
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  for (const [name, cfg] of Object.entries(state.providers)) {
    if (cfg.hosts.includes(host)) return { name, cfg, pathname: url.pathname };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "mock"}`);

  if (url.pathname.startsWith("/__admin")) return handleAdmin(req, res, url);
  if (options.bffStub && stub && stub.owns(url.pathname))
    return stub.handle(req, res, url);

  const match = resolveProvider(req, url);
  if (!match) {
    return send(res, {
      status: 404,
      body: {
        error: "unknown provider prefix",
        hint:
          "use one of " +
          Object.values(state.providers)
            .map((p) => p.prefix)
            .join(", "),
      },
    });
  }
  handleProvider(req, res, url, match);
});

// ---------------------------------------------------------------------------
// Provider pipeline: quota -> faults -> latency -> handler
// ---------------------------------------------------------------------------

function handleProvider(req, res, url, { name, cfg, pathname }) {
  const now = Date.now();
  const stats = state.stats[name];
  const faults = cfg.faults;

  // Traffic under /cdn/ is edge traffic (preview audio), not API traffic. Real
  // CDNs are not governed by the API quota and are fast, so counting them
  // against the API limiter would make the quota assertions meaningless.
  const isCdn = pathname.startsWith("/cdn/");

  stats.recordRequest(now);

  // MusicBrainz refuses anonymous clients. Checked before anything else
  // because a missing User-Agent is a configuration bug, not a load problem.
  if (!isCdn && cfg.requireUserAgent) {
    const ua = req.headers["user-agent"] ?? "";
    if (!cfg.requireUserAgent.test(ua)) {
      stats.bump("missingUserAgent");
      return finish(res, stats, 30, {
        status: 403,
        contentType: "text/plain; charset=utf-8",
        body: "Your requests are being blocked. Please set a meaningful User-Agent, see https://musicbrainz.org/doc/XML_Web_Service/Rate_Limiting",
      });
    }
  }

  // --- forced faults (the Gate 7 lever) ------------------------------------
  const forced = faults.force;
  if (forced === "down") {
    // Connection reset: exercises the connect-error path, which is a different
    // code path from an HTTP error in every HTTP client worth using.
    stats.bump("connectionReset");
    req.socket.destroy();
    return;
  }
  if (
    forced === "timeout" ||
    (faults.timeoutRate > 0 && Math.random() < faults.timeoutRate)
  ) {
    return hang(req, res, stats);
  }
  if (
    forced === "500" ||
    (faults.errorRate > 0 && Math.random() < faults.errorRate)
  ) {
    const body = serverErrorBody(name);
    // Real 500s are usually fast: the upstream fails before doing work. Using
    // the full latency profile here would overstate recovery time.
    return finish(
      res,
      stats,
      Math.round(sampleLatency(cfg.latency, Math.random) * 0.3),
      {
        status: 500,
        contentType: body.contentType,
        body: body.body,
      },
    );
  }

  // --- quota ---------------------------------------------------------------
  let limitInfo = null;
  if (!isCdn) {
    const key = bucketKeyFor(name, cfg.rateLimit, req, url);
    limitInfo = state.limiter.check(key, cfg.rateLimit, now);
    const forcedLimit =
      forced === "429" ||
      (faults.rateLimitRate > 0 && Math.random() < faults.rateLimitRate);
    if (!limitInfo.allowed || forcedLimit) {
      stats.rateLimited += 1;
      const shape = rateLimitBody(name, limitInfo);
      const headers = {
        ...rateLimitHeaders(cfg.rateLimit.headerStyle, {
          ...limitInfo,
          remaining: 0,
        }),
      };
      if (cfg.rateLimit.sendRetryAfter)
        headers["retry-after"] = String(limitInfo.resetInSeconds);
      // Refusals are cheap and fast at every provider: the request is rejected
      // at the edge, not after the work.
      return finish(res, stats, 15, {
        status: cfg.rateLimit.status,
        contentType: shape.contentType,
        headers,
        body: shape.body,
        isRefusal: true,
      });
    }
  }

  // --- normal path ---------------------------------------------------------
  const ctx = {
    req,
    url,
    pathname,
    query: url.searchParams,
    stats,
    publicBase: publicBaseFor(req),
    signingKey: options.previewSigningKey,
    previewTtlSeconds: options.previewTtlSeconds,
  };

  let descriptor;
  try {
    descriptor = HANDLERS[name].handle(ctx);
  } catch (err) {
    // A throw here is a bug in the mock, not a simulated upstream failure.
    // Distinguished by the header so it is never mistaken for injected chaos.
    descriptor = {
      status: 500,
      headers: { "x-pullfm-mock-error": "handler-exception" },
      body: { error: String(err && err.message) },
    };
  }

  if (limitInfo && cfg.rateLimit.headersAlways) {
    descriptor.headers = {
      ...rateLimitHeaders(cfg.rateLimit.headerStyle, limitInfo),
      ...(descriptor.headers ?? {}),
    };
  }

  // CDN responses come from an edge cache: fast and flat, not the API profile.
  const delay = isCdn
    ? 8 + Math.round(Math.random() * 20)
    : Math.round(
        sampleLatency(cfg.latency, Math.random) *
          (faults.latencyMultiplier ?? 1),
      );

  finish(res, stats, delay, descriptor);
}

function finish(res, stats, delayMs, descriptor) {
  const timer = setTimeout(() => {
    state.openHangs.delete(timer);
    if (res.writableEnded || res.destroyed) return;
    stats.recordResponse(
      descriptor.status ?? 200,
      delayMs,
      descriptor.isRefusal === true,
    );
    send(res, descriptor);
  }, delayMs);
  state.openHangs.add(timer);
  res.on("close", () => {
    if (!res.writableEnded) {
      stats.clientAborts += 1;
      clearTimeout(timer);
      state.openHangs.delete(timer);
    }
  });
}

/** Accept the request and never answer, until the client gives up or HANG_MS
 *  elapses. This is what a real upstream timeout looks like: the socket stays
 *  open and the client's own timeout is the only thing that ends it. A mock
 *  that returned 504 instantly would test a completely different code path. */
function hang(req, res, stats) {
  stats.timeouts += 1;
  const timer = setTimeout(() => {
    state.openHangs.delete(timer);
    if (!res.writableEnded) res.destroy();
  }, HANG_MS);
  state.openHangs.add(timer);
  res.on("close", () => {
    clearTimeout(timer);
    state.openHangs.delete(timer);
  });
}

function publicBaseFor(req) {
  if (process.env.MOCK_PUBLIC_URL)
    return process.env.MOCK_PUBLIC_URL.replace(/\/$/, "");
  return `http://${req.headers.host ?? `${options.host}:${options.port}`}`;
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

function handleAdmin(req, res, url) {
  const route = url.pathname.replace(/^\/__admin\/?/, "");

  if (req.method === "GET" && (route === "" || route === "health")) {
    return send(res, {
      status: 200,
      body: {
        ok: true,
        service: "pullfm-mock-upstreams",
        startedAt: new Date(state.startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
        label: state.label,
        bffStub: options.bffStub,
        providers: Object.keys(state.providers),
      },
    });
  }

  if (req.method === "GET" && route === "config") {
    return send(res, { status: 200, body: serializableConfig() });
  }

  if (req.method === "GET" && route === "stats") {
    return send(res, { status: 200, body: statsSnapshot() });
  }

  if (req.method === "POST" && route === "config") {
    return readJson(req, (err, patch) => {
      if (err) return send(res, { status: 400, body: { error: err.message } });
      if (typeof patch._label === "string") state.label = patch._label;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "_label") continue;
        const targets = key === "all" ? Object.keys(state.providers) : [key];
        for (const t of targets) {
          if (!state.providers[t]) {
            return send(res, {
              status: 400,
              body: { error: `unknown provider: ${t}` },
            });
          }
          deepMerge(state.providers[t], value);
        }
      }
      log(`config updated (label=${state.label})`);
      return send(res, { status: 200, body: serializableConfig() });
    });
  }

  if (req.method === "POST" && route === "reset") {
    const what = url.searchParams.get("what") ?? "all";
    if (what === "all" || what === "config") {
      state.providers = defaultProviders();
      state.limiter.reset();
      state.label = "idle";
    }
    if (what === "all" || what === "stats") {
      for (const s of Object.values(state.stats)) s.reset();
    }
    log(`reset (${what})`);
    return send(res, { status: 200, body: { ok: true, reset: what } });
  }

  return send(res, {
    status: 404,
    body: {
      error: "unknown admin route",
      routes: [
        "GET  /__admin/health",
        "GET  /__admin/config",
        "GET  /__admin/stats",
        'POST /__admin/config   body: { "<provider>|all": { faults|latency|rateLimit patch }, "_label": "..." }',
        "POST /__admin/reset?what=all|config|stats",
      ],
    },
  });
}

function serializableConfig() {
  const out = { _label: state.label, providers: {} };
  for (const [name, cfg] of Object.entries(state.providers)) {
    out.providers[name] = {
      label: cfg.label,
      prefix: cfg.prefix,
      latency: cfg.latency,
      rateLimit: cfg.rateLimit,
      faults: cfg.faults,
    };
  }
  return out;
}

function statsSnapshot() {
  const now = Date.now();
  const providers = {};
  for (const [name, s] of Object.entries(state.stats)) {
    s.sweep(now);
    const cfg = state.providers[name];
    providers[name] = {
      ...s.toJSON(),
      quota: {
        limit: cfg.rateLimit.limit,
        windowMs: cfg.rateLimit.windowMs,
        keyBy: cfg.rateLimit.keyBy,
        // Convenience for the k6 teardown assertions: the ceiling expressed in
        // the unit each provider's limit is actually stated in.
        allowedPerSecond: cfg.rateLimit.limit / (cfg.rateLimit.windowMs / 1000),
      },
    };
  }
  state.limiter.sweep(now);
  return {
    label: state.label,
    uptimeSeconds: Math.round((now - state.startedAt) / 1000),
    providers,
  };
}

function readJson(req, cb) {
  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 256 * 1024) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return cb(new Error("body too large"));
    try {
      cb(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      cb(new Error(`invalid JSON: ${e.message}`));
    }
  });
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      target[k] ??= {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function log(msg) {
  process.stdout.write(`[mock ${new Date().toISOString()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let stub = null;
if (options.bffStub) {
  stub = attachBffStub({
    publicBase: () => `http://${options.host}:${options.port}`,
  });
}

// Keep-alive tuned above the default 5s so k6's connection reuse is not fighting
// the mock's socket recycling, which would show up as spurious latency.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(options.port, options.host, () => {
  log(`listening on http://${options.host}:${options.port}`);
  log(
    `providers: ${Object.values(state.providers)
      .map((p) => p.prefix)
      .join(" ")}`,
  );
  log(`control plane: http://${options.host}:${options.port}/__admin/health`);
  log(
    "outbound network calls: none. this process never contacts a real provider.",
  );
  if (options.bffStub) {
    log("");
    log("  *** BFF STUB ENABLED ***");
    log(
      `  crosswalk pre-seeded with ${stub.seeded} hot-set entries (MOCK_SEED_HOT_SET)`,
    );
    log(
      "  Serving a fake /v1 API so the load suite can be exercised before the",
    );
    log(
      "  real BFF exists. Every stub response carries x-pullfm-stub: 1 and the",
    );
    log(
      "  k6 summary will be marked gate_valid=false. Never record a gate from it.",
    );
    log("");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    for (const t of state.openHangs) clearTimeout(t);
    server.close(() => process.exit(0));
    // Held-open sockets from injected timeouts would otherwise block close().
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
