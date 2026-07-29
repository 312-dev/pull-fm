/**
 * Postgres CrosswalkStore over `mbid_crosswalk`.
 *
 * The fuzzy path uses pg_trgm's `%` operator so the GIN index
 * (`crosswalk_trgm_idx`) is used, then re-checks with `similarity()` against
 * our own threshold. Filtering on `similarity() > $x` alone would not use the
 * index and would degrade into a sequential scan of the whole crosswalk, which
 * is precisely the table that grows forever.
 *
 * `set_limit()` is session state in pg_trgm, so it is deliberately NOT set
 * here: on a PgBouncer transaction-mode pool the session that receives it is
 * not the session that runs the next query.
 */

import type { Queryable } from "../cache/pg-store.js";
import type {
  CrosswalkEntity,
  CrosswalkHit,
  CrosswalkRecord,
  CrosswalkStore,
} from "./store.js";

interface Row {
  normalized_key: unknown;
  mbid: unknown;
  confidence: unknown;
  source: unknown;
  similarity?: unknown;
}

function toNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toHit(
  entityType: CrosswalkEntity,
  row: Row,
  matchedBy: "exact" | "fuzzy",
): CrosswalkHit | null {
  if (typeof row.normalized_key !== "string" || typeof row.mbid !== "string") {
    return null;
  }
  return {
    entityType,
    normalizedKey: row.normalized_key,
    mbid: row.mbid,
    confidence: toNumber(row.confidence, 1),
    source: typeof row.source === "string" ? row.source : "unknown",
    matchedBy,
    similarity: matchedBy === "exact" ? 1 : toNumber(row.similarity, 0),
  };
}

export class PgCrosswalkStore implements CrosswalkStore {
  constructor(private readonly db: Queryable) {}

  async lookupExact(
    entityType: CrosswalkEntity,
    normalizedKey: string,
  ): Promise<CrosswalkHit | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT normalized_key, mbid::text AS mbid, confidence, source
         FROM mbid_crosswalk
        WHERE entity_type = $1 AND normalized_key = $2`,
      [entityType, normalizedKey],
    );
    const row = rows[0];
    return row === undefined ? null : toHit(entityType, row, "exact");
  }

  async lookupFuzzy(
    entityType: CrosswalkEntity,
    normalizedKey: string,
    minSimilarity: number,
  ): Promise<CrosswalkHit | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT normalized_key, mbid::text AS mbid, confidence, source,
              similarity(normalized_key, $2) AS similarity
         FROM mbid_crosswalk
        WHERE entity_type = $1
          AND normalized_key % $2
          AND similarity(normalized_key, $2) >= $3
        ORDER BY similarity DESC, confidence DESC
        LIMIT 1`,
      [entityType, normalizedKey, minSimilarity],
    );
    const row = rows[0];
    return row === undefined ? null : toHit(entityType, row, "fuzzy");
  }

  /**
   * The search path. Same index-first shape as lookupFuzzy: `%` narrows using
   * the GIN index, `similarity()` re-checks against our own threshold. A bare
   * `similarity() >= $x` predicate cannot use the index and degrades into a
   * sequential scan of the table that grows forever.
   *
   * `limit` is clamped here rather than trusted from the caller, because this
   * is reachable from a query string and an unbounded LIMIT is an API4 finding
   * even when the route also validates it.
   */
  async search(
    entityType: CrosswalkEntity,
    normalizedKey: string,
    minSimilarity: number,
    limit: number,
  ): Promise<CrosswalkHit[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT normalized_key, mbid::text AS mbid, confidence, source,
              similarity(normalized_key, $2) AS similarity
         FROM mbid_crosswalk
        WHERE entity_type = $1
          AND normalized_key % $2
          AND similarity(normalized_key, $2) >= $3
        ORDER BY similarity DESC, confidence DESC
        LIMIT $4`,
      [
        entityType,
        normalizedKey,
        minSimilarity,
        Math.min(Math.max(1, Math.trunc(limit)), 50),
      ],
    );
    return rows
      .map((row) => toHit(entityType, row, "fuzzy"))
      .filter((hit): hit is CrosswalkHit => hit !== null);
  }

  /**
   * MBID -> the key we learned it under. Uses `crosswalk_mbid_idx`.
   *
   * Several names can map to one MBID (aliases, misspellings, a fuzzy match
   * that landed correctly), so the most confident row wins: it is the closest
   * thing to a canonical name this table holds.
   */
  async lookupByMbid(
    entityType: CrosswalkEntity,
    mbid: string,
  ): Promise<CrosswalkHit | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT normalized_key, mbid::text AS mbid, confidence, source
         FROM mbid_crosswalk
        WHERE entity_type = $1 AND mbid = $2::uuid
        ORDER BY confidence DESC
        LIMIT 1`,
      [entityType, mbid],
    );
    const row = rows[0];
    return row === undefined ? null : toHit(entityType, row, "exact");
  }

  async record(entry: CrosswalkRecord): Promise<void> {
    // A more confident resolution supersedes a less confident one; equal or
    // worse leaves the existing row alone, so a fuzzy match can never overwrite
    // an exact one that a previous run established.
    await this.db.query(
      `INSERT INTO mbid_crosswalk (entity_type, normalized_key, mbid, confidence, source)
       VALUES ($1, $2, $3::uuid, $4, $5)
       ON CONFLICT (entity_type, normalized_key) DO UPDATE
          SET mbid = EXCLUDED.mbid,
              confidence = EXCLUDED.confidence,
              source = EXCLUDED.source
        WHERE EXCLUDED.confidence > mbid_crosswalk.confidence`,
      [
        entry.entityType,
        entry.normalizedKey,
        entry.mbid,
        entry.confidence,
        entry.source,
      ],
    );
  }
}
