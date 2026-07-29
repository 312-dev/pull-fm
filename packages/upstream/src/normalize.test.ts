import { describe, expect, it } from "vitest";

import {
  normalizeKey,
  normalizeTitle,
  trackIdentity,
  trigramSimilarity,
  trigrams,
} from "./normalize.js";

describe("normalizeKey", () => {
  it("strips diacritics so upstreams that disagree still match", () => {
    expect(normalizeKey("Björk")).toBe("bjork");
    expect(normalizeKey("Sigur Rós")).toBe("sigur ros");
    expect(normalizeKey("Beyoncé")).toBe(normalizeKey("Beyonce"));
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeKey("  The   NATIONAL ")).toBe("the national");
  });

  it("strips punctuation", () => {
    expect(normalizeKey("Godspeed You! Black Emperor")).toBe(
      "godspeed you black emperor",
    );
    expect(normalizeKey("A.A.L.")).toBe("a a l");
  });

  it("normalises conjunctions that providers spell differently", () => {
    expect(normalizeKey("Simon & Garfunkel")).toBe(
      normalizeKey("Simon and Garfunkel"),
    );
    expect(normalizeKey("Above + Beyond")).toBe(
      normalizeKey("Above and Beyond"),
    );
  });

  it("keeps non-Latin scripts rather than deleting them", () => {
    expect(normalizeKey("東京事変")).toBe("東京事変");
  });

  it("returns empty for input that normalises away, so it is never stored", () => {
    expect(normalizeKey("!!!???")).toBe("");
    expect(normalizeKey("   ")).toBe("");
  });

  it("does NOT merge distinct artists", () => {
    expect(normalizeKey("Xiu Xiu")).not.toBe(normalizeKey("XX"));
    expect(normalizeKey("The Beatles")).not.toBe(normalizeKey("Beatles"));
  });
});

describe("normalizeTitle", () => {
  it("strips release-variant noise that is not a different recording", () => {
    expect(normalizeTitle("Dreams (2004 Remaster)")).toBe("dreams");
    expect(normalizeTitle("Karma Police - 2011 Remaster")).toBe("karma police");
    expect(normalizeTitle("Rebellion [Radio Edit]")).toBe("rebellion");
  });

  it("leaves a genuine parenthetical alone", () => {
    expect(normalizeTitle("Marquee Moon (Part 2)")).toBe("marquee moon part 2");
  });

  it("does not strip variants in normalizeKey, which the crosswalk uses", () => {
    // A live take is a DIFFERENT recording with a different MBID; merging them
    // in a UNIQUE-keyed crosswalk would be close to unrecoverable.
    expect(normalizeKey("Dreams (Live)")).not.toBe(normalizeKey("Dreams"));
  });
});

describe("trackIdentity", () => {
  it("cannot collide across the artist/title boundary", () => {
    // A space separator would make these two identical, silently merging two
    // different tracks in a shelf.
    expect(trackIdentity("a b", "c")).not.toBe(trackIdentity("a", "b c"));
  });

  it("returns empty when there is nothing to identify", () => {
    // Callers drop an empty identity; grouping by it would bucket every
    // punctuation-only candidate together.
    expect(trackIdentity("???", "!!!")).toBe("");
  });

  it("produces one dedup key per artist and title pair", () => {
    expect(trackIdentity("Björk", "Jóga (Remastered)")).toBe(
      trackIdentity("Bjork", "Joga"),
    );
    expect(trackIdentity("Blur", "Song 2")).not.toBe(
      trackIdentity("Gorillaz", "Song 2"),
    );
  });
});

describe("trigramSimilarity", () => {
  it("pads words the way pg_trgm does", () => {
    expect(trigrams("cat")).toEqual(new Set(["  c", " ca", "cat", "at "]));
  });

  it("scores identical strings at 1 and unrelated ones near 0", () => {
    expect(trigramSimilarity("radiohead", "radiohead")).toBe(1);
    expect(trigramSimilarity("radiohead", "beyonce")).toBeLessThan(0.1);
  });

  it("scores a typo highly enough for a fuzzy crosswalk hit", () => {
    expect(trigramSimilarity("radiohead", "radiohed")).toBeGreaterThan(0.55);
  });

  it("scores a tribute act below the crosswalk threshold", () => {
    expect(
      trigramSimilarity("radiohead", "radiohead tribute band"),
    ).toBeLessThan(0.6);
  });

  it("treats an empty string as no match rather than a perfect one", () => {
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("", "anything")).toBe(0);
  });
});
