/**
 * The stampede control, on its own.
 *
 * Every assertion here is about a COUNT of underlying calls rather than about a
 * returned value, because the value was never in doubt: a cache miss returns
 * the right answer whether it made one upstream call or a hundred. The count is
 * the whole property, and it is the difference between a slow cold start and an
 * IP block from a provider with no appeals process.
 */

import { describe, expect, it, vi } from "vitest";

import { SingleFlight } from "./single-flight.js";

/** A promise plus the handles to settle it, so a test can hold a call open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlight", () => {
  it("collapses a hundred concurrent callers into one call", async () => {
    const flight = new SingleFlight();
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);

    // The shape that actually happens at launch: one cold key, many clients,
    // none of them yet holding the answer the others would have reused.
    const callers = Array.from({ length: 100 }, () =>
      flight.run("artist:cold", work),
    );
    gate.resolve("answer");
    const results = await Promise.all(callers);

    expect(work).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(100);
    expect(new Set(results)).toEqual(new Set(["answer"]));
    expect(flight.stats).toEqual({ started: 1, joined: 99 });
  });

  it("keeps different keys independent", async () => {
    const flight = new SingleFlight();
    const work = vi.fn((key: string) => Promise.resolve(key));

    await Promise.all([
      flight.run("a", () => work("a")),
      flight.run("b", () => work("b")),
      flight.run("a", () => work("a")),
    ]);

    // Coalescing that merged unrelated keys would be a correctness bug far
    // worse than the stampede it prevents.
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("shares the failure rather than letting every caller retry", async () => {
    const flight = new SingleFlight();
    const gate = deferred<never>();
    const work = vi.fn(() => gate.promise);

    const callers = [
      flight.run("k", work),
      flight.run("k", work),
      flight.run("k", work),
    ];
    // Attached before rejecting so no caller is an unhandled rejection.
    const settled = Promise.allSettled(callers);
    gate.reject(new Error("provider down"));

    // Turning one upstream failure into three retries is the stampede again,
    // dressed as resilience.
    for (const outcome of await settled) {
      expect(outcome.status).toBe("rejected");
    }
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("admits a new call once the previous one has settled", async () => {
    const flight = new SingleFlight();
    const work = vi.fn(() => Promise.resolve("v"));

    await flight.run("k", work);
    await flight.run("k", work);

    // This is a map of work IN FLIGHT, never a cache. If a settled entry
    // persisted, this would be a memo with no TTL, no bound, and no eviction.
    expect(work).toHaveBeenCalledTimes(2);
    expect(flight.size).toBe(0);
  });

  it("releases the key after a failure so the next caller is not poisoned", async () => {
    const flight = new SingleFlight();
    let attempt = 0;
    const work = (): Promise<string> => {
      attempt++;
      return attempt === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve("recovered");
    };

    await expect(flight.run("k", work)).rejects.toThrow("transient");
    // A failed flight that never cleared its key would convert one bad response
    // into a permanently unfetchable key.
    await expect(flight.run("k", work)).resolves.toBe("recovered");
    expect(flight.size).toBe(0);
  });

  it("stays consistent when the work throws synchronously", async () => {
    const flight = new SingleFlight();
    const boom = (): Promise<never> => {
      throw new TypeError("programmer error");
    };

    await expect(flight.run("k", boom)).rejects.toBeInstanceOf(TypeError);
    // A synchronous throw must not leave the key registered forever, which is
    // what would happen if the entry were only cleared on promise settlement.
    expect(flight.size).toBe(0);
  });

  it("reports has() only while a call is running", async () => {
    const flight = new SingleFlight();
    const gate = deferred<string>();

    expect(flight.has("k")).toBe(false);
    const running = flight.run("k", () => gate.promise);
    expect(flight.has("k")).toBe(true);
    gate.resolve("v");
    await running;
    expect(flight.has("k")).toBe(false);
  });
});
