/**
 * Reads `mb.canonical`, the local copy of the MusicBrainz canonical dump.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR: MAKING A COLD LOOKUP ANSWERABLE AT ALL
 *
 * MusicBrainz allows one request per second for the whole service, so the
 * request path is not permitted to call it and does not: every MusicBrainz read
 * in the BFF goes through `CachedUpstream.peek`, which reads the cache table and
 * never calls out. A miss returns null and the item is dropped, so an entity the
 * background warmer has not reached yet is not slow, it is missing - and at
 * 1 req/s the warmer covers a working set, never a catalogue.
 *
 * This store is the answer to that miss. It is NOT a rate-limiting fix and must
 * not be described as one; nothing on the request path reaches MusicBrainz to be
 * rate limited in the first place.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUERY HERE IS AN OPTIMISATION AND NONE OF THEM IS AUTHORITATIVE
 *
 * A miss is not an answer. `null` means "not locally answerable", never "this
 * recording does not exist", and the caller must fall through to whatever it did
 * before rather than record a negative. That distinction is the
 * whole safety argument for the feature: the worst outcome of anything going
 * wrong in this file - a missing schema, a half-loaded table, a key we folded
 * differently to the dump - is that the system behaves exactly as it did before
 * the table existed.
 *
 * ---------------------------------------------------------------------------
 * WHY IT TOLERATES THE SCHEMA NOT EXISTING
 *
 * `mb` is excluded from the logical backups on purpose (it is rebuildable from a
 * public URL and paying to dump and restore 20 GB of it in every drill is
 * waste), so a database restored from one of those dumps may have no `mb` schema
 * at all, or an empty one. A restore drill must not turn into an outage because
 * an optimisation's table is missing.
 *
 * So a query that fails because the relation is absent is caught, counted, and
 * turned into a miss, and the store stops asking for a while rather than
 * throwing once per lookup. It re-probes after `unavailableBackoffMs` so that a
 * load which lands afterwards is picked up without a restart - a store that
 * disables itself permanently on first error would need an operator to notice
 * and act, which is exactly the manual step this is meant to remove.
 *
 * A query that fails for any OTHER reason is also turned into a miss, for the
 * same reason: this is an optimisation in front of a working path.
 */

import type { Queryable } from "../cache/pg-store.js";

/** One canonical row, in the shape the MusicBrainz client's parsers produce. */
export interface CanonicalRow {
  readonly recordingMbid: string;
  readonly recordingName: string;
  readonly releaseMbid: string;
  readonly releaseName: string;
  /**
   * The PRIMARY artist of the credit: the first id in `mb.canonical.artist_mbids`.
   *
   * That column is multi-valued for 15.2% of rows - a comma-separated list, not
   * one id - and taking the first is not an approximation. It is the same choice
   * `MusicBrainzClient.parseRecording` makes when it reads
   * `artist-credit[0].artist.id` off the web service, so a local answer and a
   * remote one name the same artist for a collaboration.
   */
  readonly artistMbid: string;
  /** Every artist in the credit, in the dump's order. Usually one. */
  readonly artistMbids: readonly string[];
  readonly artistCreditName: string;
  /**
   * The dump's rank over RELEASES. LOWER IS MORE CANONICAL, and it is not a
   * popularity score despite the name. Meaningful within one artist, not across
   * the catalogue. See the column comment in 0007_mb_canonical.sql.
   */
  readonly score: number;
}

/** The most recent successful load, from `mb.load_state`. */
export interface CanonicalLoadState {
  readonly dumpId: string;
  readonly sha256: string;
  readonly finishedAt: Date;
  readonly rowsLoaded: number;
}

export interface CanonicalStore {
  /** The dump currently being served, or null when nothing is loaded. */
  loadState(): Promise<CanonicalLoadState | null>;
  /** Best row for an exact `combined_lookup`. */
  lookupExact(key: string, limit: number): Promise<CanonicalRow[]>;
  /** Best rows whose `combined_lookup` starts with an artist's folded name. */
  lookupArtistPrefix(
    artistKey: string,
    upperBound: string,
    limit: number,
  ): Promise<CanonicalRow[]>;
  /** The canonical row for a recording MBID, or null when it is not here. */
  lookupRecordingMbid(mbid: string): Promise<CanonicalRow | null>;
  /**
   * Whether an MBID appears in the dump at all, for the given entity.
   *
   * A local index probe that answers "is this a real MusicBrainz id" without a
   * network call, which is the point of indexing `recording_mbid`,
   * `release_mbid` and `artist_mbids` rather than only `combined_lookup`.
   *
   * TRUE IS AUTHORITATIVE AND FALSE IS NOT, and the asymmetry has to be
   * respected by every caller. The canonical dump is a subset of MusicBrainz -
   * one release per recording, nothing that is not a recording - so a real MBID
   * can be absent. `false` therefore means "not known here", and using it to
   * REJECT a request is a policy decision for the route that makes it, not
   * something this store can license.
   */
  exists(
    entity: "recording" | "release" | "artist",
    mbid: string,
  ): Promise<boolean>;
}

export interface PgCanonicalStoreOptions {
  /**
   * How long to stop querying after a failure, in milliseconds.
   *
   * Long enough that a missing schema costs one failed query per interval
   * instead of one per lookup, short enough that a load landing mid-window is
   * picked up without a restart. It bounds a wasted round trip, not a
   * correctness property, so the exact value is not load bearing.
   */
  readonly unavailableBackoffMs?: number;
  /** Injected in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The projection every query shares.
 *
 * Written out rather than `SELECT *` because the column list is the contract
 * with the loader: a dump that changes its columns must fail loudly here rather
 * than silently return a row shape the parsers below misread.
 */
const COLUMNS = `recording_mbid::text AS recording_mbid,
       recording_name,
       release_mbid::text   AS release_mbid,
       release_name,
       artist_mbids,
       artist_credit_name,
       score`;

/**
 * Exact-key lookup.
 *
 * `combined_lookup` is UNIQUE in the published data - 5,156,321 distinct keys
 * across 5,156,321 sampled rows - so this expects at most one answer and the
 * ordering is a tie-break that should never fire. It is still written, and still
 * ASCENDING, because the index is deliberately not declared unique (one
 * collision anywhere in tens of millions of rows would fail the whole load and
 * take the feature offline) and an unordered LIMIT would then return an
 * arbitrary row.
 *
 * ASCENDING is not a typo. See the `score` comment in 0007_mb_canonical.sql: the
 * column is a rank over RELEASES where LOWER IS BETTER, not a popularity score.
 * `ORDER BY score DESC` would consistently pick the least canonical row.
 *
 * Served entirely by `canonical_lookup_idx`, a btree on `(combined_lookup
 * text_pattern_ops, score)`: equality on the leading column plus the second
 * column already in the requested order, so there is no sort.
 */
const EXACT_SQL = `
SELECT ${COLUMNS}
  FROM mb.canonical
 WHERE combined_lookup = $1
 ORDER BY score
 LIMIT $2::int`;

/**
 * Artist-prefix lookup, and the reason the index uses `text_pattern_ops`.
 *
 * The dump builds `combined_lookup` by CONCATENATING the artist credit and the
 * recording name and then normalising, and every step of that normalisation is
 * per character. Normalisation therefore distributes over concatenation, so the
 * folded artist name is exactly a PREFIX of `combined_lookup` for every one of
 * that artist's rows. Finding an artist is a prefix scan.
 *
 * `~>=~` and `~<~` rather than `LIKE` or `>=`/`<`, and this is the one piece of
 * obscure SQL in the file that earns its place:
 *
 *   - `>=` / `<` compare under the DATABASE COLLATION. Under any non-C
 *     collation, string ordering is not byte ordering, so a prefix range is
 *     simply not the set of strings with that prefix. It would return wrong
 *     rows, quietly, on some deployments and not others.
 *   - `LIKE $1 || '%'` is correct but its index use depends on the planner
 *     extracting a prefix from a value it does not know at plan time. A generic
 *     plan there is a sequential scan of tens of millions of rows.
 *   - `~>=~` and `~<~` are the `text_pattern_ops` operators. They compare byte
 *     by byte regardless of collation and are guaranteed to use the index.
 *
 * The upper bound is computed by the caller (`prefixUpperBound`) rather than in
 * SQL, because it depends on the same ASCII guarantee the key does.
 *
 * ASCENDING by `score` for the reason given on the exact lookup: lower is the
 * more canonical release. This is the query where it decides something, since an
 * artist's rows span many releases.
 */
const PREFIX_SQL = `
SELECT ${COLUMNS}
  FROM mb.canonical
 WHERE combined_lookup ~>=~ $1
   AND combined_lookup ~<~  $2
 ORDER BY score
 LIMIT $3::int`;

/**
 * Reverse lookup by recording MBID, served by `canonical_recording_idx`.
 *
 * `LIMIT 1` with an ordering rather than a bare `LIMIT 1`: a recording can in
 * principle appear under more than one release, and taking whichever row the
 * index reached first would make the answer depend on physical layout.
 */
const BY_RECORDING_SQL = `
SELECT ${COLUMNS}
  FROM mb.canonical
 WHERE recording_mbid = $1::uuid
 ORDER BY score
 LIMIT 1`;

/**
 * Existence probes, one per indexed MBID column.
 *
 * A literal per column rather than one parameterised statement, because the
 * column is part of the query plan and cannot be a bind parameter. The map is
 * closed and its keys are a union type, so no caller-supplied string reaches
 * the SQL text.
 */
const EXISTS_SQL: Readonly<Record<string, string>> = {
  recording: `SELECT 1 FROM mb.canonical WHERE recording_mbid = $1::uuid LIMIT 1`,
  release: `SELECT 1 FROM mb.canonical WHERE release_mbid   = $1::uuid LIMIT 1`,
  // The EXPRESSION, repeated verbatim from the index definition in
  // infra/mb-loader/mb-canonical-load.sh. `artist_mbids` is a comma-separated
  // text column for 15.2% of rows, so `= $1::uuid` would silently miss every
  // collaboration, and any expression that is not character-for-character the
  // indexed one falls back to a sequential scan of 31 million rows.
  artist: `SELECT 1 FROM mb.canonical
            WHERE string_to_array(artist_mbids, ',')::uuid[] @> ARRAY[$1::uuid]
            LIMIT 1`,
};

const LOAD_STATE_SQL = `
SELECT dump_id, sha256, finished_at, rows_loaded
  FROM mb.load_state
 WHERE status = 'ok'
 ORDER BY finished_at DESC
 LIMIT 1`;

interface RawRow {
  recording_mbid: unknown;
  recording_name: unknown;
  release_mbid: unknown;
  release_name: unknown;
  artist_mbids: unknown;
  artist_credit_name: unknown;
  score: unknown;
}

/**
 * The exclusive upper bound of a prefix range under BYTE ordering.
 *
 * Only defined for a pure-ASCII prefix, which is exactly what
 * `canonicalCoverage` guarantees and the only kind of key that can match a row
 * anyway: incrementing the final code unit is a valid successor for a
 * single-byte character and is NOT one for a multi-byte character, where the
 * increment lands inside a different encoding. Returns null when the prefix is
 * empty or not ASCII, and the caller must treat null as "do not run the query"
 * rather than falling back to an unbounded scan.
 */
export function prefixUpperBound(prefix: string): string | null {
  if (prefix === "") return null;
  const last = prefix.codePointAt(prefix.length - 1);
  if (last === undefined || last > 0x7e) return null;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
  }
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export class PgCanonicalStore implements CanonicalStore {
  readonly #db: Queryable;
  readonly #backoffMs: number;
  readonly #now: () => number;
  /** Epoch millis before which no query is attempted. 0 means "attempt". */
  #quietUntil = 0;
  #failures = 0;

  constructor(db: Queryable, opts: PgCanonicalStoreOptions = {}) {
    this.#db = db;
    this.#backoffMs = opts.unavailableBackoffMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * How often reads have been refused because the schema was unreachable.
   *
   * Surfaced rather than swallowed. A store that silently answers "miss" for
   * every lookup because the table is missing looks identical, from the outside,
   * to one whose data simply does not cover the catalogue - and the two need
   * completely different responses.
   */
  get failures(): number {
    return this.#failures;
  }

  async loadState(): Promise<CanonicalLoadState | null> {
    const rows = await this.#run<{
      dump_id: unknown;
      sha256: unknown;
      finished_at: unknown;
      rows_loaded: unknown;
    }>(LOAD_STATE_SQL, []);
    const row = rows[0];
    if (row === undefined) return null;
    const finishedAt =
      row.finished_at instanceof Date
        ? row.finished_at
        : new Date(String(row.finished_at));
    if (Number.isNaN(finishedAt.getTime())) return null;
    return {
      dumpId: String(row.dump_id),
      sha256: String(row.sha256),
      finishedAt,
      rowsLoaded: Number(row.rows_loaded ?? 0),
    };
  }

  async lookupExact(key: string, limit: number): Promise<CanonicalRow[]> {
    if (key === "") return [];
    return (await this.#run<RawRow>(EXACT_SQL, [key, limit])).map(toRow);
  }

  async lookupArtistPrefix(
    artistKey: string,
    upperBound: string,
    limit: number,
  ): Promise<CanonicalRow[]> {
    if (artistKey === "" || upperBound === "") return [];
    return (
      await this.#run<RawRow>(PREFIX_SQL, [artistKey, upperBound, limit])
    ).map(toRow);
  }

  async lookupRecordingMbid(mbid: string): Promise<CanonicalRow | null> {
    const rows = await this.#run<RawRow>(BY_RECORDING_SQL, [mbid]);
    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  async exists(
    entity: "recording" | "release" | "artist",
    mbid: string,
  ): Promise<boolean> {
    const sql = EXISTS_SQL[entity];
    /* c8 ignore next -- the parameter type makes an unknown entity unreachable */
    if (sql === undefined) return false;
    return (await this.#run<{ "?column?": number }>(sql, [mbid])).length > 0;
  }

  /**
   * Runs one query, turning EVERY failure into an empty result.
   *
   * Deliberately indiscriminate. The distinction between "the schema is absent
   * because this database was restored from a backup that excluded it" and "the
   * query timed out" does not change what this store may do about it: both mean
   * there is no local answer, and both must degrade to the rate-limited client
   * rather than fail a user's request. Distinguishing them would only create a
   * path on which an optimisation can take down the thing it optimises.
   */
  async #run<R>(sql: string, params: readonly unknown[]): Promise<R[]> {
    if (this.#now() < this.#quietUntil) return [];
    try {
      const { rows } = await this.#db.query<R>(sql, params);
      // A success clears the backoff, so a load landing after a failure is
      // served immediately rather than at the end of the current window.
      this.#quietUntil = 0;
      return rows;
    } catch {
      this.#failures += 1;
      this.#quietUntil = this.#now() + this.#backoffMs;
      return [];
    }
  }
}

function toRow(r: RawRow): CanonicalRow {
  // Split rather than parsed: the column is the dump's own text, and 15.2% of
  // rows hold several comma-separated ids. `String(...).split(",")` on a
  // single-id row yields a one-element array, so both shapes take one path.
  const ids = String(r.artist_mbids)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    recordingMbid: String(r.recording_mbid),
    recordingName: String(r.recording_name),
    releaseMbid: String(r.release_mbid),
    releaseName: String(r.release_name),
    artistMbid: ids[0] ?? "",
    artistMbids: ids,
    artistCreditName: String(r.artist_credit_name),
    score: Number(r.score ?? 0),
  };
}
