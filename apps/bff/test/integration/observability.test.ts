/**
 * `/metrics` and maintenance mode, against a real application.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TWO ARE IN THE SAME FILE
 *
 * Because Gate 6's claim is about both at once. "Maintenance flag -> 100% of
 * requests 503 within 60 seconds; cleared -> 100% 200 within 60 seconds" is an
 * assertion nobody can check after the fact unless the flip is observable, and
 * the thing that makes it observable is `/metrics` staying up while everything
 * else is refusing. A maintenance mode that also blanks the dashboard removes
 * the evidence for its own correct operation.
 *
 * docs/RUNBOOK-INCIDENT.md section 10 records that this project has twice
 * shipped a control that looked configured and was absent. Every assertion
 * below reads the real behaviour of a real route rather than the setting that
 * is supposed to produce it.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

/** Parses one sample out of an exposition body. */
function sample(body: string, name: string, labels = ""): number | null {
  const needle = labels === "" ? name : `${name}{${labels}}`;
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) continue;
    const idx = line.lastIndexOf(" ");
    if (idx < 0) continue;
    if (line.slice(0, idx) === needle) return Number(line.slice(idx + 1));
  }
  return null;
}

async function scrape(app: TestApp): Promise<string> {
  const res = await app.app.inject({ method: "GET", url: "/metrics" });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe("GET /metrics", () => {
  test("serves the Prometheus exposition content type", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("version=0.0.4");
  });

  test("is no longer a three-line stub", async () => {
    // The route existed before this phase and returned only build_info. The
    // assertion is deliberately about SUBSTANCE, because "the endpoint returns
    // 200" was already true while it observed nothing.
    const body = await scrape(ctx);
    expect(body.split("\n").length).toBeGreaterThan(30);
    expect(body).toContain("pullfm_build_info");
  });

  test("reports the database pool, including the number waiting", async () => {
    // Gate 7 asserts "no pool exhaustion" under a failure-injection matrix.
    // `waiting` is the only one of these that can prove it: total and idle can
    // both look comfortable while every caller is queueing.
    const body = await scrape(ctx);
    expect(
      sample(body, "pullfm_db_pool_connections", 'state="total"'),
    ).not.toBeNull();
    expect(
      sample(body, "pullfm_db_pool_connections", 'state="idle"'),
    ).not.toBeNull();
    expect(sample(body, "pullfm_db_pool_waiting")).not.toBeNull();
    expect(sample(body, "pullfm_db_pool_max")).toBeGreaterThan(0);
  });

  test("reports per-provider cache counters and hit ratio", async () => {
    // Gate 2's warm-cache requirement is >=90%, so this is the series the gate
    // is measured on.
    const body = await scrape(ctx);
    expect(body).toContain('pullfm_cache_hits_total{provider="musicbrainz"}');
    expect(body).toContain('pullfm_cache_misses_total{provider="lastfm"}');
    expect(body).toContain('pullfm_cache_hit_ratio{provider="itunes"}');
  });

  test("distinguishes an untouched cache from a cache that never hits", async () => {
    // -1, not 0. A dashboard whose job is to tell "nothing happened" from "90%
    // of lookups missed" must not render both as the same number.
    const body = await scrape(ctx);
    const ratio = sample(
      body,
      "pullfm_cache_hit_ratio",
      'provider="reccobeats"',
    );
    expect(ratio).toBe(-1);
  });

  test("reports the MusicBrainz pacer, which is the U1 evidence", async () => {
    // MusicBrainz is one request per second across the whole service and has no
    // second supplier. Until now these counters existed and were unreachable.
    const body = await scrape(ctx);
    expect(
      sample(body, "pullfm_musicbrainz_pacer_dispatched_total"),
    ).not.toBeNull();
    expect(
      sample(body, "pullfm_musicbrainz_pacer_rejected_total"),
    ).not.toBeNull();
    expect(sample(body, "pullfm_musicbrainz_pacer_queue_depth")).not.toBeNull();
  });

  test("reports per-provider status and how long it has held it", async () => {
    // U4 is "breaker open for over 15 minutes", so the age is the alertable
    // half; the state alone cannot answer it.
    const body = await scrape(ctx);
    expect(
      sample(body, "pullfm_upstream_provider_status", 'provider="musicbrainz"'),
    ).not.toBeNull();
    expect(
      sample(
        body,
        "pullfm_upstream_provider_status_age_seconds",
        'provider="musicbrainz"',
      ),
    ).not.toBeNull();
  });

  test("counts HTTP responses by route TEMPLATE, never by concrete path", async () => {
    // A metric labelled with a real id is one time series per id, which is how
    // a metrics endpoint becomes the outage it was added to detect.
    await ctx.app.inject({ method: "GET", url: "/v1/config" });
    const body = await scrape(ctx);
    expect(
      sample(
        body,
        "pullfm_http_requests_total",
        'method="GET",route="/v1/config",status="200"',
      ),
    ).toBeGreaterThan(0);
    expect(body).not.toMatch(/route="\/v1\/wishlist\/[0-9a-f-]{36}"/);
  });

  test("records request latency in a cumulative histogram", async () => {
    // A6 alerts on p95 over 800ms, and `histogram_quantile` needs cumulative
    // buckets plus a +Inf to produce a number that means anything.
    await ctx.app.inject({ method: "GET", url: "/v1/config" });
    const body = await scrape(ctx);
    expect(body).toContain("pullfm_http_request_duration_seconds_bucket");
    expect(body).toContain('le="0.8"');
    expect(body).toContain('le="+Inf"');
  });

  test("reports the readiness verdicts the last /readyz probe produced", async () => {
    // One probe, two readers. A second independent set of dependency checks
    // behind /metrics is how a service ends up with a readiness endpoint and a
    // dashboard that disagree about whether Redis is up.
    const ready = await ctx.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    const body = await scrape(ctx);
    expect(sample(body, "pullfm_dependency_up", 'dependency="database"')).toBe(
      1,
    );
    expect(sample(body, "pullfm_dependency_up", 'dependency="redis"')).toBe(1);
  });

  test("the committed scrape fixture still matches what this build emits", async () => {
    // infra/observability/testdata/metrics-sample.txt drives the watchdog
    // self-test, and the watchdog is a shell script that greps for these names.
    // If a series is renamed here and the fixture is not regenerated, the
    // self-test keeps passing against a scrape nothing produces any more, and
    // the alert it proves has quietly stopped existing.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const root = path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const fixture = fs.readFileSync(
      path.join(root, "infra/observability/testdata/metrics-sample.txt"),
      "utf8",
    );

    const names = (body: string): string[] =>
      [...body.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1] ?? "").sort();

    const live = names(await scrape(ctx));
    const captured = names(fixture);

    expect(
      captured.filter((n) => !live.includes(n)),
      "the fixture names series this build no longer emits; regenerate it",
    ).toEqual([]);
    expect(
      live.filter((n) => !captured.includes(n) && !n.includes("_total")),
      "this build emits gauges the fixture does not; regenerate it",
    ).toEqual([]);
  });

  test("exposes no credential, connection string or token", async () => {
    // The endpoint is reconnaissance by nature. It must stay reconnaissance and
    // never become disclosure.
    const body = await scrape(ctx);
    expect(body).not.toMatch(
      /postgres:\/\/|redis:\/\/|sk_|pfm_(live|test)_|password/i,
    );
  });
});

describe("maintenance mode", () => {
  let down: TestApp;

  beforeAll(async () => {
    down = await buildTestApp({ maintenanceMode: true });
  }, 60_000);

  afterAll(async () => {
    await down.close();
  });

  test("every application route answers 503 with Retry-After", async () => {
    // "100% of requests" is the gate's wording, so the assertion enumerates the
    // ROUTER rather than a hand-written list. A route added later that forgets
    // to be covered by maintenance mode fails this test on the day it lands.
    const routes = down.routes.filter(
      (r) =>
        !r.url.startsWith("/healthz") &&
        !r.url.startsWith("/readyz") &&
        !r.url.startsWith("/metrics") &&
        !r.url.startsWith("/docs") &&
        !r.url.startsWith("/openapi"),
    );
    expect(routes.length).toBeGreaterThan(5);

    for (const route of routes) {
      const url = route.url.replace(
        /:[A-Za-z]+/g,
        "00000000-0000-4000-8000-000000000000",
      );
      // `RoutedOperation.method` is a plain string because it comes from the
      // ROUTER's own view rather than from Fastify's type, which is the whole
      // reason this enumeration is trustworthy. The cast matches the one in
      // test/security/bola.test.ts, which walks the same list for the same
      // reason: inject's overloads are keyed on a literal method.
      const res = await down.app.inject({
        method: route.method as "GET",
        url,
      });
      expect(
        { url: route.url, status: res.statusCode },
        `${route.method} ${route.url} did not refuse`,
      ).toEqual({ url: route.url, status: 503 });
      expect(res.headers["retry-after"]).toBe("300");
      expect(String(res.headers["content-type"])).toContain(
        "application/problem+json",
      );
    }
  });

  test("the 503 is an honest problem document, not an error page", async () => {
    const res = await down.app.inject({ method: "GET", url: "/v1/wishlist" });
    const body = jsonOf<{ title: string; type: string; status: number }>(res);
    expect(body.status).toBe(503);
    expect(body.type).toContain("maintenance");
  });

  test("health, readiness and metrics stay up", async () => {
    // The orchestrator must be able to tell intentional downtime from a crash,
    // or it restarts a node an operator deliberately contained. And losing
    // observability during an incident is the opposite of the point.
    for (const url of ["/healthz", "/readyz", "/metrics"]) {
      const res = await down.app.inject({ method: "GET", url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  test("the flip is externally observable in /metrics and /v1/config", async () => {
    const body = await scrape(down);
    expect(sample(body, "pullfm_maintenance_mode")).toBe(1);
    expect(
      sample(body, "pullfm_maintenance_refusals_total", 'reason="env"'),
    ).toBeGreaterThan(0);

    // /v1/config is served by the same gate, so a client cannot be told
    // "available" while every other route refuses it.
    const cfg = await ctx.app.inject({ method: "GET", url: "/v1/config" });
    expect(jsonOf<{ maintenance: boolean }>(cfg).maintenance).toBe(false);
  });

  test("a healthy application reports maintenance 0 and refuses nothing", async () => {
    const body = await scrape(ctx);
    expect(sample(body, "pullfm_maintenance_mode")).toBe(0);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/config" });
    expect(res.statusCode).toBe(200);
  });
});

describe("maintenance mode, flipped without a restart", () => {
  test("a flag FILE turns it on and off in the same process", async () => {
    // This is the half a restart-based flip cannot honestly claim. Gate 6 asks
    // for "cleared -> 100% 200 within 60 seconds", and the gap between
    // container stop and container ready is connection failures rather than an
    // honest 503.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pullfm-maint-"));
    const flag = path.join(dir, "maintenance");

    const app = await buildTestApp({
      env: { MAINTENANCE_FLAG_FILE: flag, MAINTENANCE_POLL_MS: "1" },
    });
    try {
      const before = await app.app.inject({ method: "GET", url: "/v1/config" });
      expect(before.statusCode).toBe(200);

      fs.writeFileSync(flag, "");
      await new Promise((r) => setTimeout(r, 15));

      const during = await app.app.inject({ method: "GET", url: "/v1/config" });
      expect(during.statusCode).toBe(503);
      expect(during.headers["retry-after"]).toBe("300");

      const body = await scrape(app);
      expect(sample(body, "pullfm_maintenance_mode")).toBe(1);
      expect(
        sample(body, "pullfm_maintenance_refusals_total", 'reason="file"'),
      ).toBeGreaterThan(0);

      fs.rmSync(flag);
      await new Promise((r) => setTimeout(r, 15));

      const after = await app.app.inject({ method: "GET", url: "/v1/config" });
      expect(after.statusCode).toBe(200);
      expect(sample(await scrape(app), "pullfm_maintenance_mode")).toBe(0);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
