import { describe, expect, it, vi } from "vitest";

import { buildFeed } from "./blend.js";
import type { FeedArtistItem, FeedTrackItem } from "./envelope.js";
import type {
  DiscoveryPorts,
  LastfmPort,
  ListenBrainzPort,
  TrackRef,
} from "./ports.js";

const mbid = (n: number) =>
  `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function listenbrainz(
  overrides: Partial<ListenBrainzPort> = {},
): ListenBrainzPort {
  return {
    recommendedRecordings: () =>
      Promise.resolve([
        { recordingMbid: mbid(1), score: 0.9 },
        { recordingMbid: mbid(2), score: 0.7 },
      ]),
    topArtists: () =>
      Promise.resolve([
        { artistMbid: mbid(10), artistName: "Björk", listenCount: 400 },
        { artistMbid: mbid(11), artistName: "Múm", listenCount: 120 },
      ]),
    artistRadio: () =>
      Promise.resolve([
        {
          recordingMbid: mbid(3),
          recordingName: "Radio Track",
          artistMbid: mbid(12),
          artistName: "Amiina",
          similarity: 0.8,
        },
      ]),
    createdForPlaylists: () =>
      Promise.resolve([
        {
          identifier: "https://listenbrainz.org/playlist/x",
          title: "Weekly Discovery",
          annotation: "<p>for you</p>",
        },
      ]),
    similarArtists: () =>
      Promise.resolve([
        { artistMbid: mbid(20), name: "Emiliana Torrini", score: 0.7 },
      ]),
    ...overrides,
  };
}

function hydrate(): DiscoveryPorts["hydrate"] {
  return {
    hydrateRecordings: (mbids) => {
      const out = new Map<string, TrackRef>();
      for (const [i, id] of mbids.entries()) {
        out.set(id, {
          recordingMbid: id,
          title: `Track ${String(i)}`,
          artistName: "Björk",
          artistMbid: mbid(10),
        });
      }
      return Promise.resolve(out);
    },
  };
}

function lastfm(overrides: Partial<LastfmPort> = {}): LastfmPort {
  return {
    similarArtists: () =>
      Promise.resolve([
        {
          artistMbid: undefined,
          name: "Emiliana Torrini",
          score: 0.6,
          url: "https://www.last.fm/music/Emiliana+Torrini",
        },
      ]),
    similarTracks: () =>
      Promise.resolve([
        {
          title: "Radio Track",
          artistName: "Amiina",
          recordingMbid: undefined,
          score: 0.5,
          url: "https://www.last.fm/music/Amiina/_/Radio+Track",
        },
      ]),
    ...overrides,
  };
}

function ports(overrides: Partial<DiscoveryPorts> = {}): DiscoveryPorts {
  return {
    listenbrainz: listenbrainz(),
    lastfm: lastfm(),
    hydrate: hydrate(),
    ...overrides,
  };
}

describe("buildFeed envelope", () => {
  it("returns the sections the BFF contract declares", async () => {
    const feed = await buildFeed(ports(), { seedArtists: 1 });
    // Every provider that contributed is named once at the top level; the
    // per-artist Last.fm links stay on the items where the terms require them.
    expect(feed.attribution.map((a) => a.source)).toEqual([
      "lastfm",
      "listenbrainz",
    ]);
    expect(feed.sections.map((s) => s.kind)).toEqual([
      "made_for_you",
      "because_you_like",
      "connections",
      "daily_mix",
    ]);
    expect(feed.cursor).toBeNull();
    expect(feed.degraded).toBe(false);
    expect(feed.unavailableProviders).toEqual([]);
  });

  it("names the seed on a seeded section", async () => {
    const feed = await buildFeed(ports(), { seedArtists: 1 });
    const section = feed.sections.find((s) => s.kind === "because_you_like");
    expect(section?.seed).toEqual({ mbid: mbid(10), name: "Björk" });
    expect(section?.title).toContain("Björk");
  });

  it("builds one shelf per seed artist rather than blending them", async () => {
    const feed = await buildFeed(ports(), { seedArtists: 2 });
    const shelves = feed.sections.filter((s) => s.kind === "because_you_like");
    expect(shelves).toHaveLength(2);
    expect(new Set(shelves.map((s) => s.seed?.mbid)).size).toBe(2);
  });

  it("honours the per-section limit", async () => {
    const many = listenbrainz({
      recommendedRecordings: () =>
        Promise.resolve(
          Array.from({ length: 40 }, (_, i) => ({
            recordingMbid: mbid(100 + i),
            score: 1 - i / 100,
          })),
        ),
    });
    const feed = await buildFeed(ports({ listenbrainz: many }), { limit: 5 });
    const section = feed.sections.find((s) => s.kind === "made_for_you");
    expect(section?.items).toHaveLength(5);
  });
});

describe("buildFeed sourcing", () => {
  it("uses ListenBrainz as the backbone of made_for_you", async () => {
    const feed = await buildFeed(ports());
    const section = feed.sections.find((s) => s.kind === "made_for_you");
    const item = section?.items[0] as FeedTrackItem | undefined;
    expect(item?.sources).toEqual(["listenbrainz:cf"]);
    expect(item?.recordingMbid).toBe(mbid(1));
  });

  it("enriches, rather than replaces, with Last.fm", async () => {
    const feed = await buildFeed(ports(), { seedArtists: 1 });
    const section = feed.sections.find((s) => s.kind === "because_you_like");
    const item = section?.items[0] as FeedTrackItem | undefined;
    // Both sources named the same track, so it carries both and a boost.
    expect(item?.sources).toEqual(["lastfm:similar", "listenbrainz:lb-radio"]);
    expect(item?.score).toBeGreaterThan(0.8);
  });

  it("surfaces the Last.fm attribution link the terms require", async () => {
    const feed = await buildFeed(ports(), { seedArtists: 1 });
    const section = feed.sections.find((s) => s.kind === "connections");
    const item = section?.items[0] as FeedArtistItem | undefined;
    const lastfmLink = item?.attribution.find((a) => a.source === "lastfm");
    expect(lastfmLink?.url).toContain("last.fm/music/");
    expect(lastfmLink?.text).toBe("Data provided by Last.fm");
  });

  it("runs without Last.fm at all, which the kill switch requires", async () => {
    const feed = await buildFeed(ports({ lastfm: undefined }));
    expect(feed.degraded).toBe(false);
    expect(feed.sections.map((s) => s.kind)).toContain("connections");
    expect(JSON.stringify(feed)).not.toContain("lastfm");
  });

  it("skips Last.fm when enrichment is disabled at runtime", async () => {
    const port = lastfm();
    const similar = vi.spyOn(port, "similarArtists");
    await buildFeed(ports({ lastfm: port }), { enableLastfm: false });
    expect(similar).not.toHaveBeenCalled();
  });
});

describe("buildFeed degradation", () => {
  it("drops one shelf and reports the provider when a source fails", async () => {
    const broken = listenbrainz({
      recommendedRecordings: () => Promise.reject(new Error("503")),
    });
    const feed = await buildFeed(ports({ listenbrainz: broken }));
    expect(feed.sections.map((s) => s.kind)).not.toContain("made_for_you");
    expect(feed.degraded).toBe(true);
    expect(feed.unavailableProviders).toContain("listenbrainz");
    // The rest of the feed still renders: that is the point of the envelope.
    expect(feed.sections.length).toBeGreaterThan(0);
  });

  it("reports musicbrainz when hydration fails, not listenbrainz", async () => {
    const feed = await buildFeed(
      ports({
        hydrate: {
          hydrateRecordings: () => Promise.reject(new Error("circuit open")),
        },
      }),
    );
    expect(feed.unavailableProviders).toContain("musicbrainz");
    expect(feed.unavailableProviders).not.toContain("listenbrainz");
  });

  it("keeps the ListenBrainz shelf when only Last.fm fails", async () => {
    const feed = await buildFeed(
      ports({
        lastfm: lastfm({
          similarTracks: () => Promise.reject(new Error("cap exceeded")),
          similarArtists: () => Promise.reject(new Error("cap exceeded")),
        }),
      }),
      { seedArtists: 1 },
    );
    expect(feed.unavailableProviders).toEqual(["lastfm"]);
    const section = feed.sections.find((s) => s.kind === "because_you_like");
    expect(section?.items.length).toBeGreaterThan(0);
  });

  it("returns an empty but valid envelope when everything fails", async () => {
    const dead = listenbrainz({
      recommendedRecordings: () => Promise.reject(new Error("x")),
      topArtists: () => Promise.reject(new Error("x")),
      artistRadio: () => Promise.reject(new Error("x")),
      createdForPlaylists: () => Promise.reject(new Error("x")),
      similarArtists: () => Promise.reject(new Error("x")),
    });
    const feed = await buildFeed(
      ports({ listenbrainz: dead, lastfm: undefined }),
    );
    expect(feed).toEqual({
      sections: [],
      cursor: null,
      degraded: true,
      unavailableProviders: ["listenbrainz"],
      attribution: [],
    });
  });

  it("omits a section that has no items rather than shipping an empty shelf", async () => {
    const empty = listenbrainz({
      recommendedRecordings: () => Promise.resolve([]),
      createdForPlaylists: () => Promise.resolve([]),
    });
    const feed = await buildFeed(ports({ listenbrainz: empty }));
    expect(feed.sections.map((s) => s.kind)).not.toContain("made_for_you");
    expect(feed.sections.map((s) => s.kind)).not.toContain("daily_mix");
    // Empty shelves are not a failure, so the feed is not marked degraded.
    expect(feed.degraded).toBe(false);
  });

  it("survives a user with no MBID-bearing top artists", async () => {
    const noMbids = listenbrainz({
      topArtists: () =>
        Promise.resolve([
          { artistMbid: undefined, artistName: "Local Band", listenCount: 3 },
        ]),
    });
    const feed = await buildFeed(ports({ listenbrainz: noMbids }));
    expect(feed.sections.map((s) => s.kind)).not.toContain("because_you_like");
    expect(feed.degraded).toBe(false);
  });
});
