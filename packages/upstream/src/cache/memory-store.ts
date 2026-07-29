/**
 * In-memory CacheStore.
 *
 * Exists for tests and for local development without Postgres. Its byte
 * accounting deliberately mirrors what `pg_column_size(payload)` measures - the
 * serialized JSON - so a cap test written against this store is meaningful
 * about the store that actually enforces the licence.
 */

import { KEY_SEPARATOR } from "../normalize.js";
import type { ProviderName } from "../types.js";
import type {
  CacheEntry,
  CacheSize,
  CacheStore,
  EvictionReport,
} from "./store.js";

interface Row {
  payload: unknown;
  bytes: number;
  fetchedAt: number;
  expiresAt: number | null;
  hitCount: number;
  lastHitAt: number | null;
}

export function approximatePayloadBytes(payload: unknown): number {
  // `payload ?? null` because JSON.stringify(undefined) is undefined, not "null",
  // and a cache row whose size is NaN silently defeats the licence cap.
  return Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
}

export class MemoryCacheStore implements CacheStore {
  readonly #rows = new Map<string, Row>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  #id(provider: ProviderName, key: string): string {
    return `${provider}${KEY_SEPARATOR}${key}`;
  }

  get(provider: ProviderName, key: string): Promise<CacheEntry | null> {
    const row = this.#rows.get(this.#id(provider, key));
    if (row === undefined) return Promise.resolve(null);
    row.hitCount++;
    row.lastHitAt = this.#now();
    return Promise.resolve({
      payload: row.payload,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      hitCount: row.hitCount,
    });
  }

  set(
    provider: ProviderName,
    key: string,
    payload: unknown,
    ttlSeconds: number | null,
  ): Promise<void> {
    const now = this.#now();
    this.#rows.set(this.#id(provider, key), {
      payload,
      bytes: approximatePayloadBytes(payload),
      fetchedAt: now,
      expiresAt: ttlSeconds === null ? null : now + ttlSeconds * 1000,
      hitCount: 0,
      lastHitAt: null,
    });
    return Promise.resolve();
  }

  delete(provider: ProviderName, key: string): Promise<void> {
    this.#rows.delete(this.#id(provider, key));
    return Promise.resolve();
  }

  sizeOf(provider: ProviderName): Promise<CacheSize> {
    let entries = 0;
    let bytes = 0;
    const prefix = `${provider}${KEY_SEPARATOR}`;
    for (const [id, row] of this.#rows) {
      if (!id.startsWith(prefix)) continue;
      entries++;
      bytes += row.bytes;
    }
    return Promise.resolve({ provider, entries, bytes });
  }

  evictLru(
    provider: ProviderName,
    bytesToFree: number,
  ): Promise<EvictionReport> {
    const prefix = `${provider}${KEY_SEPARATOR}`;
    const candidates: { id: string; row: Row }[] = [];
    for (const [id, row] of this.#rows) {
      if (id.startsWith(prefix)) candidates.push({ id, row });
    }
    // Never-hit rows go first: a cached payload nothing ever read is pure cost.
    candidates.sort(
      (a, b) =>
        (a.row.lastHitAt ?? -1) - (b.row.lastHitAt ?? -1) ||
        a.row.fetchedAt - b.row.fetchedAt,
    );

    let evicted = 0;
    let bytesFreed = 0;
    for (const c of candidates) {
      if (bytesFreed >= bytesToFree) break;
      this.#rows.delete(c.id);
      evicted++;
      bytesFreed += c.row.bytes;
    }
    return Promise.resolve({ provider, evicted, bytesFreed });
  }

  /** Test helper: total rows across providers. */
  get size(): number {
    return this.#rows.size;
  }
}
