import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "./circuit-breaker.js";
import { FakeClock } from "./testing/fake-http.js";

describe("CircuitBreaker", () => {
  it("opens on consecutive failures and refuses traffic", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { failureThreshold: 3, resetTimeoutMs: 1000 },
      clock,
    );
    for (let i = 0; i < 2; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.recordFailure();
    }
    expect(b.state).toBe("closed");
    b.tryAcquire();
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.tryAcquire()).toBe(false);
  });

  it("resets the failure count on any success", () => {
    const b = new CircuitBreaker(
      { failureThreshold: 3, resetTimeoutMs: 1000 },
      new FakeClock(),
    );
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("closed");
  });

  it("half-opens after the reset window and closes on enough successes", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 1000, successThreshold: 2 },
      clock,
    );
    b.recordFailure();
    expect(b.state).toBe("open");

    clock.advance(1001);
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe("closed");
  });

  it("re-opens immediately when a trial call fails", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 1000, successThreshold: 2 },
      clock,
    );
    b.recordFailure();
    clock.advance(1001);
    expect(b.state).toBe("half_open");
    b.tryAcquire();
    b.recordFailure();
    expect(b.state).toBe("open");
  });

  it("bounds half-open concurrency so a flapping provider is not stampeded", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 1000, successThreshold: 2 },
      clock,
    );
    b.recordFailure();
    clock.advance(1001);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it("widens the reset window on repeated opens, up to the cap", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        successThreshold: 1,
        maxResetTimeoutMs: 4000,
      },
      clock,
    );
    b.recordFailure();
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 1000);

    clock.advance(1001);
    b.tryAcquire();
    b.recordFailure();
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 2000);

    clock.advance(2001);
    b.tryAcquire();
    b.recordFailure();
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 4000);

    clock.advance(4001);
    b.tryAcquire();
    b.recordFailure();
    // Capped: a provider down for an hour is probed a handful of times.
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 4000);
  });

  it("rejects a nonsensical policy at construction", () => {
    expect(
      () => new CircuitBreaker({ failureThreshold: 0, resetTimeoutMs: 1 }),
    ).toThrow();
  });
});
