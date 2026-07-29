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
 *
 * ---------------------------------------------------------------------------
 * WHY THE RE-OPEN BACKOFF NO LONGER WIDENS BY DEFAULT
 *
 * This class used to double `resetTimeoutMs` on every consecutive open, up to
 * `resetTimeoutMs * 8`, so 30s -> 60s -> 120s -> 240s. The stated reason was
 * that "a provider that is down for an hour is probed a handful of times
 * rather than every resetTimeoutMs". That reason does not survive contact with
 * the numbers, and the cost of it was measured.
 *
 * A breaker has NO WAY to learn that a provider recovered except by probing
 * it, so the time between probes IS the recovery latency, in full. Widening
 * the interval on repeated failure therefore does the exact wrong thing: a
 * sustained outage leaves the breaker at its SLOWEST setting at the precise
 * moment the provider comes back, and every user keeps seeing a degraded feed
 * for up to another `maxResetTimeoutMs` after the incident is over. Gate 7
 * asks for recovery under 60 seconds and a fault long enough to reach the old
 * cap bought 240 seconds of degradation after the provider was healthy.
 *
 * The runbook recorded this as "62 seconds against a 60 second gate". That
 * number could not be reproduced from any run in k6-results/: both recorded
 * `breaker` runs carry the 999 sentinel, the scenario's code for "never came
 * back inside the observation window". The backoff is the smaller half of that
 * defect. The other half is not in this class at all: recovery needs a trial
 * call, a trial call needs somebody to ask for the provider, and while the
 * circuit is open the upstream cache answers every request without asking. See
 * `CachedUpstream`'s half-open probe in ./cache/cache-first.ts, which is what
 * actually makes this breaker's reset window the thing that bounds recovery.
 *
 * What the widening bought, in exchange: half-open already caps trial traffic
 * at `successThreshold` in-flight calls, so probing a dead provider every 30s
 * for an hour costs 240 requests. Every 240s it costs 30. The saving is ~210
 * requests per hour against one provider, next to the ~36,000 requests the
 * open circuit is shedding over the same hour. That is not a saving worth up
 * to four minutes of degraded product per incident.
 *
 * Note also that the obvious cap of "somewhere near 60s" does not work, and
 * that was checked before choosing this: recovery is the remaining backoff
 * plus the time to satisfy `successThreshold` plus however long the observer
 * takes to notice, so a 60s cap reproduces the 62s failure exactly. The
 * ceiling has to be below the budget with room to spare, not near it.
 *
 * Widening is still available to a caller who has a provider that genuinely
 * punishes probing, via `maxResetTimeoutMs`. It is opt-in, and the doc comment
 * on that field states the recovery cost so the trade is made deliberately.
 * ---------------------------------------------------------------------------
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
   * Ceiling on the re-open backoff, and therefore the WORST-CASE RECOVERY
   * LATENCY of this provider: a fault that clears one millisecond after a
   * re-open keeps serving degraded for this long afterwards.
   *
   * Defaults to `resetTimeoutMs`, which means no widening at all. Raising it
   * re-enables the doubling ladder (`resetTimeoutMs`, x2, x4, ... clamped
   * here) and buys a small reduction in probe traffic against a dead provider
   * at the cost of that much extra degradation after it recovers. Set it only
   * when a specific provider penalises probing, and set it below the recovery
   * budget with margin, not at it.
   *
   * Must be >= `resetTimeoutMs`; a smaller value is a policy error rather than
   * something to silently clamp, because it reads as an intent the breaker
   * cannot honour.
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
  /**
   * Consecutive opens with no intervening answer from the provider. Widens the
   * reset window only when `maxResetTimeoutMs` was raised above
   * `resetTimeoutMs`; discharged by any half-open success, not only by a close.
   */
  #openStreak = 0;

  constructor(policy: BreakerPolicy, clock: Clock = systemClock) {
    if (policy.failureThreshold < 1) {
      throw new Error("failureThreshold must be >= 1");
    }
    if (policy.resetTimeoutMs < 0) {
      throw new Error("resetTimeoutMs must be >= 0");
    }
    if (
      policy.maxResetTimeoutMs !== undefined &&
      policy.maxResetTimeoutMs < policy.resetTimeoutMs
    ) {
      throw new Error("maxResetTimeoutMs must be >= resetTimeoutMs");
    }
    this.#failureThreshold = policy.failureThreshold;
    this.#resetTimeoutMs = policy.resetTimeoutMs;
    this.#successThreshold = policy.successThreshold ?? 2;
    // Defaults to no widening. See the header comment: the previous default of
    // `resetTimeoutMs * 8` made recovery latency eight times the probe interval
    // for exactly the incidents where recovery matters most.
    this.#maxResetTimeoutMs = policy.maxResetTimeoutMs ?? policy.resetTimeoutMs;
    this.#clock = clock;
  }

  get state(): BreakerState {
    // Recompute lazily: nothing schedules a timer, so the state transition from
    // open to half-open has to happen on read. A timer would keep the process
    // alive and would need clearing on shutdown for no benefit.
    const now = this.#clock.now();
    if (
      this.#state === "open" &&
      this.#nextAttemptAt !== null &&
      now >= this.#nextAttemptAt
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
      // Any answer from the provider is fresh evidence that it is reachable,
      // so the widening ladder is discharged HERE rather than only on a full
      // close. Otherwise a provider that answers one trial and fails the next
      // keeps escalating its own backoff on the strength of an outage that has
      // already partly ended, and the flap it is meant to damp is precisely
      // the case where recovery latency compounds.
      this.#openStreak = 0;
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
