/**
 * `GET /v1/artists/{mbid}/similar`, at the seam where the upstream call is
 * decided.
 *
 * The gate itself is unit-tested in artist-lookup-gate.test.ts. What this file
 * tests is its PLACEMENT, which is the part a refactor would break silently:
 * the check lives inside `CachedUpstream.fetch`'s `load` closure, which runs
 * only on a miss. That placement is what makes three things true at once, and
 * each of them is asserted below against the REAL cache implementation rather
 * than a stand-in:
 *
 *   - a warm answer is served without the gate running at all;
 *   - a declined lookup makes no upstream call and writes no cache row, so no
 *     negative is cached to be wrong about later;
 *   - a declined lookup is indistinguishable on the wire from an artist labs
 *     does not know, which it already answered with an empty list.
 *
 * `security/zap/upstream-scope.tsv` calls this route "THE DANGEROUS ONE": a
 * random UUID is a guaranteed cache miss, so before this an attacker had a 1:1
 * request-to-upstream ratio against the tightest shared allowance in the
 * system (about 30 requests per 10 seconds, app-wide, no token).
 */

import { describe, expect, test, vi } from "vitest";

import {
  CachedUpstream,
  MemoryCacheStore,
  type CanonicalLoadState,
  type CanonicalStore,
  type CrosswalkHit,
} from "@pull-fm/upstream";

import { DiscoveryService } from "./discovery.js";
import type { ConnectionService } from "./connections.js";
import type { UpstreamBundle } from "./upstream.js";
import type { SigningKeys } from "../lib/keys.js";

const KNOWN = "aaaaaaaa-1111-2222-3333-444444444444";
const RANDOM = "ffffffff-9999-8888-7777-666666666666";

const LOADED: CanonicalLoadState = {
  dumpId: "canonical-dump-2026-07-01",
  sha256: "0".repeat(64),
  finishedAt: new Date("2026-07-01T00:00:00Z"),
  rowsLoaded: 31_000_000,
};

interface Harness {
  readonly discovery: DiscoveryService;
  readonly cache: CachedUpstream;
  /** Every MBID the ListenBrainz labs client was actually asked about. */
  readonly labsCalls: string[];
}

function harness(
  opts: {
    /** MBIDs the canonical dump contains. */
    inDump?: readonly string[];
    /** MBIDs the crosswalk has learned. */
    inCrosswalk?: readonly string[];
    /** Undefined models MB_LOCAL_ENABLED=false. */
    canonicalWired?: boolean;
    loadState?: CanonicalLoadState | null;
  } = {},
): Harness {
  const labsCalls: string[] = [];
  const cache = new CachedUpstream(new MemoryCacheStore());
  const inDump = new Set(opts.inDump ?? []);
  const inCrosswalk = new Set(opts.inCrosswalk ?? []);

  const canonical: CanonicalStore = {
    loadState: () =>
      Promise.resolve(opts.loadState === undefined ? LOADED : opts.loadState),
    exists: (_entity, mbid) => Promise.resolve(inDump.has(mbid)),
    lookupExact: () => Promise.resolve([]),
    lookupArtistPrefix: () => Promise.resolve([]),
    lookupRecordingMbid: () => Promise.resolve(null),
  };

  const bundle = {
    cache,
    canonical: opts.canonicalWired === false ? undefined : canonical,
    // Absent, so the Last.fm half of the blend never runs and the assertions
    // are about the ListenBrainz call this route is dangerous for.
    lastfm: undefined,
    listenbrainz: {
      similarArtists: (mbid: string) => {
        labsCalls.push(mbid);
        return Promise.resolve([{ name: "Neighbour", score: 0.9 }]);
      },
    },
    crosswalkStore: {
      lookupByMbid: (
        _entity: string,
        mbid: string,
      ): Promise<CrosswalkHit | null> =>
        Promise.resolve(
          inCrosswalk.has(mbid)
            ? ({
                mbid,
                normalizedKey: "known artist",
                similarity: 1,
                source: "listenbrainz:lb-radio",
              } as CrosswalkHit)
            : null,
        ),
    },
  } as unknown as UpstreamBundle;

  return {
    discovery: new DiscoveryService(
      bundle,
      {} as unknown as ConnectionService,
      {} as unknown as SigningKeys,
    ),
    cache,
    labsCalls,
  };
}

describe("an MBID no local record has ever heard of", () => {
  test("costs no upstream call", async () => {
    const h = harness({ inDump: [KNOWN] });
    const result = await h.discovery.similarArtists(RANDOM);
    expect(h.labsCalls).toEqual([]);
    expect(result.artists).toEqual([]);
  });

  test("answers exactly what an unknown artist already answered", async () => {
    // Nothing on the wire changes. `degraded` in particular must stay false: a
    // declined lookup is not a provider outage, and a client that renders a
    // degradation banner for a typo'd identifier is worse than one that shows
    // an empty list.
    const h = harness({ inDump: [KNOWN] });
    const result = await h.discovery.similarArtists(RANDOM);
    expect(result).toEqual({
      artists: [],
      degraded: false,
      unavailableProviders: [],
      attribution: [],
    });
  });

  test("caches NO negative, so a later dump load changes the answer at once", async () => {
    // A cached empty list would be wrong for seven days (TTL.labsSimilar). The
    // declined path throws inside `load`, so `#fill` never reaches `store.set`.
    const h = harness({ inDump: [KNOWN] });
    await h.discovery.similarArtists(RANDOM);
    const cached = await h.cache.peek(
      "listenbrainz",
      `labs-similar:${RANDOM}`,
      (p) => p,
    );
    expect(cached).toBeNull();
  });

  test("declines every repeat too, without ever calling out", async () => {
    const h = harness({ inDump: [KNOWN] });
    for (let i = 0; i < 25; i++) await h.discovery.similarArtists(RANDOM);
    expect(h.labsCalls).toEqual([]);
  });
});

describe("an MBID something knows about", () => {
  test("in the canonical dump: the call is made", async () => {
    const h = harness({ inDump: [KNOWN] });
    const result = await h.discovery.similarArtists(KNOWN);
    expect(h.labsCalls).toEqual([KNOWN]);
    expect(result.artists).toHaveLength(1);
  });

  test("absent from the dump but known to the crosswalk: the call is made", async () => {
    // THE CAVEAT THAT MATTERS. The dump is a subset of MusicBrainz, so absence
    // from it is not evidence of anything. A real artist we learned about from
    // ListenBrainz must not be declined.
    const h = harness({ inDump: [], inCrosswalk: [KNOWN] });
    await h.discovery.similarArtists(KNOWN);
    expect(h.labsCalls).toEqual([KNOWN]);
  });

  test("a warm cache entry is served without consulting the gate", async () => {
    // The placement property. If the gate ran before `fetch`, this lookup would
    // be declined and a cached answer would be thrown away.
    const h = harness({ inDump: [] });
    await h.cache.fetch({
      provider: "listenbrainz",
      key: `labs-similar:${RANDOM}`,
      ttlSeconds: 3600,
      load: () => Promise.resolve([{ name: "Cached Neighbour", score: 0.5 }]),
      parse: (p) => p as { name: string; score: number }[],
    });

    const result = await h.discovery.similarArtists(RANDOM);
    expect(result.artists.map((a) => a.name)).toEqual(["Cached Neighbour"]);
    // The warm entry came from the seeding call above, not from a new one.
    expect(h.labsCalls).toEqual([]);
  });
});

describe("the deployment shapes that must behave exactly as before", () => {
  test("MB_LOCAL_ENABLED=false: no store is wired and nothing is declined", async () => {
    const h = harness({ canonicalWired: false });
    await h.discovery.similarArtists(RANDOM);
    expect(h.labsCalls).toEqual([RANDOM]);
  });

  test("the table is present but empty", async () => {
    const h = harness({ loadState: null });
    await h.discovery.similarArtists(RANDOM);
    expect(h.labsCalls).toEqual([RANDOM]);
  });

  test("the mb schema is absent entirely", async () => {
    // A store that throws rather than one that answers "miss". PgCanonicalStore
    // swallows this itself, so this models the harsher case: even a store that
    // propagates the failure must not be able to decline a lookup.
    const labsCalls: string[] = [];
    const throwing = new DiscoveryService(
      {
        cache: new CachedUpstream(new MemoryCacheStore()),
        canonical: {
          loadState: () =>
            Promise.reject(new Error("schema mb does not exist")),
          exists: () => Promise.reject(new Error("schema mb does not exist")),
          lookupExact: () => Promise.resolve([]),
          lookupArtistPrefix: () => Promise.resolve([]),
          lookupRecordingMbid: () => Promise.resolve(null),
        },
        lastfm: undefined,
        listenbrainz: {
          similarArtists: (mbid: string) => {
            labsCalls.push(mbid);
            return Promise.resolve([]);
          },
        },
        crosswalkStore: { lookupByMbid: () => Promise.resolve(null) },
      } as unknown as UpstreamBundle,
      {} as unknown as ConnectionService,
      {} as unknown as SigningKeys,
    );

    await throwing.similarArtists(RANDOM);
    expect(labsCalls).toEqual([RANDOM]);
  });

  test("a provider failure is still an empty list, not an error", async () => {
    // labs.api returns [] rather than throwing, by contract, and the gate must
    // not have changed which failures are swallowed.
    const failing = new DiscoveryService(
      {
        cache: new CachedUpstream(new MemoryCacheStore()),
        canonical: undefined,
        lastfm: undefined,
        listenbrainz: {
          similarArtists: () => Promise.reject(new Error("502 from labs")),
        },
        crosswalkStore: { lookupByMbid: () => Promise.resolve(null) },
      } as unknown as UpstreamBundle,
      {} as unknown as ConnectionService,
      {} as unknown as SigningKeys,
    );
    await expect(failing.similarArtists(RANDOM)).resolves.toMatchObject({
      artists: [],
    });
  });
});

describe("the gate is not reachable from anything else", () => {
  test("it does not run for a route that never calls labs", async () => {
    // `GET /v1/artists/{mbid}` is classified `none` in upstream-scope.tsv and
    // must stay that way: it is a peek plus a crosswalk read, and adding a
    // canonical probe to it would be a new database read on a hot path for no
    // upstream saving at all.
    const exists = vi.fn(() => Promise.resolve(false));
    const svc = new DiscoveryService(
      {
        cache: new CachedUpstream(new MemoryCacheStore()),
        canonical: {
          ...({} as CanonicalStore),
          exists,
          loadState: () => Promise.resolve(LOADED),
        },
        lastfm: undefined,
        listenbrainz: { similarArtists: () => Promise.resolve([]) },
        crosswalkStore: { lookupByMbid: () => Promise.resolve(null) },
      } as unknown as UpstreamBundle,
      {} as unknown as ConnectionService,
      {} as unknown as SigningKeys,
    );

    await expect(svc.artist(RANDOM)).resolves.toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });
});
