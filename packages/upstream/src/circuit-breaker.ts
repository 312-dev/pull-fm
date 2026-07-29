/**
 * Per-provider circuit breaker.
 *
 * The failure mode this prevents is specific: when an upstream starts timing
 * out, every feed request piles ten more requests onto it, each holding a
 * connection for the full timeout. Latency collapses across the whole service
 * because of one sick dependency. Opening the circuit converts that into an
 * instant, cheap failure that the feed renders as a missing section.
 *
 * Half-open admits a bounded number of trial calls rather than one, because a
 * single probe against a provider that is flapping produces an oscillating
 * circuit; requiring consecutive successes damps it.
 */

import type { Clock } from "./types.js";
import { systemClock } from "./types.js";

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerPolicy {
  /** Consecutive provider-attributable failures before opening. */
  readonly failureThreshold: number;
  /** How long to stay open before admitting trial traffic. */
  readonly resetTimeoutMs: number;
  /** Successes required in half-open before closing. Default 2. */
  readonly successThreshold?: number;
  /**
   * Cap on repeated re-opening backoff. Each consecutive open doubles the
   * reset timeout up to this value, so a provider that is down for an hour is
   * probed a handful of times rather than every `resetTimeoutMs`.
   */
  readonly maxResetTimeoutMs?: number;
}

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly opens: number;
}

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #resetTimeoutMs: number;
  readonly #successThreshold: number;
  readonly #maxResetTimeoutMs: number;
  readonly #clock: Clock;

  #state: BreakerState = "closed";
  #consecutiveFailures = 0;
  #halfOpenSuccesses = 0;
  #halfOpenInFlight = 0;
  #openedAt: number | null = null;
  #nextAttemptAt: number | null = null;
  #opens = 0;
  /** Consecutive opens, used to widen the reset window. Reset on a clean close. */
  #openStreak = 0;

  constructor(policy: BreakerPolicy, clock: Clock = systemClock) {
    if (policy.failureThreshold < 1) {
      throw new Error("failureThreshold must be >= 1");
    }
    if (policy.resetTimeoutMs < 0) {
      throw new Error("resetTimeoutMs must be >= 0");
    }
    this.#failureThreshold = policy.failureThreshold;
    this.#resetTimeoutMs = policy.resetTimeoutMs;
    this.#successThreshold = policy.successThreshold ?? 2;
    this.#maxResetTimeoutMs =
      policy.maxResetTimeoutMs ?? policy.resetTimeoutMs * 8;
    this.#clock = clock;
  }

  get state(): BreakerState {
    // Recompute lazily: nothing schedules a timer, so the state transition from
    // open to half-open has to happen on read. A timer would keep the process
    // alive and would need clearing on shutdown for no benefit.
    if (
      this.#state === "open" &&
      this.#nextAttemptAt !== null &&
      this.#clock.now() >= this.#nextAttemptAt
    ) {
      this.#state = "half_open";
      this.#halfOpenSuccesses = 0;
      this.#halfOpenInFlight = 0;
    }
    return this.#state;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.#consecutiveFailures,
      openedAt: this.#openedAt,
      nextAttemptAt: this.#nextAttemptAt,
      opens: this.#opens,
    };
  }

  /** True when a call may proceed. Reserves a half-open slot when relevant. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.#halfOpenInFlight >= this.#successThreshold) return false;
    this.#halfOpenInFlight++;
    return true;
  }

  recordSuccess(): void {
    if (this.#state === "half_open") {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      this.#halfOpenSuccesses++;
      if (this.#halfOpenSuccesses >= this.#successThreshold) {
        this.#close();
      }
      return;
    }
    this.#consecutiveFailures = 0;
  }

  /**
   * Records a failure that is attributable to the provider.
   *
   * Callers must NOT report 4xx responses here (see
   * `UpstreamError.countsAgainstProvider`): a bad request of ours is not
   * evidence that the provider is down.
   */
  recordFailure(): void {
    if (this.#state === "half_open") {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      this.#open();
      return;
    }
    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= this.#failureThreshold) {
      this.#open();
    }
  }

  /** Forces the circuit closed. Used by the kill switch's manual reset. */
  reset(): void {
    this.#close();
  }

  #open(): void {
    this.#state = "open";
    this.#opens++;
    this.#openStreak++;
    const backoff = Math.min(
      this.#maxResetTimeoutMs,
      this.#resetTimeoutMs * 2 ** (this.#openStreak - 1),
    );
    this.#openedAt = this.#clock.now();
    this.#nextAttemptAt = this.#openedAt + backoff;
    this.#halfOpenSuccesses = 0;
    this.#halfOpenInFlight = 0;
  }

  #close(): void {
    this.#state = "closed";
    this.#consecutiveFailures = 0;
    this.#halfOpenSuccesses = 0;
    this.#halfOpenInFlight = 0;
    this.#openedAt = null;
    this.#nextAttemptAt = null;
    this.#openStreak = 0;
  }
}
