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
