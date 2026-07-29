/**
 * The global per-IP limiter's counter store, moved into the quota Redis.
 *
 * WHAT WAS WRONG
 * --------------
 * `@fastify/rate-limit` was registered with neither `redis` nor `store`, so it
 * used its default `LocalStore`: an in-process LRU capped at 5,000 entries.
 * security/AUDIT-2026-07-29.md F12 DEMONSTRATED the consequence rather than
 * theorising it - interleaving requests from 5,600 distinct addresses evicts the
 * attacker's own throttled counter and restores a full budget:
 *
 *     A: hits 1-4 (max=3)                      200 200 200 429
 *     A: is it latched at 429?                 429
 *     distinct rotating source addresses       5600
 *     A: hits again after the rotation         200 200 200 429   <- restored
 *
 * With IPv6 that is free: one /64 holds more addresses than the cache can. The
 * counters were also lost on every container swap, and the deploy timer fires
 * every sixty seconds.
 *
 * This is THREAT-MODEL T11 wearing different clothes. T11 is "rate-limit
 * counters evicted, silently disabling rate limiting", and the two-Redis design
 * exists precisely to prevent it - but that design never applied here, because
 * this limiter was not in Redis at all. The comment above the registration
 * reassured the reader that per-credential budgets live in the `noeviction`
 * instance "so it cannot be silently disabled by cache pressure", which was true
 * of the per-token limiter and said nothing about the one directly below it.
 *
 * WHY A CUSTOM STORE RATHER THAN THE PLUGIN'S `redis` OPTION
 * ---------------------------------------------------------
 * Two reasons, both about what happens when the store breaks.
 *
 *   The plugin's own `RedisStore` defines its Lua under a name on the shared
 *   client and keys everything under `fastify-rate-limit-`. This one reuses
 *   `incrementWindow`, so there is ONE fixed-window increment in this codebase
 *   and the global limiter, the per-token limiter and the Magic Auth budgets all
 *   count the same way and key the same way (`quota:...`).
 *
 *   A store error has to be OBSERVABLE. `skipOnError` already defaults to false
 *   in this version, so the plugin fails closed on its own - but it fails closed
 *   as an unhandled error, which lands as a generic 500 that nothing counts.
 *   That is the exact shape of the defect the per-token limiter already had and
 *   had fixed: a fail-closed branch that was correct and invisible. Here the
 *   refusal calls `onFailClosed` and surfaces as the same 503 every other
 *   quota-store failure produces.
 */

import type { FastifyRateLimitStoreCtor } from "@fastify/rate-limit";
import type { Redis } from "ioredis";

import { errors } from "./errors.js";
import { incrementWindow } from "./redis.js";

/** What `@fastify/rate-limit` calls back with. `ttl` is MILLISECONDS. */
export interface RateLimitCount {
  readonly current: number;
  readonly ttl: number;
}

export type RateLimitCallback = (
  err: Error | null,
  result: RateLimitCount | null,
) => void;

/** The shape `@fastify/rate-limit` requires of a `store`. */
export interface RateLimitStore {
  incr(
    key: string,
    cb: RateLimitCallback,
    timeWindowMs: number,
    max: number,
  ): void;
  child(routeOptions: {
    routeInfo?: { method?: string; url?: string };
  }): RateLimitStore;
}

export interface QuotaRateLimitStoreOptions {
  /** The `noeviction` instance. Never the cache: that is the whole point. */
  readonly redis: Redis;
  /** Fired when the counter could not be written and the request is refused. */
  readonly onFailClosed?: () => void;
}

/**
 * Builds the store CLASS the plugin expects.
 *
 * `@fastify/rate-limit` constructs the store itself (`new Store(params)`), so
 * there is no argument through which to hand it a Redis client. A closure over
 * the client is the seam that exists.
 *
 * The published `FastifyRateLimitStore` type declares `incr(key, callback)`,
 * while the runtime calls `incr(key, callback, timeWindow, max)` and cannot work
 * without the extra two: a store that ignored `timeWindow` would invent its own
 * window and silently disagree with the configured one. The type is behind the
 * implementation, so the cast is at the boundary, once, with `RateLimitStore`
 * above documenting the shape the runtime actually requires.
 */
export function quotaRateLimitStore(
  opts: QuotaRateLimitStoreOptions,
): FastifyRateLimitStoreCtor {
  class QuotaRateLimitStore implements RateLimitStore {
    readonly #prefix: string;

    constructor(_params: unknown, prefix = "quota:ip:") {
      this.#prefix = prefix;
    }

    incr(
      key: string,
      cb: RateLimitCallback,
      timeWindowMs: number,
      _max: number,
    ): void {
      // The window is a whole number of seconds because `EXPIRE` is. A
      // sub-second window would round to zero and produce a key with no TTL,
      // which is a permanent counter rather than a limiter.
      const windowSeconds = Math.max(1, Math.ceil(timeWindowMs / 1000));
      const windowIndex = Math.floor(Date.now() / 1000 / windowSeconds);
      const redisKey = `${this.#prefix}${key}:${String(windowIndex)}`;

      incrementWindow(opts.redis, redisKey, windowSeconds).then(
        ({ count, ttlSeconds }) => {
          cb(null, { current: count, ttl: ttlSeconds * 1000 });
        },
        (_err: unknown) => {
          // A limiter that fails open is not a limiter. Counted and logged by
          // the caller, so a dead quota store is an alert rather than an
          // unexplained 5xx spike.
          opts.onFailClosed?.();
          cb(errors.upstreamUnavailable("rate limiter"), null);
        },
      );
    }

    /**
     * Per-route override support.
     *
     * Nothing registers a per-route limit today. Implemented anyway because the
     * plugin calls this the moment one does, and a store that throws here would
     * turn adding a route-level limit into an outage.
     */
    child(routeOptions: {
      routeInfo?: { method?: string; url?: string };
    }): RateLimitStore {
      const method = routeOptions.routeInfo?.method ?? "ALL";
      const url = routeOptions.routeInfo?.url ?? "*";
      return new QuotaRateLimitStore(null, `${this.#prefix}${method}${url}:`);
    }
  }

  return QuotaRateLimitStore as unknown as FastifyRateLimitStoreCtor;
}
