/**
 * Storage for the MBID crosswalk (`mbid_crosswalk`).
 *
 * Every successful resolution is recorded permanently, which is what makes the
 * hit rate improve over time and is why Gate 2's >90% warm hit rate is
 * reachable at all. Rows are never invalidated: an MBID for a given normalised
 * name does not stop being correct.
 */

import { KEY_SEPARATOR, trigramSimilarity } from "../normalize.js";

export type CrosswalkEntity = "artist" | "recording" | "release";

export interface CrosswalkHit {
  readonly entityType: CrosswalkEntity;
  readonly normalizedKey: string;
  readonly mbid: string;
  readonly confidence: number;
  readonly source: string;
  /** How the row was found. Drives the Gate 2 exact-vs-fuzzy breakdown. */
  readonly matchedBy: "exact" | "fuzzy";
  /** Trigram similarity for a fuzzy match; 1 for an exact one. */
  readonly similarity: number;
}

export interface CrosswalkRecord {
  readonly entityType: CrosswalkEntity;
  readonly normalizedKey: string;
  readonly mbid: string;
  readonly confidence: number;
  readonly source: string;
}

export interface CrosswalkStore {
  lookupExact(
    entityType: CrosswalkEntity,
    normalizedKey: string,
  ): Promise<CrosswalkHit | null>;
  lookupFuzzy(
    entityType: CrosswalkEntity,
    normalizedKey: string,
    minSimilarity: number,
  ): Promise<CrosswalkHit | null>;
  record(entry: CrosswalkRecord): Promise<void>;
}

export class MemoryCrosswalkStore implements CrosswalkStore {
  readonly #rows = new Map<string, CrosswalkRecord>();

  #id(entityType: CrosswalkEntity, key: string): string {
    return `${entityType}${KEY_SEPARATOR}${key}`;
  }

  lookupExact(
    entityType: CrosswalkEntity,
    normalizedKey: string,
  ): Promise<CrosswalkHit | null> {
    const row = this.#rows.get(this.#id(entityType, normalizedKey));
    return Promise.resolve(
      row === undefined ? null : { ...row, matchedBy: "exact", similarity: 1 },
    );
  }

  lookupFuzzy(
    entityType: CrosswalkEntity,
    normalizedKey: string,
    minSimilarity: number,
  ): Promise<CrosswalkHit | null> {
    let best: CrosswalkHit | null = null;
    for (const [id, row] of this.#rows) {
      if (!id.startsWith(`${entityType}${KEY_SEPARATOR}`)) continue;
      const similarity = trigramSimilarity(normalizedKey, row.normalizedKey);
      if (similarity < minSimilarity) continue;
      if (best === null || similarity > best.similarity) {
        best = { ...row, matchedBy: "fuzzy", similarity };
      }
    }
    return Promise.resolve(best);
  }

  record(entry: CrosswalkRecord): Promise<void> {
    const id = this.#id(entry.entityType, entry.normalizedKey);
    const existing = this.#rows.get(id);
    // UNIQUE (entity_type, normalized_key) in the schema: first write wins
    // unless the new one is more confident, mirroring the resolver's upsert.
    if (existing === undefined || entry.confidence > existing.confidence) {
      this.#rows.set(id, entry);
    }
    return Promise.resolve();
  }

  get size(): number {
    return this.#rows.size;
  }
}
