/**
 * Local quota counter, one per provider.
 *
 * This is not the same thing as the rate limiter. The limiter paces requests so
 * we never exceed a per-second ceiling; the quota counter refuses requests once
 * a longer-window budget is spent, and it refuses them *locally* so we learn
 * about exhaustion without spending an upstream call to be told.
 *
 * That distinction matters most for iTunes: about 20 calls/minute with no
 * documented penalty for exceeding it. Being throttled or blocked by Apple has
 * no appeals process, so the safe design is to under-spend deliberately.
 *
 * The window is sliding rather than fixed. A fixed window lets 2x the budget
 * through across a boundary, which is exactly the burst a provider notices.
 */

import type { Clock } from "./types.js";
import { systemClock } from "./types.js";

export interface QuotaPolicy {
  /** Maximum units spendable inside `windowMs`. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface QuotaSnapshot {
  readonly limit: number;
  readonly windowMs: number;
  readonly used: number;
  readonly remaining: number;
  /** When the oldest unit in the window ages out, or null if nothing is spent. */
  readonly resetsAt: number | null;
  readonly rejected: number;
}

export class QuotaCounter {
  #limit: number;
  #windowMs: number;
  readonly #clock: Clock;
  /** Spend timestamps, oldest first. Bounded by `limit`, so it cannot grow. */
  #spends: number[] = [];
  #rejected = 0;

  constructor(policy: QuotaPolicy, clock: Clock = systemClock) {
    if (policy.limit < 1) throw new Error("quota limit must be >= 1");
    if (policy.windowMs < 1) throw new Error("quota windowMs must be >= 1");
    this.#limit = policy.limit;
    this.#windowMs = policy.windowMs;
    this.#clock = clock;
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (drop < this.#spends.length) {
      const t = this.#spends[drop];
      if (t === undefined || t > cutoff) break;
      drop++;
    }
    if (drop > 0) this.#spends = this.#spends.slice(drop);
  }

  snapshot(): QuotaSnapshot {
    const now = this.#clock.now();
    this.#prune(now);
    const oldest = this.#spends[0];
    return {
      limit: this.#limit,
      windowMs: this.#windowMs,
      used: this.#spends.length,
      remaining: Math.max(0, this.#limit - this.#spends.length),
      resetsAt: oldest === undefined ? null : oldest + this.#windowMs,
      rejected: this.#rejected,
    };
  }

  /** Spends `cost` units if the budget allows. Returns false without spending. */
  tryConsume(cost = 1): boolean {
    const now = this.#clock.now();
    this.#prune(now);
    if (this.#spends.length + cost > this.#limit) {
      this.#rejected++;
      return false;
    }
    for (let i = 0; i < cost; i++) this.#spends.push(now);
    return true;
  }

  /**
   * Adopts a budget the provider itself just told us about.
   *
   * ListenBrainz publishes no numeric limit anywhere and their documentation
   * says the client must read `X-RateLimit-*` from each response to learn it.
   * A hard-coded constant is therefore a guess that fails SILENTLY if they ever
   * lower the real limit: we would keep spending against a budget that no
   * longer exists and find out through 429s.
   *
   * Only ever narrows or widens the policy; it does not forgive spends already
   * made. If the new limit is below what is already spent inside the window,
   * the counter is simply full, which is the correct and conservative reading.
   *
   * Returns true when the policy actually changed, so a caller can log a
   * provider quietly tightening its limits.
   */
  retune(policy: QuotaPolicy): boolean {
    if (policy.limit < 1 || policy.windowMs < 1) return false;
    if (policy.limit === this.#limit && policy.windowMs === this.#windowMs) {
      return false;
    }
    this.#limit = policy.limit;
    this.#windowMs = policy.windowMs;
    // A shortened window may have aged spends out already.
    this.#prune(this.#clock.now());
    return true;
  }

  /** Milliseconds until at least one unit frees up. 0 when budget is available. */
  msUntilAvailable(): number {
    const now = this.#clock.now();
    this.#prune(now);
    if (this.#spends.length < this.#limit) return 0;
    const oldest = this.#spends[0];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + this.#windowMs - now);
  }
}
