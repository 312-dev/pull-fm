/**
 * The cache contract.
 *
 * Cache-first is the architecture, not an optimisation: MusicBrainz allows 1
 * req/s globally and iTunes about 20 calls/min, so a synchronous read-through
 * to either cannot serve more than a few hundred users (docs/PLAN.md section 3).
 *
 * `sizeOf` and `evictLru` are part of the interface rather than an admin script
 * because Last.fm's ToS 4.3.4 caps cached Last.fm data at 100 MB. A cap we
 * cannot measure from inside the request path is a cap we will exceed.
 */

import type { ProviderName } from "../types.js";

export interface CacheEntry {
  readonly payload: unknown;
  readonly fetchedAt: number;
  /** null means "never expires" (ReccoBeats, iTunes preview URLs). */
  readonly expiresAt: number | null;
  readonly hitCount: number;
}

export interface CacheSize {
  readonly provider: ProviderName;
  readonly entries: number;
  readonly bytes: number;
}

export interface EvictionReport {
  readonly provider: ProviderName;
  readonly evicted: number;
  readonly bytesFreed: number;
}

export interface CacheStore {
  /** Returns the entry even when expired; the caller decides. Records a hit. */
  get(provider: ProviderName, key: string): Promise<CacheEntry | null>;
  set(
    provider: ProviderName,
    key: string,
    payload: unknown,
    ttlSeconds: number | null,
  ): Promise<void>;
  delete(provider: ProviderName, key: string): Promise<void>;
  /** Reads the `cache_size_by_provider` view (or its equivalent). */
  sizeOf(provider: ProviderName): Promise<CacheSize>;
  /** Evicts least-recently-hit rows until at least `bytesToFree` is reclaimed. */
  evictLru(
    provider: ProviderName,
    bytesToFree: number,
  ): Promise<EvictionReport>;
}
