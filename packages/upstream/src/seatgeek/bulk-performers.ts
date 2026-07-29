/**
 * Parser for SeatGeek's bulk *performers* dump (hourly JSONL via
 * GET /2/bulk/download_url?entity=performers).
 *
 * WHY ONLY PERFORMERS, AND WHY NOT A FULL SYNC
 * --------------------------------------------
 * Since 2026-01-01 `/events` caps result sets at 10,000, and SeatGeek offers a
 * bulk download and an hourly delta feed to work around it. We deliberately do
 * not use either for events: Pull.fm asks "is this artist playing near me",
 * which is a narrow per-performer query that the cap does not reach. Syncing
 * 34,000+ concerts hourly to answer it would be a large amount of state to
 * maintain for no gain.
 *
 * The performers dump is different, and is the one piece worth having: slug
 * guessing is unreliable (`performers.slug=radiohead` returns 0 results), so
 * today every unknown artist costs a fuzzy `q` search. One dump gives an
 * offline name -> performer id crosswalk, after which every lookup is an exact
 * id query. Performers change far more slowly than events, so weekly is plenty.
 *
 * DECISION FOR THE FIRST PASS: the dump job is NOT scheduled. Per-MBID performer
 * ids are cached for 30 days on first resolution, which reaches the same steady
 * state for the artists we actually surface, without a new job, new storage, or
 * a new failure mode. This parser exists so the backfill is a scheduler entry
 * and not a design exercise: feed it dump lines and write the results into the
 * same `seatgeek performer:<mbid>` cache keys the live path reads.
 *
 * SHAPE WARNING: the bulk schema is NOT the /events response schema (SeatGeek
 * publish a field-by-field diff). This parser handles bulk rows only. Do not
 * point it at an API response, and do not point the API parser at a dump.
 */

import { isRecord, optNumber, optString } from "../json.js";
import { normalizeKey } from "../normalize.js";

export interface BulkPerformer {
  readonly id: number;
  readonly name: string;
  readonly slug: string | undefined;
  readonly taxonomyId: number | undefined;
  /** Crosswalk key, produced by the same normaliser the MBID crosswalk uses. */
  readonly normalizedKey: string;
  readonly updatedAtUtc: string | undefined;
}

/** Parses one JSONL line. Returns null for blanks and unusable rows. */
export function parseBulkPerformerLine(line: string): BulkPerformer | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    // A dump is millions of lines; one bad line must not abort an import.
    return null;
  }
  return parseBulkPerformer(value);
}

export function parseBulkPerformer(value: unknown): BulkPerformer | null {
  if (!isRecord(value)) return null;
  const id = optNumber(value, "id");
  const name = optString(value, "name");
  if (id === undefined || name === undefined) return null;
  const normalizedKey = normalizeKey(name);
  if (normalizedKey === "") return null;
  return {
    id,
    name,
    slug: optString(value, "slug"),
    taxonomyId: optNumber(value, "taxonomy_id"),
    normalizedKey,
    updatedAtUtc: optString(value, "updated_at_utc"),
  };
}

/**
 * Builds a name -> performer id index from dump lines.
 *
 * On a normalised-name collision the LOWER id wins. SeatGeek ids are broadly
 * ascending by creation, so the lower one is the long-established performer
 * rather than a newer tribute act or a duplicate created by an import.
 */
export function indexBulkPerformers(
  lines: Iterable<string>,
): Map<string, BulkPerformer> {
  const index = new Map<string, BulkPerformer>();
  for (const line of lines) {
    const performer = parseBulkPerformerLine(line);
    if (performer === null) continue;
    const existing = index.get(performer.normalizedKey);
    if (existing === undefined || performer.id < existing.id) {
      index.set(performer.normalizedKey, performer);
    }
  }
  return index;
}
