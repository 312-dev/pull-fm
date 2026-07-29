/**
 * The feed envelope.
 *
 * These types MIRROR `FeedSection` / `SectionsEnvelope` in
 * apps/bff/src/routes/v1/product.ts, deliberately by structure rather than by
 * import.
 * The BFF owns the wire contract and this package must not be able to change
 * it; a compile error in the BFF when the two drift is the intended failure
 * mode, and it is much better than a silent contract change shipped from a
 * package the client never sees.
 *
 * `kind` is what lets the ranking algorithm change completely without breaking
 * a client: the client renders by kind and knows nothing about how items were
 * chosen. Gate 2 tests the envelope, not the taxonomy.
 */

export type FeedSectionKind =
  | "made_for_you"
  | "because_you_like"
  | "daily_mix"
  | "explore_by_mood"
  | "trending"
  | "connections"
  | "rediscover"
  // Not produced by the blend. The BFF returns the same envelope from
  // /v1/stations and /v1/search so a client learns one response shape, and a
  // kind it does not recognise is a shelf it skips rather than a parse error.
  | "stations"
  | "search_results";

export interface FeedSection {
  kind: FeedSectionKind;
  title: string;
  /** Present when the section is seeded by a specific entity. */
  seed?: { mbid: string; name: string };
  items: unknown[];
}

/**
 * Attribution required by an upstream provider's terms.
 *
 * Not decoration: Last.fm's ToS 2.7/4.2.2 mandate a link in their specified
 * `last.fm/music/[artist]` format, Apple requires "provided courtesy of
 * iTunes" alongside a preview, and MusicBrainz requires acknowledgement. A
 * client that drops these puts the whole product in breach, which is why they
 * travel with the data rather than being a static footer.
 */
export interface Attribution {
  source: string;
  text: string;
  /** Omitted, never undefined: the BFF schema marks it optional. */
  url?: string;
}

export interface SectionsEnvelope {
  sections: FeedSection[];
  cursor: string | null;
  /**
   * True when at least one provider could not contribute.
   *
   * Part of the contract from day one: an open circuit breaker must produce a
   * 200 with fewer sections, and the client needs to be able to say so.
   */
  degraded: boolean;
  unavailableProviders: string[];
  /** Union of every provider that contributed to this response. */
  attribution: Attribution[];
}

/** A track as the client receives it. Items are `unknown[]` on the wire. */
export interface FeedTrackItem {
  readonly type: "track";
  readonly recordingMbid: string | undefined;
  readonly title: string;
  readonly artistName: string;
  readonly artistMbid: string | undefined;
  /** 0-1, comparable only within one section. */
  readonly score: number;
  /** Every source that independently suggested this track. */
  readonly sources: readonly string[];
  /**
   * Attribution links required by the providers that contributed. Last.fm's
   * terms mandate a `last.fm/music/[artist]` link in a specific format.
   */
  readonly attribution: readonly Attribution[];
}

export interface FeedArtistItem {
  readonly type: "artist";
  readonly artistMbid: string | undefined;
  readonly name: string;
  readonly score: number;
  readonly sources: readonly string[];
  readonly attribution: readonly Attribution[];
}

export interface FeedPlaylistItem {
  readonly type: "playlist";
  readonly identifier: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly sources: readonly string[];
  readonly attribution: readonly Attribution[];
}
