/**
 * Postgres-backed CacheStore over `upstream_cache`.
 *
 * Typed against a minimal `Queryable` rather than `pg.Pool` on purpose: this
 * package has no runtime dependencies, the BFF owns the pool, and a two-method
 * interface is trivially fakeable in a test. Any `pg` Pool or PoolClient
 * satisfies it structurally.
 *
 * Sizes come from `cache_size_by_provider`, which is defined in
 * 0001_initial.sql as `sum(pg_column_size(payload))`. That includes TOAST
 * overhead, so it over-reports slightly - the safe direction to err when the
 * number is being compared against a licence cap.
 */

import type { ProviderName } from "../types.js";
import type {
  CacheEntry,
  CacheSize,
  CacheStore,
  EvictionReport,
} from "./store.js";

export interface QueryResult<R> {
  rows: R[];
}

export interface Queryable {
  /**
   * The generic lets each call site name the row shape it expects, exactly as
   * `pg` does; any Pool or PoolClient satisfies this structurally.
   */
  query<R>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R> & { readonly rowCount?: number | null }>;
}

/** Postgres returns bigint and numeric as strings to avoid precision loss. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toTime(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface CacheRow {
  payload: unknown;
  fetched_at: unknown;
  expires_at: unknown;
  hit_count: unknown;
}

export class PgCacheStore implements CacheStore {
  constructor(private readonly db: Queryable) {}

  async get(provider: ProviderName, key: string): Promise<CacheEntry | null> {
    // The hit counters are maintained in the same statement that reads the row.
    // A separate UPDATE would double the round trips on the hottest path in the
    // system, and would let LRU eviction see stale recency under load.
    const { rows } = await this.db.query<CacheRow>(
      `UPDATE upstream_cache
          SET hit_count = hit_count + 1, last_hit_at = now()
        WHERE provider = $1 AND cache_key = $2
      RETURNING payload, fetched_at, expires_at, hit_count`,
      [provider, key],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      payload: row.payload,
      fetchedAt: toTime(row.fetched_at) ?? Date.now(),
      expiresAt: toTime(row.expires_at),
      hitCount: toNumber(row.hit_count),
    };
  }

  async set(
    provider: ProviderName,
    key: string,
    payload: unknown,
    ttlSeconds: number | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO upstream_cache (provider, cache_key, payload, fetched_at, expires_at)
       VALUES ($1, $2, $3::jsonb, now(),
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $4::int) END)
       ON CONFLICT (provider, cache_key) DO UPDATE
          SET payload = EXCLUDED.payload,
              fetched_at = EXCLUDED.fetched_at,
              expires_at = EXCLUDED.expires_at`,
      [provider, key, JSON.stringify(payload), ttlSeconds],
    );
  }

  async delete(provider: ProviderName, key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM upstream_cache WHERE provider = $1 AND cache_key = $2`,
      [provider, key],
    );
  }

  async sizeOf(provider: ProviderName): Promise<CacheSize> {
    const { rows } = await this.db.query<{ entries: unknown; bytes: unknown }>(
      `SELECT entries, bytes FROM cache_size_by_provider WHERE provider = $1`,
      [provider],
    );
    const row = rows[0];
    if (row === undefined) return { provider, entries: 0, bytes: 0 };
    return {
      provider,
      entries: toNumber(row.entries),
      bytes: toNumber(row.bytes),
    };
  }

  async evictLru(
    provider: ProviderName,
    bytesToFree: number,
  ): Promise<EvictionReport> {
    // Ordering by last_hit_at NULLS FIRST matches upstream_cache_lru_idx, so
    // this is an index scan rather than a sort over the whole provider's rows.
    // The running total inside the CTE is what makes "free at least N bytes"
    // one statement instead of a read-then-delete loop that races itself.
    const { rows } = await this.db.query<{ freed: unknown; evicted: unknown }>(
      `WITH ranked AS (
         SELECT provider, cache_key, pg_column_size(payload) AS bytes,
                sum(pg_column_size(payload)) OVER (
                  ORDER BY last_hit_at NULLS FIRST, fetched_at
                ) AS running
           FROM upstream_cache
          WHERE provider = $1
       ), doomed AS (
         SELECT provider, cache_key, bytes FROM ranked
          WHERE running - bytes < $2::bigint
       ), gone AS (
         DELETE FROM upstream_cache c
          USING doomed d
          WHERE c.provider = d.provider AND c.cache_key = d.cache_key
        RETURNING d.bytes
       )
       SELECT coalesce(sum(bytes), 0) AS freed, count(*) AS evicted FROM gone`,
      [provider, bytesToFree],
    );
    const row = rows[0];
    return {
      provider,
      evicted: toNumber(row?.evicted),
      bytesFreed: toNumber(row?.freed),
    };
  }
}
