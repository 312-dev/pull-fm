/**
 * The per-subject upstream-call budget, attacked.
 *
 * security/AUDIT-2026-07-29.md F12 DEMONSTRATED, rather than theorised, that
 * this service's only per-IP limiter could be reset by rotating source
 * addresses, because it was a 5,000-entry in-process LRU:
 *
 *     A: hits 1-4 (max=3)                      200 200 200 429
 *     A: is it latched at 429?                 429
 *     distinct rotating source addresses       5600
 *     A: hits again after the rotation         200 200 200 429   <- restored
 *
 * F13 then showed that the strongest credential in the system, an interactive
 * session, had no per-credential budget at all, so one account rotating
 * addresses could spend the shared upstream allowances without bound.
 *
 * The cost asymmetry is what makes it a denial of service rather than an
 * annoyance. `GET /v1/artists/{mbid}/similar` turns ANY well-formed UUID into
 * exactly one ListenBrainz labs call, with no existence check first, so a random
 * UUID is a guaranteed miss and the request-to-upstream ratio is 1:1 with no
 * cache able to absorb it. That allowance is roughly 30 calls per 10 seconds
 * APP-WIDE, with no per-user token to spread it over. `/preview` and `/events`
 * have the same shape.
 *
 * NOT MusicBrainz, whose 1 req/s is the number everyone reaches for: every
 * request-path read of it is `CachedUpstream.peek`, which is a database read
 * that returns null on a miss and cannot call out. Sizing or testing this budget
 * against that limit would be testing against a limit no request can reach.
 *
 * Every block below names the claim it tries to falsify. The first is the
 * regression test that matters most: it replays the audit's own experiment and
 * requires the opposite result.
 *
 * WHY THESE SUITES BUILD THEIR OWN APPLICATIONS
 * --------------------------------------------
 * `buildTestApp` lifts both ceilings out of the way, because every other suite
 * deliberately drives cold caches and would otherwise throttle itself. A budget
 * test has to run against real numbers, so each block sets its own.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { provisionSubject, type Subject } from "../helpers/subjects.js";
import {
  BUDGET_SCRIPT_MARKER,
  UpstreamBudget,
  upstreamBudgetKey,
} from "../../src/lib/upstream-budget.js";

/**
 * A fresh, unresolvable MBID.
 *
 * This is the attacker's primitive in one line: a well-formed identifier that
 * nothing holds, so the request cannot be answered from cache and MUST spend an
 * upstream call. `GET /v1/artists/:mbid/similar` turns exactly one of these into
 * exactly one ListenBrainz labs call, which makes the arithmetic below readable
 * rather than approximate.
 */
const coldMbid = (): string => randomUUID();

/** Distinct source addresses, the way Cloudflare would forward them. */
const address = (n: number): string =>
  `10.${String((n >> 16) & 255)}.${String((n >> 8) & 255)}.${String(n & 255)}`;

describe("the demonstrated IP-rotation bypass of the per-IP floor", () => {
  /**
   * The claim under attack is the one the audit falsified: "the per-IP limiter
   * protects the service". It did not, because its counters were in a
   * 5,000-entry in-process LRU and rotation evicted them.
   *
   * This replays the audit transcript against the real application and requires
   * the throttled address to STAY throttled. The counters now live in the
   * `noeviction` quota Redis, where there is nothing to evict them.
   */
  it("stays throttled after 5,600 distinct addresses have rotated through", async () => {
    // A unique /24 per run, so this test cannot collide with another suite's
    // counter in the shared quota instance or with its own previous run.
    const octet = 1 + Math.floor(Math.random() * 250);
    const attacker = `198.51.100.${String(octet)}`;

    const ctx = await buildTestApp({ env: { RATE_LIMIT_MAX: "3" } });
    try {
      const hit = (ip: string) =>
        ctx.app.inject({
          method: "GET",
          url: "/healthz",
          headers: { "x-forwarded-for": ip },
        });

      const first = [
        await hit(attacker),
        await hit(attacker),
        await hit(attacker),
        await hit(attacker),
      ].map((r) => r.statusCode);
      expect(first).toEqual([200, 200, 200, 429]);

      // Latched, not merely momentary.
      expect((await hit(attacker)).statusCode).toBe(429);

      // THE ROTATION. 5,600 distinct addresses is what evicted the attacker's
      // own counter from the old 5,000-entry LRU. With IPv6 this is free: one
      // /64 holds more addresses than any in-process cache can.
      for (let i = 0; i < 5600; i += 1) {
        await hit(address(i));
      }

      // The old build restored a full budget here. Anything other than 429 is
      // the bypass being open again.
      const after = [
        await hit(attacker),
        await hit(attacker),
        await hit(attacker),
      ].map((r) => r.statusCode);
      expect(after).toEqual([429, 429, 429]);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  /**
   * A refusal must be an RFC 9457 problem document with the right status.
   *
   * This was wrong until the audit: `errorResponseBuilder` returned a problem
   * DOCUMENT, and the plugin throws whatever it returns, so a plain object with
   * no `statusCode` fell through to the generic 500 handler. Nobody noticed
   * because no suite could reach the limit while its counters were per-process.
   */
  it("refuses with 429 problem+json rather than a generic 500", async () => {
    const octet = 1 + Math.floor(Math.random() * 250);
    const attacker = `198.51.100.${String(octet)}`;
    const ctx = await buildTestApp({ env: { RATE_LIMIT_MAX: "1" } });
    try {
      await ctx.app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-forwarded-for": attacker },
      });
      const refused = await ctx.app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-forwarded-for": attacker },
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers["content-type"]).toContain(
        "application/problem+json",
      );
      const problem = refused.json<{ type: string; status: number }>();
      expect(problem.status).toBe(429);
      expect(problem.type).toContain("rate-limited");
    } finally {
      await ctx.close();
    }
  }, 60_000);
});

describe("an authenticated subject's upstream budget", () => {
  let ctx: TestApp;
  let alice: Subject;

  beforeAll(async () => {
    ctx = await buildTestApp({
      env: {
        UPSTREAM_BUDGET_AUTHENTICATED_MAX: "3",
        UPSTREAM_BUDGET_WINDOW_S: "600",
      },
    });
    alice = await provisionSubject(ctx, "budget");
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  const similar = (mbid: string, ip = "192.0.2.10") =>
    ctx.app.inject({
      method: "GET",
      url: `/v1/artists/${mbid}/similar`,
      headers: {
        authorization: `Bearer ${alice.token}`,
        "x-forwarded-for": ip,
      },
    });

  it("is spent by cache misses and refuses once it is gone", async () => {
    const budgetKey = () =>
      upstreamBudgetKey(
        { tier: "authenticated", id: alice.id },
        600,
        Date.now(),
      );
    await ctx.services.quotaRedis.del(budgetKey());
    ctx.upstreams.reset();

    // Three distinct, uncacheable identifiers. Each one costs exactly one
    // upstream call, which is exactly the attacker's primitive.
    for (let i = 0; i < 3; i += 1) {
      expect((await similar(coldMbid())).statusCode).toBe(200);
    }

    // The amplification this budget exists to bound, asserted rather than
    // assumed: three requests, three outbound calls, 1:1, no existence check and
    // no cache able to absorb any of it.
    expect(ctx.upstreams.callsTo("labs.api")).toHaveLength(3);
    // And NOT MusicBrainz. Its 1 req/s is unreachable from a route because the
    // request path only ever peeks, so a budget sized against it would be sized
    // against the wrong number. This assertion is what keeps that true.
    expect(ctx.upstreams.callsTo("musicbrainz")).toHaveLength(0);
    expect(Number(await ctx.services.quotaRedis.get(budgetKey()))).toBe(3);

    const refused = await similar(coldMbid());
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["content-type"]).toContain(
      "application/problem+json",
    );
    // A client has to be told when to come back, and the value has to be a real
    // one rather than a placeholder.
    const retryAfter = Number(refused.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  /**
   * THE CENTRAL CLAIM. F13's exploit was one authenticated session rotating
   * source addresses. The budget is keyed on the SUBJECT, so the addresses are
   * irrelevant: the same account is the same account from anywhere.
   */
  it("cannot be reset by rotating the source address", async () => {
    await ctx.services.quotaRedis.del(
      upstreamBudgetKey(
        { tier: "authenticated", id: alice.id },
        600,
        Date.now(),
      ),
    );

    for (let i = 0; i < 3; i += 1) {
      expect((await similar(coldMbid(), address(700 + i))).statusCode).toBe(
        200,
      );
    }

    // Every one of these is a fresh address, and one is even the loopback the
    // old per-IP counter would have had a separate bucket for.
    for (const ip of [
      "203.0.113.99",
      "198.18.7.7",
      "127.0.0.1",
      "192.0.2.222",
    ]) {
      const res = await similar(coldMbid(), ip);
      expect(res.statusCode).toBe(429);
    }
  });

  /**
   * A hit must be free, or the budget is just a request limiter with extra
   * steps and the cache stops being the thing that makes the service survivable.
   */
  it("is not spent by cache hits", async () => {
    const key = upstreamBudgetKey(
      { tier: "authenticated", id: alice.id },
      600,
      Date.now(),
    );
    await ctx.services.quotaRedis.del(key);

    const warm = coldMbid();
    expect((await similar(warm)).statusCode).toBe(200);
    const afterMiss = Number(await ctx.services.quotaRedis.get(key));
    expect(afterMiss).toBe(1);

    ctx.upstreams.reset();
    for (let i = 0; i < 5; i += 1) {
      expect((await similar(warm)).statusCode).toBe(200);
    }

    // The proof that those five really were hits: nothing left the process.
    expect(ctx.upstreams.calls).toHaveLength(0);
    // And therefore the counter did not move. Five requests, zero budget.
    expect(Number(await ctx.services.quotaRedis.get(key))).toBe(1);
  });

  /**
   * The response must not tell a caller whether a given identifier was cached.
   *
   * A per-request "remaining budget" header would do exactly that, because this
   * budget moves only on a miss: it would turn a rate-limit header into an
   * enumeration primitive over the whole catalogue and over what other subjects
   * have caused to be resolved (THREAT-MODEL T12's disclosure, by a side
   * channel rather than by a shared body).
   */
  it("does not disclose per-request cache state through a header", async () => {
    await ctx.services.quotaRedis.del(
      upstreamBudgetKey(
        { tier: "authenticated", id: alice.id },
        600,
        Date.now(),
      ),
    );

    const warm = coldMbid();
    const miss = await similar(warm);
    const hit = await similar(warm);

    expect(miss.statusCode).toBe(200);
    expect(hit.statusCode).toBe(200);

    // No budget header exists at all, under any spelling.
    const names = (r: typeof miss): string[] =>
      Object.keys(r.headers).map((n) => n.toLowerCase());
    for (const name of [...names(miss), ...names(hit)]) {
      expect(name).not.toContain("budget");
    }

    // And the two responses are indistinguishable by header SHAPE, so there is
    // nothing to diff. `x-ratelimit-*` is present on both because it belongs to
    // the per-IP floor, which counts requests and therefore moves identically
    // for a hit and for a miss.
    expect(names(hit).sort()).toEqual(names(miss).sort());
    expect(names(hit)).toContain("x-ratelimit-remaining");
  });
});

describe("an anonymous caller's upstream budget", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await buildTestApp({
      env: {
        UPSTREAM_BUDGET_AUTHENTICATED_MAX: "60",
        UPSTREAM_BUDGET_ANONYMOUS_MAX: "5",
        UPSTREAM_BUDGET_WINDOW_S: "600",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  /**
   * No route today lets an unauthenticated caller reach a provider, so the
   * anonymous tier is exercised against the budget object itself rather than
   * through a route that cannot exist yet. Driving the real class against the
   * real quota Redis is the honest version of this test: a route-shaped one
   * would have to invent a route and would then be testing the invention.
   */
  it("is an order of magnitude smaller than an authenticated subject's", async () => {
    const budget = new UpstreamBudget(ctx.services.quotaRedis, {
      authenticatedMax: 60,
      anonymousMax: 5,
      windowSeconds: 600,
    });

    expect(budget.limitFor("authenticated")).toBe(60);
    expect(budget.limitFor("anonymous")).toBe(5);
    expect(budget.limitFor("authenticated")).toBeGreaterThanOrEqual(
      budget.limitFor("anonymous") * 10,
    );

    const caller = {
      tier: "anonymous" as const,
      id: `192.0.2.${String(1 + Math.floor(Math.random() * 250))}`,
    };
    await ctx.services.quotaRedis.del(
      upstreamBudgetKey(caller, 600, Date.now()),
    );

    // Five requests, each of which really does spend one upstream call.
    for (let i = 0; i < 5; i += 1) {
      const decision = await budget.reserve(caller);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) await budget.settle(decision.reservation, 1);
    }
    expect(await budget.spent(caller)).toBe(5);

    const refused = await budget.reserve(caller);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.tier).toBe("anonymous");
      expect(refused.limit).toBe(5);
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    }

    // A signed-in subject with the same traffic is nowhere near its ceiling.
    // That asymmetry is what makes signing in the cheap way to get service and
    // address rotation the expensive way.
    const signedIn = { tier: "authenticated" as const, id: randomUUID() };
    for (let i = 0; i < 5; i += 1) {
      const decision = await budget.reserve(signedIn);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) await budget.settle(decision.reservation, 1);
    }
    expect((await budget.reserve(signedIn)).allowed).toBe(true);
  });

  /**
   * The reservation caps in-flight requests as well as spend. That is what
   * stops an anonymous caller opening the budget's worth of slow requests and
   * holding them, and it is the only part of the anonymous tier a route can
   * exercise today.
   */
  it("caps how much an anonymous caller can hold in flight", async () => {
    const ip = `198.51.100.${String(1 + Math.floor(Math.random() * 250))}`;
    await ctx.services.quotaRedis.del(
      upstreamBudgetKey({ tier: "anonymous", id: ip }, 600, Date.now()),
    );

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ctx.app.inject({
          method: "GET",
          url: "/v1/config",
          headers: { "x-forwarded-for": ip },
        }),
      ),
    );
    const admitted = results.filter((r) => r.statusCode === 200).length;
    expect(admitted).toBeLessThanOrEqual(5);
    expect(admitted).toBeGreaterThan(0);

    // Sequentially it is not throttled at all, because none of those requests
    // spends an upstream call and a request that costs nothing must cost
    // nothing. That is the whole design: budget the scarce thing, not the
    // request rate.
    for (let i = 0; i < 10; i += 1) {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/v1/config",
        headers: { "x-forwarded-for": ip },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("does not apply to health, readiness or metrics", async () => {
    const ip = `192.0.2.${String(1 + Math.floor(Math.random() * 250))}`;
    // An operator must be able to see the service while it is refusing traffic.
    // Losing observability at the moment of an incident is the opposite of what
    // a limiter is for.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.app.inject({
          method: "GET",
          url: "/healthz",
          headers: { "x-forwarded-for": ip },
        }),
      ),
    );
    for (const res of results) expect(res.statusCode).toBe(200);
  });
});

describe("the budget fails closed when the quota store refuses writes", () => {
  /**
   * The realistic outage is not "Redis is gone". It is "Redis answers PING and
   * refuses the write", which is what `noeviction` produces at `maxmemory` and
   * what a failing-over managed instance produces during the switch.
   *
   * There is precedent for getting this half right: the per-token limiter's
   * fail-closed branch was once a bare `catch` that logged nothing and counted
   * nothing, so a dead quota store produced 503s indistinguishable from an
   * upstream provider outage. So the assertion here is deliberately in two
   * parts - the request is REFUSED, and the refusal is COUNTED.
   */
  let ctx: TestApp;
  let subject: Subject;

  beforeAll(async () => {
    ctx = await buildTestApp({
      env: { UPSTREAM_BUDGET_AUTHENTICATED_MAX: "60" },
    });
    subject = await provisionSubject(ctx, "failclosed");
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  const call = () =>
    ctx.app.inject({
      method: "GET",
      url: `/v1/artists/${coldMbid()}/similar`,
      headers: { authorization: `Bearer ${subject.token}` },
    });

  /**
   * Severs the quota store for scripts matching `only`, and restores it however
   * the body ends. Matching on the script text is what lets one control be cut
   * without cutting the others that share the client.
   */
  async function withRefusingQuota(
    only: (script: string) => boolean,
    body: () => Promise<void>,
  ): Promise<void> {
    const quota = ctx.services.quotaRedis as unknown as {
      eval: (...args: unknown[]) => Promise<unknown>;
    };
    const realEval = quota.eval.bind(quota);
    quota.eval = (...args: unknown[]) => {
      const script = typeof args[0] === "string" ? args[0] : "";
      if (!only(script)) return realEval(...args);
      // What `noeviction` produces at `maxmemory`, and what a failing-over
      // managed instance produces during the switch. Reads keep working, so the
      // process looks healthy from every angle except the one that matters.
      return Promise.reject(
        new Error("OOM command not allowed when used memory > 'maxmemory'."),
      );
    };
    try {
      await body();
    } finally {
      quota.eval = realEval;
    }
  }

  it("refuses the request and counts it as pullfm_fail_closed_total{store=upstream_budget}", async () => {
    expect((await call()).statusCode).toBe(200);

    const label = { store: "upstream_budget" };
    const before = ctx.services.metrics.peek("pullfm_fail_closed_total", label);

    await withRefusingQuota(
      (script) => script.includes(BUDGET_SCRIPT_MARKER),
      async () => {
        const during = await call();
        // A 200 here would mean the budget silently stopped existing, which is
        // the failure the `noeviction` instance exists to make impossible.
        expect(during.statusCode).not.toBe(200);
        expect(during.statusCode).toBe(503);
        expect(during.headers["content-type"]).toContain(
          "application/problem+json",
        );
      },
    );

    // Instrumented, not merely correct. S3 in docs/RUNBOOK-INCIDENT.md is an
    // alert on this counter, and the label is what tells an operator WHICH of
    // the four quota-Redis consumers broke.
    const after = ctx.services.metrics.peek("pullfm_fail_closed_total", label);
    expect(after).not.toBeNull();
    expect(after ?? 0).toBeGreaterThan(before ?? 0);

    // And it recovers rather than latching.
    expect((await call()).statusCode).toBe(200);
  });

  it("fails closed at the per-IP floor too when the whole store refuses", async () => {
    const label = { store: "global_limiter" };
    const before = ctx.services.metrics.peek("pullfm_fail_closed_total", label);

    await withRefusingQuota(
      () => true,
      async () => {
        const during = await call();
        expect(during.statusCode).toBe(503);
      },
    );

    const after = ctx.services.metrics.peek("pullfm_fail_closed_total", label);
    expect(after ?? 0).toBeGreaterThan(before ?? 0);
    expect((await call()).statusCode).toBe(200);
  });
});

describe("concurrent requests cannot double-spend the budget", () => {
  /**
   * The naive implementation reads the counter, decides, and writes. Under
   * concurrency every request reads the same value and every one of them
   * decides it has room, so a budget of three admits thirty. The reservation is
   * a single atomic check-and-increment for exactly this reason, and it is
   * taken BEFORE the handler runs rather than after it, because "after" is too
   * late by definition.
   */
  it("admits at most the budget, however many arrive at once", async () => {
    const ctx = await buildTestApp({
      env: {
        UPSTREAM_BUDGET_AUTHENTICATED_MAX: "3",
        UPSTREAM_BUDGET_WINDOW_S: "600",
        // The floor must not be what refuses these, or the test would pass
        // without the budget existing at all.
        RATE_LIMIT_MAX: "100000",
      },
    });
    try {
      const subject = await provisionSubject(ctx, "race");
      await ctx.services.quotaRedis.del(
        upstreamBudgetKey(
          { tier: "authenticated", id: subject.id },
          600,
          Date.now(),
        ),
      );

      // Held open so every request is genuinely in flight at the same time. An
      // instantaneous fake serialises the requests and measures nothing while
      // appearing to pass, which is the same trap the coalescing tests document.
      ctx.upstreams.setLatency(120);

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          ctx.app.inject({
            method: "GET",
            url: `/v1/artists/${coldMbid()}/similar`,
            headers: { authorization: `Bearer ${subject.token}` },
          }),
        ),
      );
      ctx.upstreams.setLatency(0);

      const admitted = results.filter((r) => r.statusCode === 200).length;
      const refused = results.filter((r) => r.statusCode === 429).length;

      expect(admitted).toBe(3);
      expect(refused).toBe(9);
      expect(admitted + refused).toBe(12);

      // Nothing beyond the budget reached a provider. This is the property the
      // whole exercise is for: the scarce resource was protected, not merely
      // the request count.
      expect(ctx.upstreams.calls.length).toBeLessThanOrEqual(3);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
