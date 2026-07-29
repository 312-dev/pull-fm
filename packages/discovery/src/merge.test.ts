import { describe, expect, it } from "vitest";

import {
  agreementBoost,
  makeArtistCandidate,
  makeTrackCandidate,
  mergeArtists,
  mergeTracks,
} from "./merge.js";

const MBID = "40000000-0000-4000-8000-000000000001";

describe("agreementBoost", () => {
  it("is 1 for a single source and sublinear thereafter", () => {
    expect(agreementBoost(1)).toBe(1);
    expect(agreementBoost(2)).toBeCloseTo(2);
    expect(agreementBoost(4)).toBeCloseTo(3);
    // Sublinear: four sources must not be four times one source.
    expect(agreementBoost(4)).toBeLessThan(4);
  });
});

describe("mergeTracks", () => {
  it("dedups on normalised artist and title, not on MBID", () => {
    // Sources disagree about MBIDs far more often than about spelling: Last.fm
    // frequently returns none at all. Deduping on MBID leaves the same track
    // twice in one shelf, the most visible possible defect in a feed.
    const merged = mergeTracks([
      makeTrackCandidate({
        source: "listenbrainz:cf",
        score: 0.9,
        title: "Jóga (2007 Remaster)",
        artistName: "Björk",
        recordingMbid: MBID,
      }),
      makeTrackCandidate({
        source: "lastfm:similar",
        score: 0.5,
        title: "Joga",
        artistName: "Bjork",
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sources).toEqual(["lastfm:similar", "listenbrainz:cf"]);
  });

  it("boosts agreement instead of filtering on it", () => {
    const agreed = mergeTracks([
      makeTrackCandidate({
        source: "a",
        score: 0.5,
        title: "Shared",
        artistName: "X",
      }),
      makeTrackCandidate({
        source: "b",
        score: 0.5,
        title: "Shared",
        artistName: "X",
      }),
    ]);
    const alone = mergeTracks([
      makeTrackCandidate({
        source: "a",
        score: 0.6,
        title: "Solo",
        artistName: "Y",
      }),
    ]);
    expect(agreed[0]?.score).toBeGreaterThan(alone[0]?.score ?? 0);
  });

  it("keeps a single-source personal recommendation, which a filter would drop", () => {
    // Intersecting sources would throw away every recommendation that is not
    // also broadly popular, which is the material the feed exists to surface.
    const merged = mergeTracks([
      makeTrackCandidate({
        source: "listenbrainz:cf",
        score: 0.95,
        title: "Obscure Gem",
        artistName: "Nobody",
        recordingMbid: MBID,
      }),
      makeTrackCandidate({
        source: "lastfm:similar",
        score: 0.4,
        title: "Popular Thing",
        artistName: "Everyone",
      }),
      makeTrackCandidate({
        source: "listenbrainz:lb-radio",
        score: 0.4,
        title: "Popular Thing",
        artistName: "Everyone",
      }),
    ]);
    expect(merged.map((m) => m.title)).toContain("Obscure Gem");
    // A strong single-source score still beats a mediocre two-source one.
    expect(merged[0]?.title).toBe("Obscure Gem");
  });

  it("keeps an MBID contributed by a weaker source", () => {
    const merged = mergeTracks([
      makeTrackCandidate({
        source: "lastfm:similar",
        score: 0.9,
        title: "Song",
        artistName: "Artist",
      }),
      makeTrackCandidate({
        source: "listenbrainz:cf",
        score: 0.2,
        title: "Song",
        artistName: "Artist",
        recordingMbid: MBID,
      }),
    ]);
    // Everything downstream (previews, wishlist, crosswalk) is keyed on MBID.
    expect(merged[0]?.recordingMbid).toBe(MBID);
  });

  it("collects attribution from every contributing source, without duplicates", () => {
    const attribution = {
      source: "lastfm",
      text: "Data provided by Last.fm",
      url: "https://www.last.fm/music/Artist",
    };
    const merged = mergeTracks([
      makeTrackCandidate({
        source: "lastfm:similar",
        score: 0.5,
        title: "Song",
        artistName: "Artist",
        attribution,
      }),
      makeTrackCandidate({
        source: "lastfm:similar-tracks",
        score: 0.4,
        title: "Song",
        artistName: "Artist",
        attribution,
      }),
    ]);
    expect(merged[0]?.attribution).toEqual([attribution]);
  });

  it("drops candidates whose identity normalises to nothing", () => {
    expect(
      mergeTracks([
        makeTrackCandidate({
          source: "a",
          score: 1,
          title: "!!!",
          artistName: "???",
        }),
      ]),
    ).toEqual([]);
  });

  it("orders deterministically when scores tie", () => {
    const build = () => [
      makeTrackCandidate({
        source: "a",
        score: 0.5,
        title: "B",
        artistName: "Z",
      }),
      makeTrackCandidate({
        source: "a",
        score: 0.5,
        title: "A",
        artistName: "Z",
      }),
    ];
    expect(mergeTracks(build()).map((m) => m.title)).toEqual(
      mergeTracks(build().reverse()).map((m) => m.title),
    );
  });
});

describe("mergeArtists", () => {
  it("merges spelling variants and boosts agreement", () => {
    const merged = mergeArtists([
      makeArtistCandidate({
        source: "listenbrainz:labs-similar",
        score: 0.6,
        name: "Sigur Rós",
        artistMbid: MBID,
      }),
      makeArtistCandidate({
        source: "lastfm:similar",
        score: 0.6,
        name: "Sigur Ros",
      }),
      makeArtistCandidate({
        source: "lastfm:similar",
        score: 0.8,
        name: "Múm",
      }),
    ]);
    expect(merged).toHaveLength(2);
    const sigur = merged.find((m) => m.identity === "sigur ros");
    expect(sigur?.artistMbid).toBe(MBID);
    // 0.6 with two sources beats 0.8 with one.
    expect(merged[0]?.identity).toBe("sigur ros");
  });
});
