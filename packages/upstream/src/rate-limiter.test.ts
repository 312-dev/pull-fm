/**
 * Gate 1: a burst of requests must leave the process at no more than 1 req/s.
 *
 * These use a virtual clock rather than real time. A wall-clock test of a
 * 1 req/s limiter over 10,000 requests would take nearly three hours, so it
 * would never actually run in CI, and a gate that does not run is not a gate.
 * The virtual clock lets the full burst be asserted in milliseconds.
 */

import { describe, expect, it } from "vitest";
import { QueueOverflowError, RateLimiter } from "./rate-limiter.js";

/**
 * Deterministic clock.
 *
 * `sleep` advances time immediately rather than waiting, so the limiter's own
 * pacing arithmetic is exercised while the test runs instantly.
 */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

function limiter(minIntervalMs = 1000, maxQueueDepth = 20_000) {
  const clock = virtualClock();
  return {
    clock,
    rl: new RateLimiter({
      minIntervalMs,
      maxQueueDepth,
      now: clock.now,
      sleep: clock.sleep,
    }),
  };
}

describe("pacing", () => {
  it("dispatches the first request immediately", async () => {
    const { rl, clock } = limiter();
    await rl.acquire();
    expect(clock.time).toBe(0);
  });

  it("spaces consecutive dispatches by the minimum interval", async () => {
    const { rl, clock } = limiter(1000);
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      await rl.acquire();
      stamps.push(clock.time);
    }
    expect(stamps).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("does not delay a request that arrives after the interval has elapsed", async () => {
    // An idle service must not be penalised for having been idle.
    const { rl, clock } = limiter(1000);
    await rl.acquire();
    clock.advance(5000);
    await rl.acquire();
    expect(clock.time).toBe(5000);
  });
});

describe("Gate 1: burst never exceeds the limit", () => {
  it("holds 10,000 concurrent requests to at most 1 per second", async () => {
    // The exact assertion in the plan. Every request is enqueued before any
    // draining completes, which is the worst case: a thundering herd from many
    // concurrent HTTP handlers.
    const { rl } = limiter(1000, 20_000);
    const N = 10_000;

    await Promise.all(Array.from({ length: N }, () => rl.acquire()));

    // Read the limiter's own record. A caller's continuation runs as a
    // microtask, by which point the loop has paced further dispatches, so a
    // timestamp taken in .then() does not describe when it was dispatched.
    const stamps = [...rl.dispatchTimes];
    expect(stamps).toHaveLength(N);

    // No two dispatches closer together than the interval.
    const sorted = [...stamps].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(1000);
    }

    // Measured rate over the whole burst, which is what MusicBrainz observes.
    const elapsedSeconds = (sorted[sorted.length - 1]! - sorted[0]!) / 1000;
    const observedRate = (N - 1) / elapsedSeconds;
    expect(observedRate).toBeLessThanOrEqual(1.0);
  });

  it("never exceeds 1 request in any sliding one-second window", async () => {
    // A mean rate can hide a burst. This asserts the instantaneous property,
    // which is the one that actually gets an IP blocked.
    const { rl } = limiter(1000, 5000);
    await Promise.all(Array.from({ length: 500 }, () => rl.acquire()));
    // peakInWindow is the number a provider actually enforces against.
    expect(rl.peakInWindow(1000)).toBeLessThanOrEqual(1);
  });
});

describe("bounded queue", () => {
  it("rejects once the queue is full rather than growing without limit", async () => {
    // Unbounded queuing turns a rate-limit problem into an out-of-memory
    // problem, and serves callers that timed out long ago.
    // The first acquire dispatches immediately and never occupies the queue,
    // so saturating a depth-10 queue takes 11 calls.
    const { rl } = limiter(1000, 10);
    const accepted = Array.from({ length: 11 }, () => rl.acquire());
    await expect(rl.acquire()).rejects.toThrow(QueueOverflowError);
    await Promise.all(accepted);
  });

  it("accepts again once the queue drains", async () => {
    const { rl } = limiter(1000, 5);
    await Promise.all(Array.from({ length: 5 }, () => rl.acquire()));
    await expect(rl.acquire()).resolves.toBeUndefined();
  });

  it("counts rejections for observability", async () => {
    const { rl } = limiter(1000, 2);
    const inflight = [rl.acquire(), rl.acquire(), rl.acquire()];
    await expect(rl.acquire()).rejects.toThrow(QueueOverflowError);
    await Promise.all(inflight);
    expect(rl.stats.rejected).toBe(1);
    expect(rl.stats.dispatched).toBe(3);
  });
});

describe("ordering and shutdown", () => {
  it("dispatches in FIFO order", async () => {
    const { rl } = limiter(1000);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        rl.acquire().then(() => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("rejects queued callers on shutdown instead of hanging them", async () => {
    const { rl } = limiter(1000, 100);
    void rl.acquire(); // consumes the immediate slot
    const pending = rl.acquire();
    rl.drainAndReject("shutting down");
    await expect(pending).rejects.toThrow(/shutting down/);
  });
});

describe("configuration", () => {
  it("rejects a nonsensical queue depth", () => {
    expect(
      () => new RateLimiter({ minIntervalMs: 1000, maxQueueDepth: 0 }),
    ).toThrow();
  });

  it("supports a zero interval for providers with no documented limit", async () => {
    const { rl, clock } = limiter(0, 10);
    await rl.acquire();
    await rl.acquire();
    expect(clock.time).toBe(0);
  });
});
