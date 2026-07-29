/**
 * The artist existence gate.
 *
 * Every test here is about the SAFE DIRECTION. Declining a lookup saves one
 * upstream call; declining one wrongly 404s a real artist for a real user, and
 * that trade is the wrong way round. So the suite is weighted almost entirely
 * towards proving the gate opens: it opens with no store, with an empty store,
 * with an absent schema, on a throw, and on any local record of the identifier.
 * Exactly one arrangement closes it.
 */

import { describe, expect, test, vi } from "vitest";

import type {
  CanonicalLoadState,
  CanonicalRow,
  CanonicalStore,
} from "@pull-fm/upstream";

import {
  CanonicalArtistLookupGate,
  OpenArtistLookupGate,
} from "./artist-lookup-gate.js";

const MBID = "11111111-2222-3333-4444-555555555555";

const LOADED: CanonicalLoadState = {
  dumpId: "canonical-dump-2026-07-01",
  sha256: "0".repeat(64),
  finishedAt: new Date("2026-07-01T00:00:00Z"),
  rowsLoaded: 31_000_000,
};

/** A canonical store whose three interesting answers are all controllable. */
function store(opts: {
  loadState?: CanonicalLoadState | null;
  exists?: boolean;
  throwOn?: "loadState" | "exists";
}): CanonicalStore {
  return {
    loadState: () =>
      opts.throwOn === "loadState"
        ? Promise.reject(new Error("relation mb.load_state does not exist"))
        : // `??` would swallow a deliberate null, which is the "table exists
          // but nothing is loaded" case this suite is mostly about.
          Promise.resolve("loadState" in opts ? opts.loadState! : LOADED),
    exists: () =>
      opts.throwOn === "exists"
        ? Promise.reject(new Error("statement timeout"))
        : Promise.resolve(opts.exists ?? false),
    lookupExact: (): Promise<CanonicalRow[]> => Promise.resolve([]),
    lookupArtistPrefix: (): Promise<CanonicalRow[]> => Promise.resolve([]),
    lookupRecordingMbid: (): Promise<CanonicalRow | null> =>
      Promise.resolve(null),
  };
}

const unknownLocally = (): Promise<boolean> => Promise.resolve(false);
const knownLocally = (): Promise<boolean> => Promise.resolve(true);

describe("the gate opens whenever the local data cannot decide", () => {
  test("no canonical store wired at all: the shipped default", async () => {
    // MB_LOCAL_ENABLED defaults to false, so `upstream.canonical` is undefined
    // and this is the arrangement almost every deployment runs.
    const gate = new CanonicalArtistLookupGate({
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
    expect(gate.declined).toBe(0);
  });

  test("the table exists but nothing has been loaded into it", async () => {
    // An empty table answers "absent" for the ENTIRE catalogue, so a gate that
    // trusted it would decline every lookup in the product.
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ loadState: null }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });

  test("a load that reported zero rows counts as not loaded", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ loadState: { ...LOADED, rowsLoaded: 0 } }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });

  test("the mb schema is absent, which is normal after a restore", async () => {
    // Logical backups exclude `mb` on purpose. A restore drill must not turn
    // into a product outage because an optimisation's table is missing.
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ throwOn: "loadState" }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });

  test("the existence probe itself throws", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ throwOn: "exists" }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });

  test("the local-record probe throws", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: false }),
      knownLocally: () => Promise.reject(new Error("pool exhausted")),
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });
});

describe("the gate opens on any positive evidence", () => {
  test("the canonical dump names the artist", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: true }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
  });

  test("the dump does NOT name it but we have resolved it before", async () => {
    // THE CAVEAT, honoured. The dump is a subset of MusicBrainz, so `false` is
    // "not known here" rather than "does not exist". A warm MusicBrainz cache
    // row or a crosswalk entry is positive evidence the dump cannot have.
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: false }),
      knownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
    expect(gate.declined).toBe(0);
  });

  test("the cheap probe runs first and short-circuits the expensive one", async () => {
    // exists() is a 0.09 ms index hit; knownLocally is two round trips.
    const local = vi.fn(unknownLocally);
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: true }),
      knownLocally: local,
    });
    await gate.worthAsking(MBID);
    expect(local).not.toHaveBeenCalled();
  });
});

describe("the one arrangement that declines", () => {
  test("a loaded dump and every local record silent together", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: false }),
      knownLocally: unknownLocally,
    });
    await expect(gate.worthAsking(MBID)).resolves.toBe(false);
    expect(gate.declined).toBe(1);
  });

  test("counts declines, so the saving can be argued rather than asserted", async () => {
    const gate = new CanonicalArtistLookupGate({
      canonical: store({ exists: false }),
      knownLocally: unknownLocally,
    });
    await gate.worthAsking(MBID);
    await gate.worthAsking(MBID);
    expect(gate.declined).toBe(2);
  });
});

describe("the load-state reading is memoised", () => {
  test("re-read at most once per TTL, not once per request", async () => {
    let clock = 0;
    const loadState = vi.fn(() => Promise.resolve(LOADED));
    const gate = new CanonicalArtistLookupGate({
      canonical: { ...store({ exists: true }), loadState },
      knownLocally: unknownLocally,
      loadStateTtlMs: 1000,
      now: () => clock,
    });

    await gate.worthAsking(MBID);
    await gate.worthAsking(MBID);
    expect(loadState).toHaveBeenCalledTimes(1);

    clock = 1001;
    await gate.worthAsking(MBID);
    expect(loadState).toHaveBeenCalledTimes(2);
  });

  test("a dump loaded later flips the answer without a restart", async () => {
    let clock = 0;
    let state: CanonicalLoadState | null = null;
    const gate = new CanonicalArtistLookupGate({
      canonical: {
        ...store({ exists: false }),
        loadState: () => Promise.resolve(state),
      },
      knownLocally: unknownLocally,
      loadStateTtlMs: 1000,
      now: () => clock,
    });

    await expect(gate.worthAsking(MBID)).resolves.toBe(true);
    state = LOADED;
    clock = 1001;
    await expect(gate.worthAsking(MBID)).resolves.toBe(false);
  });
});

describe("OpenArtistLookupGate", () => {
  test("declines nothing, ever", async () => {
    const gate = new OpenArtistLookupGate();
    await expect(gate.worthAsking()).resolves.toBe(true);
    expect(gate.declined).toBe(0);
  });
});
