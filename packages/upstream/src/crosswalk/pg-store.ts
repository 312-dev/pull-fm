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
