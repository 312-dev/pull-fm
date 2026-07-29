/**
 * Pins the `combined_lookup` fold against the DUMP'S OWN OUTPUT.
 *
 * The fixtures below are not invented. Every string in `REAL_DUMP_ROWS` was read
 * out of musicbrainz-canonical-dump-20260717-080003 on 2026-07-29, and the
 * expected key is the `combined_lookup` value that dump published for that row.
 * That is the whole point of this suite: a fold that merely looks reasonable
 * produces keys that match no row, the local table silently answers nothing, and
 * every other test still passes because falling through is legal behaviour.
 *
 * If one of these fails, the fold has drifted from the publisher's and the local
 * lookup is dead. It is not a formatting preference.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalCoverage,
  canonicalFold,
  canonicalKey,
  canonicalKeyVariants,
} from "./canonical-key.js";

/** [artist_credit_name, recording_name, published combined_lookup] */
const REAL_DUMP_ROWS: readonly [string, string, string][] = [
  ["Various Artists", "Pot Pourri Sega", "variousartistspotpourrisega"],
  ["Simon & Garfunkel", "The Boxer", "simongarfunkeltheboxer"],
  [
    "Simon & Garfunkel",
    "So Long, Frank Lloyd Wright",
    "simongarfunkelsolongfranklloydwright",
  ],
  ["Various Artists", "Warriors 98", "variousartistswarriors98"],
  [
    "Various Artists",
    "Breaking Up (X-Clusive Album Mix)",
    "variousartistsbreakingupxclusivealbummix",
  ],
  [
    "Various Artists",
    "It's An Ardcore Thing (X-Clusive H.S.O Remix)",
    "variousartistsitsanardcorethingxclusivehsoremix",
  ],
  [
    "Various Artists",
    "Rush Hour (Vinylgroover Remix)",
    "variousartistsrushhourvinylgrooverremix",
  ],
];

describe("canonicalFold", () => {
  it.each(REAL_DUMP_ROWS)(
    "reproduces the published key for %s / %s",
    (artist, recording, expected) => {
      expect(canonicalKey(artist, recording)).toBe(expected);
    },
  );

  it("strips every non-word character rather than replacing it", () => {
    // Spaces, punctuation and symbols vanish with NO separator. A fold that
    // substituted a space or a hyphen would produce a key of the right shape
    // that equals nothing in the table.
    expect(canonicalFold("A. B - C!")).toBe("abc");
    expect(canonicalFold("!!!")).toBe("");
  });

  it("keeps digits and underscore, because Python's \\w does", () => {
    expect(canonicalFold("Blink 182")).toBe("blink182");
    expect(canonicalFold("foo_bar")).toBe("foo_bar");
  });

  it("folds precomposed and decomposed accents identically", () => {
    // "Björk" written with U+00F6 and with o + U+0308 are different strings and
    // must produce one key, or the same artist resolves twice.
    expect(canonicalFold("Björk")).toBe("bjork");
    expect(canonicalFold("Björk")).toBe("bjork");
    expect(canonicalFold("Sigur Rós")).toBe("sigurros");
    expect(canonicalFold("Mötley Crüe")).toBe("motleycrue");
  });

  it("folds the atomic Latin letters NFKD leaves alone", () => {
    // These have no Unicode decomposition, so NFKD is a no-op on them and only
    // the explicit table gets them to the ASCII the dump published.
    expect(canonicalFold("Sigur Rös ø")).toBe("sigurroso");
    expect(canonicalFold("Æther")).toBe("aether");
    expect(canonicalFold("Straße")).toBe("strasse");
    expect(canonicalFold("Łódź")).toBe("lodz");
    expect(canonicalFold("Þingvellir")).toBe("thingvellir");
  });

  it("applies the strip and the lowercase BEFORE transliterating", () => {
    // The order is observable in the dump: row 2 of the 2026-07-17 file is
    // "Various Artists" + a CJK title and its published key is
    // "variousartistsXiang Chou Si Yun " - capitals and a trailing space that
    // could only survive if unidecode ran last. This implementation cannot
    // transliterate CJK, so it leaves the characters in place; what is asserted
    // here is that everything BEFORE that step happened in the right order.
    expect(canonicalFold("Various Artists")).toBe("variousartists");
    expect(canonicalFold("VARIOUS ARTISTS")).toBe("variousartists");
  });

  it("distributes over concatenation, which is what makes prefix search valid", () => {
    // The artist-prefix scan is only correct if fold(a + b) === fold(a) + fold(b).
    // Asserted rather than assumed, because a fold that trimmed or collapsed
    // would break it silently and return another artist's rows.
    const pairs: [string, string][] = [
      ["Simon & Garfunkel", "The Boxer"],
      ["Björk", "Army of Me"],
      ["A.  B", "  C.D  "],
    ];
    for (const [a, b] of pairs) {
      expect(canonicalKey(a, b)).toBe(canonicalFold(a) + canonicalFold(b));
    }
  });
});

describe("canonicalCoverage", () => {
  it("rejects an empty key", () => {
    expect(canonicalCoverage("")).toBe(false);
  });

  it("rejects a key this implementation could not finish folding", () => {
    // The dump publishes "variousartistsXiang Chou Si Yun " for this row. We
    // cannot produce that, so the key must be reported as unmatchable rather
    // than sent to the database to miss.
    const key = canonicalKey("Various Artists", "乡愁四韵");
    expect(key).not.toBe("");
    expect(canonicalCoverage(key)).toBe(false);
  });

  it("accepts a fully transliterated key", () => {
    expect(canonicalCoverage(canonicalKey("Björk", "Army of Me"))).toBe(true);
  });
});

describe("canonicalKeyVariants", () => {
  it("returns one key when nothing is stripped", () => {
    expect(canonicalKeyVariants("The Beatles", "Come Together")).toEqual([
      "thebeatlescometogether",
    ]);
  });

  it("puts the caller's own title FIRST, before the stripped form", () => {
    // Order is a correctness property, not a preference. Recordings genuinely
    // titled "Live" exist, and preferring the stripped key would resolve a
    // studio take to one of them.
    const variants = canonicalKeyVariants(
      "Pink Floyd",
      "Wish You Were Here - 2011 Remaster",
    );
    expect(variants).toEqual([
      "pinkfloydwishyouwerehere2011remaster",
      "pinkfloydwishyouwerehere",
    ]);
  });

  it("strips bracketed release noise", () => {
    expect(canonicalKeyVariants("Oasis", "Wonderwall (Remastered)")[1]).toBe(
      "oasiswonderwall",
    );
  });

  it("returns nothing for input that folds away entirely", () => {
    expect(canonicalKeyVariants("!!!", "???")).toEqual([]);
  });
});
