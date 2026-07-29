import { describe, expect, it } from "vitest";

import { QuotaCounter } from "./quota.js";
import { FakeClock } from "./testing/fake-http.js";

describe("QuotaCounter", () => {
  it("spends and refuses at the limit", () => {
    const q = new QuotaCounter({ limit: 3, windowMs: 1000 }, new FakeClock());
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(false);
    expect(q.snapshot().remaining).toBe(0);
    expect(q.snapshot().rejected).toBe(1);
  });

  it("slides rather than resetting on a fixed boundary", () => {
    const clock = new FakeClock();
    const q = new QuotaCounter({ limit: 2, windowMs: 1000 }, clock);
    q.tryConsume();
    clock.advance(600);
    q.tryConsume();
    expect(q.tryConsume()).toBe(false);

    // The first unit ages out at t=1001; the second is still inside the window,
    // which a fixed window would have wrongly forgiven.
    clock.advance(401);
    expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(false);
  });

  it("refuses a multi-unit spend atomically", () => {
    const q = new QuotaCounter({ limit: 3, windowMs: 1000 }, new FakeClock());
    expect(q.tryConsume(2)).toBe(true);
    expect(q.tryConsume(2)).toBe(false);
    // The refused spend must not have partially consumed the budget.
    expect(q.snapshot().used).toBe(2);
  });

  it("reports how long until budget frees up", () => {
    const clock = new FakeClock();
    const q = new QuotaCounter({ limit: 1, windowMs: 1000 }, clock);
    expect(q.msUntilAvailable()).toBe(0);
    q.tryConsume();
    clock.advance(400);
    expect(q.msUntilAvailable()).toBe(600);
  });

  it("models the iTunes budget: 15 in a minute, per IP", () => {
    const clock = new FakeClock();
    const q = new QuotaCounter({ limit: 15, windowMs: 60_000 }, clock);
    for (let i = 0; i < 15; i++) expect(q.tryConsume()).toBe(true);
    expect(q.tryConsume()).toBe(false);
    clock.advance(60_001);
    expect(q.tryConsume()).toBe(true);
  });
});

describe("QuotaCounter.retune", () => {
  it("adopts a budget the provider declared", () => {
    const clock = new FakeClock();
    const quota = new QuotaCounter({ limit: 30, windowMs: 10_000 }, clock);
    expect(quota.retune({ limit: 10, windowMs: 5_000 })).toBe(true);
    expect(quota.snapshot().limit).toBe(10);
    expect(quota.snapshot().windowMs).toBe(5_000);
  });

  it("reports no change when the policy is identical", () => {
    const quota = new QuotaCounter({ limit: 30, windowMs: 10_000 });
    expect(quota.retune({ limit: 30, windowMs: 10_000 })).toBe(false);
  });

  it("ignores a nonsensical policy rather than disabling the budget", () => {
    // A provider sending `X-RateLimit-Limit: 0` (or garbage) must not be able
    // to turn our local counter into something that never refuses, nor into
    // something that refuses everything.
    const quota = new QuotaCounter({ limit: 30, windowMs: 10_000 });
    expect(quota.retune({ limit: 0, windowMs: 10_000 })).toBe(false);
    expect(quota.retune({ limit: 30, windowMs: 0 })).toBe(false);
    expect(quota.snapshot().limit).toBe(30);
  });

  it("does not forgive spends already made when the limit tightens", () => {
    const clock = new FakeClock();
    const quota = new QuotaCounter({ limit: 5, windowMs: 10_000 }, clock);
    for (let i = 0; i < 5; i++) expect(quota.tryConsume()).toBe(true);
    quota.retune({ limit: 2, windowMs: 10_000 });
    // Already over the new ceiling, so the counter is simply full. That is the
    // conservative reading, and the alternative would let a tightened limit
    // hand us a fresh budget.
    expect(quota.tryConsume()).toBe(false);
    expect(quota.snapshot().remaining).toBe(0);
  });
});
