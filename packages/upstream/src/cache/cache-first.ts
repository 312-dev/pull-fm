/**
 * Cache-first read-through.
 *
 * Two behaviours here are not obvious and both are deliberate:
 *
 * 1. STALE-ON-ERROR. When a cached entry has expired but the upstream refresh
 *    fails, the stale payload is served rather than the error. An expired
 *    similar-artist list is a far better answer than an empty shelf, and it is
 *    what keeps a provider outage from emptying the feed. The result carries
 *    `stale: true` so the caller can still mark the response degraded.
 *
 * 2. POISON EVICTION. If a cached payload no longer parses, the row is deleted
 *    and the upstream is re-fetched once. Otherwise a provider's schema change
 *    would keep serving the same unparseable row from cache until its TTL,
 *    turning a transient incompatibility into a persistent outage.
 *
 * The hit-rate counters exist because Gate 2 requires a warm hit rate above
 * 90%, and a number nobody records is a gate nobody can pass.
 */

import { UpstreamError, isUpstreamError } from "../errors.js";
import { MalformedPayloadError } from "../json.js";
import type { ProviderName } from "../types.js";
import type { CacheGovernor } from "./governor.js";
import type { CacheStore } from "./store.js";

export interface CacheFirstSpec<T> {
  readonly provider: ProviderName;
  readonly key: string;
  /** null caches permanently: ReccoBeats features, resolved MBIDs. */
  readonly ttlSeconds: number | null;
  /** Fetches the raw payload from the provider. Only called on a miss. */
  readonly load: () => Promise<unknown>;
  /** Maps a raw payload (fresh or cached) to the typed value. Must be pure. */
  readonly parse: (payload: unknown) => T;
  /** Skips the cache read but still writes. For a forced refresh. */
  readonly refresh?: boolean;
}

export interface CacheFirstResult<T> {
  readonly value: T;
  readonly hit: boolean;
  /** True when the entry was past its TTL and the refresh failed. */
  readonly stale: boolean;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly poisoned: number;
  /** Hits over total lookups. The Gate 2 number. */
  readonly hitRate: number;
}

export class CachedUpstream {
  readonly #store: CacheStore;
  readonly #governor: CacheGovernor | undefined;
  readonly #now: () => number;
  readonly #counters = new Map<
    ProviderName,
    { hits: number; misses: number; stale: number; poisoned: number }
  >();

  constructor(
    store: CacheStore,
    opts: { governor?: CacheGovernor; now?: () => number } = {},
  ) {
    this.#store = store;
    this.#governor = opts.governor;
    this.#now = opts.now ?? (() => Date.now());
  }

  stats(provider: ProviderName): CacheStats {
    const c = this.#counters.get(provider) ?? {
      hits: 0,
      misses: 0,
      stale: 0,
      poisoned: 0,
    };
    const total = c.hits + c.misses;
    return { ...c, hitRate: total === 0 ? 0 : c.hits / total };
  }

  #bump(
    provider: ProviderName,
    field: "hits" | "misses" | "stale" | "poisoned",
  ): void {
    const c = this.#counters.get(provider) ?? {
      hits: 0,
      misses: 0,
      stale: 0,
      poisoned: 0,
    };
    c[field]++;
    this.#counters.set(provider, c);
  }

  async fetch<T>(spec: CacheFirstSpec<T>): Promise<CacheFirstResult<T>> {
    let expiredPayload: unknown;
    let hasExpiredPayload = false;

    if (spec.refresh !== true) {
      const entry = await this.#store.get(spec.provider, spec.key);
      if (entry !== null) {
        const expired =
          entry.expiresAt !== null && entry.expiresAt <= this.#now();
        if (!expired) {
          try {
            const value = spec.parse(entry.payload);
            this.#bump(spec.provider, "hits");
            return { value, hit: true, stale: false };
          } catch (err) {
            if (!(err instanceof MalformedPayloadError)) throw err;
            this.#bump(spec.provider, "poisoned");
            await this.#store.delete(spec.provider, spec.key);
          }
        } else {
          expiredPayload = entry.payload;
          hasExpiredPayload = true;
        }
      }
    }

    this.#bump(spec.provider, "misses");

    let payload: unknown;
    try {
      payload = await spec.load();
    } catch (err) {
      if (hasExpiredPayload) {
        try {
          const value = spec.parse(expiredPayload);
          this.#bump(spec.provider, "stale");
          return { value, hit: true, stale: true };
        } catch {
          // Stale entry is unusable too; the original failure is the real news.
        }
      }
      throw err;
    }

    const value = spec.parse(payload);
    await this.#store.set(spec.provider, spec.key, payload, spec.ttlSeconds);
    if (this.#governor !== undefined) {
      await this.#governor.afterWrite(spec.provider);
    }
    return { value, hit: false, stale: false };
  }

  /**
   * Cache-only read. Used by anything that must not touch an upstream, such as
   * feed assembly under a tight deadline or a provider whose kill switch is off.
   */
  async peek<T>(
    provider: ProviderName,
    key: string,
    parse: (payload: unknown) => T,
  ): Promise<T | null> {
    const entry = await this.#store.get(provider, key);
    if (entry === null) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) return null;
    try {
      return parse(entry.payload);
    } catch (err) {
      if (err instanceof MalformedPayloadError) return null;
      throw err;
    }
  }
}

/** True when a failure should degrade the feed rather than fail the request. */
export function isDegradation(err: unknown): err is UpstreamError {
  return isUpstreamError(err) && err.isDegradation;
}
