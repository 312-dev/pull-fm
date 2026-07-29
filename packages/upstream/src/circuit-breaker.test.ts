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

  it("widens the reset window on repeated opens up to the cap, when asked to", () => {
    // Opt-in only: `maxResetTimeoutMs` is set here. Without it the window does
    // not widen at all, because the ceiling is the recovery budget. See the
    // default-behaviour test below.
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

  it("does not widen the reset window by default, so recovery is bounded by one interval", () => {
    // Gate 7 allows 60s to recover. The old default widened the window to
    // `resetTimeoutMs * 8` on repeated opens, which made worst-case recovery
    // eight probe intervals: a sustained fault left the breaker at its slowest
    // exactly when the provider returned. Recovery latency IS the interval
    // between probes, so the interval has to stay put.
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { failureThreshold: 1, resetTimeoutMs: 1000, successThreshold: 1 },
      clock,
    );

    for (let i = 0; i < 5; i++) {
      b.tryAcquire();
      b.recordFailure();
      expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 1000);
      clock.advance(1001);
      expect(b.state).toBe("half_open");
    }

    // And the provider coming back is noticed within that same one interval,
    // no matter how long it was down.
    b.tryAcquire();
    b.recordSuccess();
    expect(b.state).toBe("closed");
  });

  it("discharges the widening ladder on a half-open success, not only on a close", () => {
    // A provider that answers one trial and fails the next has demonstrably
    // been reachable, so the next open starts the ladder from the bottom. The
    // alternative compounds recovery latency across a flap, which is the case
    // the ladder is supposed to help with.
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        successThreshold: 2,
        maxResetTimeoutMs: 8000,
      },
      clock,
    );

    b.recordFailure();
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 1000);

    clock.advance(1001);
    expect(b.state).toBe("half_open");
    b.tryAcquire();
    b.recordFailure();
    // No answer yet, so the ladder climbs.
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 2000);

    clock.advance(2001);
    expect(b.state).toBe("half_open");
    b.tryAcquire();
    b.recordSuccess(); // one clean answer, not yet enough to close
    expect(b.state).toBe("half_open");
    b.tryAcquire();
    b.recordFailure();
    // Back to the bottom rung rather than on to 4000.
    expect(b.snapshot().nextAttemptAt).toBe(clock.now() + 1000);
  });

  it("rejects a nonsensical policy at construction", () => {
    expect(
      () => new CircuitBreaker({ failureThreshold: 0, resetTimeoutMs: 1 }),
    ).toThrow();
  });

  it("rejects a recovery ceiling below the probe interval", () => {
    // Reads as an intent the breaker cannot honour: the first open already
    // waits `resetTimeoutMs`, so a smaller ceiling would be silently ignored.
    expect(
      () =>
        new CircuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 30_000,
          maxResetTimeoutMs: 10_000,
        }),
    ).toThrow(/maxResetTimeoutMs/);
  });
});
