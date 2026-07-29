/**
 * The store's job is to be un-failable.
 *
 * Every one of these cases is a way the local table can be unavailable or wrong,
 * and in every one the required outcome is the same: an empty result, so the
 * caller behaves exactly as it did before the table existed. A store that throws
 * turns an optimisation into an outage, which is strictly worse than not having
 * built it.
 */

import { describe, expect, it, vi } from "vitest";

import { PgCanonicalStore, prefixUpperBound } from "./canonical-store.js";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A `Queryable` that records what it was asked and answers what it was told. */
class FakeDb {
  readonly calls: Call[] = [];
  #next: (sql: string) => unknown[] = () => [];
  #throw: Error | null = null;

  answering(fn: (sql: string) => unknown[]): this {
    this.#next = fn;
    this.#throw = null;
    return this;
  }

  failing(message: string): this {
    this.#throw = new Error(message);
    return this;
  }

  // The generic is required to satisfy `Queryable`, whose `query<R>` lets each
  // call site name the row shape it expects. eslint reads it as used once and
  // suggests removing it; doing so makes this class unassignable to the
  // interface it exists to stand in for.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<R>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    if (this.#throw !== null) return Promise.reject(this.#throw);
    const rows = this.#next(sql) as R[];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

const ROW = {
  recording_mbid: "7b1f193b-c9ba-48d6-bd6f-8afd02d489a2",
  recording_name: "Pot Pourri Sega",
  release_mbid: "61efbf58-5be4-40ba-9bef-49c92cc5b8ca",
  release_name: "Sofe Linzy",
  artist_mbids: "89ad4ac3-39f7-470e-963a-56509c546377",
  artist_credit_name: "Various Artists",
  score: 186668,
};

describe("prefixUpperBound", () => {
  it("increments the final character, which is the exclusive bound", () => {
    expect(prefixUpperBound("thebeatles")).toBe("thebeatlet");
    expect(prefixUpperBound("a")).toBe("b");
  });

  it("refuses a non-ASCII prefix rather than producing a wrong bound", () => {
    // Incrementing the last code unit of a multi-byte character lands inside a
    // different encoding, so the range would silently cover the wrong rows.
    // Returning null makes the caller skip the query instead.
    expect(prefixUpperBound("bjork乡")).toBeNull();
    expect(prefixUpperBound("")).toBeNull();
  });
});

describe("PgCanonicalStore", () => {
  it("orders by score ASCENDING, because lower is the more canonical release", () => {
    const db = new FakeDb().answering(() => [ROW]);
    const store = new PgCanonicalStore(db);
    return store.lookupExact("variousartistspotpourrisega", 5).then(() => {
      const sql = db.calls[0]?.sql ?? "";
      expect(sql).toMatch(/ORDER BY score\s*\n/);
      expect(sql).not.toMatch(/score DESC/);
    });
  });

  it("uses the text_pattern_ops operators for a prefix range", async () => {
    // Not `>=` / `<`, which compare under the database collation and would
    // return the wrong rows on any deployment that is not C-collated, and not
    // LIKE, whose index use depends on the planner extracting a prefix from a
    // bind parameter.
    const db = new FakeDb().answering(() => []);
    const store = new PgCanonicalStore(db);
    await store.lookupArtistPrefix("thebeatles", "thebeatlet", 10);
    expect(db.calls[0]?.sql).toContain("~>=~");
    expect(db.calls[0]?.sql).toContain("~<~");
  });

  it("maps a row into the client's own shape", async () => {
    const db = new FakeDb().answering(() => [ROW]);
    const store = new PgCanonicalStore(db);
    const [row] = await store.lookupExact("k", 1);
    expect(row).toEqual({
      recordingMbid: ROW.recording_mbid,
      recordingName: ROW.recording_name,
      releaseMbid: ROW.release_mbid,
      releaseName: ROW.release_name,
      artistMbid: ROW.artist_mbids,
      artistMbids: [ROW.artist_mbids],
      artistCreditName: ROW.artist_credit_name,
      score: 186668,
    });
  });

  it("never queries with an empty key", async () => {
    const db = new FakeDb().answering(() => [ROW]);
    const store = new PgCanonicalStore(db);
    expect(await store.lookupExact("", 5)).toEqual([]);
    expect(await store.lookupArtistPrefix("", "b", 5)).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The failure contract.
  // -------------------------------------------------------------------------

  it("turns a missing schema into a miss rather than an error", async () => {
    // What a database restored from a backup that excluded the mb schema looks
    // like. A restore drill must not become an outage.
    const db = new FakeDb().failing('relation "mb.canonical" does not exist');
    const store = new PgCanonicalStore(db);
    await expect(store.lookupExact("k", 5)).resolves.toEqual([]);
    await expect(store.loadState()).resolves.toBeNull();
    expect(store.failures).toBeGreaterThan(0);
  });

  it("stops asking for a while after a failure instead of once per lookup", async () => {
    const now = vi.fn<() => number>().mockReturnValue(1_000);
    const db = new FakeDb().failing("boom");
    const store = new PgCanonicalStore(db, {
      unavailableBackoffMs: 60_000,
      now,
    });

    await store.lookupExact("a", 5);
    expect(db.calls).toHaveLength(1);

    // Inside the window: no query at all, so a missing table costs one failed
    // round trip per minute rather than one per resolution.
    await store.lookupExact("b", 5);
    await store.lookupExact("c", 5);
    expect(db.calls).toHaveLength(1);

    // Past it: it probes again, so a load landing later is picked up without a
    // restart.
    now.mockReturnValue(1_000 + 60_001);
    await store.lookupExact("d", 5);
    expect(db.calls).toHaveLength(2);
  });

  it("clears the backoff on the first success", async () => {
    const now = vi.fn<() => number>().mockReturnValue(1_000);
    const db = new FakeDb().failing("boom");
    const store = new PgCanonicalStore(db, {
      unavailableBackoffMs: 60_000,
      now,
    });
    await store.lookupExact("a", 5);
    now.mockReturnValue(70_000);
    db.answering(() => [ROW]);
    await store.lookupExact("b", 5);
    // Still inside a fresh backoff window if the success had not cleared it.
    await store.lookupExact("c", 5);
    expect(db.calls).toHaveLength(3);
  });

  it("treats an unparseable load timestamp as no load at all", async () => {
    const db = new FakeDb().answering(() => [
      { dump_id: "d", sha256: "s", finished_at: "not a date", rows_loaded: 1 },
    ]);
    const store = new PgCanonicalStore(db);
    await expect(store.loadState()).resolves.toBeNull();
  });

  it("reports the loaded dump when there is one", async () => {
    const finished = new Date("2026-07-29T10:00:00Z");
    const db = new FakeDb().answering(() => [
      {
        dump_id: "musicbrainz-canonical-dump-20260717-080003",
        sha256: "65796cec",
        finished_at: finished,
        rows_loaded: "1500000",
      },
    ]);
    const store = new PgCanonicalStore(db);
    await expect(store.loadState()).resolves.toEqual({
      dumpId: "musicbrainz-canonical-dump-20260717-080003",
      sha256: "65796cec",
      finishedAt: finished,
      rowsLoaded: 1_500_000,
    });
  });

  // -------------------------------------------------------------------------
  // Existence probes, which are what the MBID indexes are for.
  // -------------------------------------------------------------------------

  it("probes each entity against its own indexed column", async () => {
    const db = new FakeDb().answering(() => [{ "?column?": 1 }]);
    const store = new PgCanonicalStore(db);
    await store.exists("recording", ROW.recording_mbid);
    await store.exists("release", ROW.release_mbid);
    await store.exists("artist", ROW.artist_mbids);
    expect(db.calls[0]?.sql).toContain("recording_mbid");
    expect(db.calls[1]?.sql).toContain("release_mbid");
    // The EXPRESSION, character for character from the index definition. A
    // plain `artist_mbids = $1::uuid` would miss every one of the 4.8 million
    // rows whose credit names more than one artist, and any near-miss on the
    // expression falls back to a sequential scan of 31 million rows.
    expect(db.calls[2]?.sql).toContain(
      "string_to_array(artist_mbids, ',')::uuid[] @> ARRAY[$1::uuid]",
    );
  });

  it("splits a multi-artist credit into every id, primary first", async () => {
    // 15.2% of rows in the 2026-07-17 dump look like this: a comma-separated
    // list inside one text column, not a single id.
    const db = new FakeDb().answering(() => [
      {
        ...ROW,
        artist_mbids:
          "e6b10e75-b7be-465c-8dec-1d31c6d42723,c5cbbefb-de04-43d4-9ffc-a5b9cd85b2ef",
        artist_credit_name: "Hot Pink Delorean & Fantastadon",
      },
    ]);
    const store = new PgCanonicalStore(db);
    const [row] = await store.lookupExact("k", 1);
    expect(row?.artistMbids).toEqual([
      "e6b10e75-b7be-465c-8dec-1d31c6d42723",
      "c5cbbefb-de04-43d4-9ffc-a5b9cd85b2ef",
    ]);
    // The first is the primary, matching how MusicBrainzClient reads
    // `artist-credit[0].artist.id` off the web service.
    expect(row?.artistMbid).toBe("e6b10e75-b7be-465c-8dec-1d31c6d42723");
  });

  it("reports absence as false, and absence is NOT proof of non-existence", async () => {
    // The dump is a subset of MusicBrainz, so a real MBID can be missing from
    // it. This asserts the mechanics; the doc comment is what stops a caller
    // treating false as a licence to reject.
    const db = new FakeDb().answering(() => []);
    const store = new PgCanonicalStore(db);
    await expect(store.exists("recording", ROW.recording_mbid)).resolves.toBe(
      false,
    );
  });

  it("returns the best row for a recording MBID", async () => {
    const db = new FakeDb().answering(() => [ROW]);
    const store = new PgCanonicalStore(db);
    const row = await store.lookupRecordingMbid(ROW.recording_mbid);
    expect(row?.recordingName).toBe("Pot Pourri Sega");
    expect(db.calls[0]?.sql).toContain("recording_mbid = $1::uuid");
  });

  it("returns null for a recording MBID that is not here", async () => {
    const db = new FakeDb().answering(() => []);
    const store = new PgCanonicalStore(db);
    await expect(
      store.lookupRecordingMbid(ROW.recording_mbid),
    ).resolves.toBeNull();
  });
});
