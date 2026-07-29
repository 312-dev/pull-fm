import { describe, expect, it } from "vitest";

import { UpstreamError } from "./errors.js";
import { KillSwitch } from "./kill-switch.js";
import {
  ProviderClient,
  parseRetryAfter,
  redactUrl,
} from "./provider-client.js";
import { RateLimiter } from "./rate-limiter.js";
import { FakeClock, FakeHttp } from "./testing/fake-http.js";

function client(
  http: FakeHttp,
  clock: FakeClock,
  overrides: Partial<ConstructorParameters<typeof ProviderClient>[0]> = {},
) {
  return new ProviderClient({
    name: "listenbrainz",
    baseUrl: "https://example.test",
    fetch: http.fetch,
    clock,
    timeoutMs: 1000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      maxRetryAfterMs: 5000,
    },
    breaker: {
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      successThreshold: 1,
    },
    ...overrides,
  });
}

describe("redactUrl", () => {
  it("strips the query string, which is where credentials travel", () => {
    expect(redactUrl("https://api.test/2/events?client_id=abc123&q=x")).toBe(
      "https://api.test/2/events?[redacted]",
    );
  });

  it("leaves a bare path alone", () => {
    expect(redactUrl("https://api.test/2/events")).toBe(
      "https://api.test/2/events",
    );
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
  });

  it("reads an HTTP-date", () => {
    const now = Date.parse("2026-07-28T12:00:00Z");
    expect(parseRetryAfter("Tue, 28 Jul 2026 12:00:10 GMT", now)).toBe(10_000);
  });

  it("returns undefined for junk rather than guessing", () => {
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});

describe("ProviderClient success path", () => {
  it("parses JSON and sends the configured headers", async () => {
    const http = new FakeHttp().enqueue({ body: { ok: true } });
    const c = client(http, new FakeClock(), {
      headers: { "User-Agent": "PullFM/0.1.0 (ope@312.dev)" },
    });
    const payload = await c.requestJson({ path: "/thing", query: { a: "1" } });
    expect(payload).toEqual({ ok: true });
    expect(http.lastRequest?.url).toBe("https://example.test/thing?a=1");
    expect(http.lastRequest?.headers["User-Agent"]).toBe(
      "PullFM/0.1.0 (ope@312.dev)",
    );
  });

  it("omits undefined query parameters instead of sending 'undefined'", async () => {
    const http = new FakeHttp().enqueue({ body: {} });
    await client(http, new FakeClock()).requestJson({
      path: "/thing",
      query: { a: "1", b: undefined },
    });
    expect(http.lastRequest?.url).toBe("https://example.test/thing?a=1");
  });
});

describe("ProviderClient failure paths", () => {
  it("retries a 500 and succeeds", async () => {
    const http = new FakeHttp()
      .enqueue({ status: 500, body: { error: "boom" } })
      .enqueue({ body: { ok: 1 } });
    const clock = new FakeClock();
    const payload = await client(http, clock).requestJson({ path: "/x" });
    expect(payload).toEqual({ ok: 1 });
    expect(http.callCount).toBe(2);
    expect(clock.sleeps).toHaveLength(1);
  });

  it("honours Retry-After on a 429", async () => {
    const http = new FakeHttp()
      .enqueue({ status: 429, headers: { "retry-after": "2" } })
      .enqueue({ body: { ok: 1 } });
    const clock = new FakeClock(1_700_000_000_000, 0);
    await client(http, clock).requestJson({ path: "/x" });
    // 2000ms from the header, plus jitter of floor(random * 100) = 0.
    expect(clock.sleeps).toEqual([2000]);
  });

  it("fails fast when Retry-After exceeds what we are willing to wait", async () => {
    const http = new FakeHttp().always({
      status: 429,
      headers: { "retry-after": "600" },
    });
    const clock = new FakeClock();
    const err = await client(http, clock)
      .requestJson({ path: "/x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).kind).toBe("rate_limited");
    expect((err as UpstreamError).retryAfterMs).toBe(600_000);
    // One attempt only: waiting ten minutes inside a request is not a retry.
    expect(http.callCount).toBe(1);
    expect(clock.sleeps).toHaveLength(0);
  });

  it("classifies a timeout and does not confuse it with a network error", async () => {
    const http = new FakeHttp().always({ hang: true });
    const clock = new FakeClock();
    const err = await client(http, clock, {
      timeoutMs: 5,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxRetryAfterMs: 1,
      },
    })
      .requestJson({ path: "/slow" })
      .catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("timeout");
  });

  it("reports a socket failure as network", async () => {
    const http = new FakeHttp().always({ networkError: "ECONNRESET" });
    const err = await client(http, new FakeClock())
      .requestJson({ path: "/x" })
      .catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("network");
  });

  it("reports unparseable JSON as malformed, not as a server error", async () => {
    const http = new FakeHttp().enqueue({ body: "{not json" });
    const err = await client(http, new FakeClock())
      .requestJson({ path: "/x" })
      .catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("malformed");
    // Malformed is our bug, so it must not be retried.
    expect(http.callCount).toBe(1);
  });

  it("does not retry a 404 and does not blame the provider for it", async () => {
    const http = new FakeHttp().always({ status: 404, body: {} });
    const c = client(http, new FakeClock());
    for (let i = 0; i < 5; i++) {
      await c.requestJson({ path: "/missing" }).catch(() => null);
    }
    expect(http.callCount).toBe(5);
    // A catalogue gap must never open the circuit.
    expect(c.breaker.snapshot().state).toBe("closed");
  });

  it("treats an emptyStatus as no data", async () => {
    const http = new FakeHttp().enqueue({ status: 404, body: { e: 1 } });
    const payload = await client(http, new FakeClock()).requestJson({
      path: "/maybe",
      emptyStatuses: [404],
    });
    expect(payload).toBeNull();
  });

  it("returns the body for an acceptStatus, since that is where the code is", async () => {
    // Last.fm puts `{ error: 10 }` in a 403 body and SeatGeek puts 40302/40307
    // there. Throwing on the status would discard the actionable half.
    const http = new FakeHttp().enqueue({ status: 403, body: { code: 40302 } });
    const payload = await client(http, new FakeClock()).requestJson({
      path: "/guarded",
      acceptStatuses: [403],
    });
    expect(payload).toEqual({ code: 40302 });
  });
});

describe("ProviderClient circuit breaker", () => {
  it("opens after repeated failures, then recovers", async () => {
    const http = new FakeHttp().always({ status: 503, body: {} });
    const clock = new FakeClock();
    const c = client(http, clock, {
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxRetryAfterMs: 1,
      },
      breaker: {
        failureThreshold: 3,
        resetTimeoutMs: 10_000,
        successThreshold: 1,
      },
    });

    for (let i = 0; i < 3; i++) {
      await c.requestJson({ path: "/x" }).catch(() => null);
    }
    expect(c.breaker.snapshot().state).toBe("open");

    const callsBefore = http.callCount;
    const err = await c.requestJson({ path: "/x" }).catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("circuit_open");
    // Short-circuited: no request left the process.
    expect(http.callCount).toBe(callsBefore);

    clock.advance(10_001);
    http.reset();
    http.always({ body: { ok: 1 } });
    const payload = await c.requestJson({ path: "/x" });
    expect(payload).toEqual({ ok: 1 });
    expect(c.breaker.snapshot().state).toBe("closed");
  });
});

describe("ProviderClient quota", () => {
  it("refuses locally once the budget is spent", async () => {
    const http = new FakeHttp().always({ body: {} });
    const clock = new FakeClock();
    const c = client(http, clock, { quota: { limit: 2, windowMs: 60_000 } });

    await c.requestJson({ path: "/a" });
    await c.requestJson({ path: "/b" });
    const err = await c.requestJson({ path: "/c" }).catch((e: unknown) => e);

    expect((err as UpstreamError).kind).toBe("quota_exhausted");
    expect(http.callCount).toBe(2);
    // Spending our own budget is not evidence the provider is unwell.
    expect(c.breaker.snapshot().state).toBe("closed");
  });

  it("frees budget as the window slides", async () => {
    const http = new FakeHttp().always({ body: {} });
    const clock = new FakeClock();
    const c = client(http, clock, { quota: { limit: 1, windowMs: 1000 } });
    await c.requestJson({ path: "/a" });
    await expect(c.requestJson({ path: "/b" })).rejects.toThrow();
    clock.advance(1001);
    await expect(c.requestJson({ path: "/c" })).resolves.toBeDefined();
  });
});

describe("ProviderClient kill switch", () => {
  it("refuses without touching the network or the quota", async () => {
    const http = new FakeHttp().always({ body: {} });
    const killSwitch = new KillSwitch();
    killSwitch.disable("listenbrainz", "operator: provider terms review");
    const c = client(http, new FakeClock(), {
      killSwitch,
      quota: { limit: 5, windowMs: 1000 },
    });

    const err = await c.requestJson({ path: "/x" }).catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("disabled");
    expect((err as UpstreamError).message).toContain("terms review");
    expect(http.callCount).toBe(0);
    expect(c.quota?.snapshot().used).toBe(0);
    expect(c.status()).toBe("disabled");

    killSwitch.enable("listenbrainz");
    await expect(c.requestJson({ path: "/x" })).resolves.toBeDefined();
  });
});

describe("ProviderClient rate limiter", () => {
  it("routes every attempt through the shared limiter", async () => {
    const http = new FakeHttp().always({ body: {} });
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      minIntervalMs: 1000,
      maxQueueDepth: 10,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    });
    const c = client(http, clock, { rateLimiter: limiter });
    await c.requestJson({ path: "/a" });
    await c.requestJson({ path: "/b" });
    expect(limiter.stats.dispatched).toBe(2);
  });

  it("surfaces queue overflow as its own kind, not as a network error", async () => {
    const http = new FakeHttp().always({ body: {} });
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      minIntervalMs: 60_000,
      maxQueueDepth: 1,
      now: () => clock.now(),
      // Never resolves, so the first waiter stays queued and the second is refused.
      sleep: () => new Promise<void>(() => undefined),
    });
    const c = client(http, clock, { rateLimiter: limiter });
    // The first dispatches immediately; the second occupies the only queue
    // slot and never gets one, which is the state the third must be refused in.
    void c.requestJson({ path: "/first" }).catch(() => null);
    void c.requestJson({ path: "/second" }).catch(() => null);
    await Promise.resolve();
    expect(limiter.queueDepth).toBe(1);

    const err = await c
      .requestJson({ path: "/third" })
      .catch((e: unknown) => e);
    expect((err as UpstreamError).kind).toBe("queue_overflow");
  });
});

describe("ProviderClient telemetry", () => {
  it("never emits a URL or a query string in an event", async () => {
    const http = new FakeHttp()
      .enqueue({ status: 500, body: {} })
      .enqueue({ body: {} });
    const events: string[] = [];
    const c = client(http, new FakeClock(), {
      onEvent: (e) => events.push(JSON.stringify(e)),
    });
    await c.requestJson({ path: "/x", query: { client_id: "SECRET_ID" } });
    const joined = events.join(" ");
    expect(joined).not.toContain("SECRET_ID");
    expect(joined).not.toContain("client_id");
    expect(joined).toContain("/x");
  });

  it("keeps credentials out of the error message on failure", async () => {
    const http = new FakeHttp().always({ status: 403, body: {} });
    const err = await client(http, new FakeClock())
      .requestJson({ path: "/x", query: { client_id: "SECRET_ID" } })
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain("SECRET_ID");
  });

  it("keeps credentials out of a timeout message", async () => {
    const http = new FakeHttp().always({ hang: true });
    const err = await client(http, new FakeClock(), {
      timeoutMs: 5,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxRetryAfterMs: 1,
      },
    })
      .requestJson({ path: "/x", query: { client_id: "SECRET_ID" } })
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain("SECRET_ID");
    expect(String(err)).toContain("[redacted]");
  });
});

describe("ProviderClient backoff jitter", () => {
  it("stays inside the exponential ceiling and varies with randomness", async () => {
    const runs: number[] = [];
    for (const random of [0, 0.25, 0.99]) {
      const http = new FakeHttp()
        .enqueue({ status: 500, body: {} })
        .enqueue({ status: 500, body: {} })
        .enqueue({ body: {} });
      const clock = new FakeClock(1_700_000_000_000, random);
      await client(http, clock).requestJson({ path: "/x" });
      runs.push(...clock.sleeps);
    }
    // Full jitter: every delay is in [0, ceiling) where ceiling doubles.
    expect(runs.filter((_, i) => i % 2 === 0).every((d) => d < 100)).toBe(true);
    expect(runs.filter((_, i) => i % 2 === 1).every((d) => d < 200)).toBe(true);
    expect(new Set(runs).size).toBeGreaterThan(1);
  });
});
