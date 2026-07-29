/**
 * Vendor-neutral live-events contract.
 *
 * SeatGeek is the approved vendor; Ticketmaster and JamBase were the
 * alternates, and Bandsintown discontinued its developer API. Keeping the BFF
 * bound to this interface rather than to SeatGeek's response shape is what
 * makes a vendor swap a new file instead of a refactor.
 *
 * WHAT THIS INTERFACE DELIBERATELY DOES NOT MODEL
 * ----------------------------------------------
 * Prices and listings. SeatGeek, verbatim: "the API endpoints do not return
 * individual listings or price information", and the operator confirmed
 * empirically that `stats.lowest_price` and `stats.average_price` come back
 * unpopulated. They are therefore structurally absent here, not optional
 * fields we might one day fill. A nullable `price` would invite a UI that
 * renders "from $--" and a support ticket about it.
 *
 * The product question is only ever "is this artist playing near me", answered
 * with a link out to the vendor.
 *
 * TERMS THAT SHAPE THIS INTERFACE
 * -------------------------------
 * See vendor-specs/seatgeek-api-terms-2025-03-17.md. Three clauses are load
 * bearing here rather than in a policy document nobody reads:
 *
 *   3.1  Attribution is the SeatGeek LOGO, linked to their homepage, in every
 *        place their material is displayed. A text credit does not satisfy it,
 *        which is why `ProviderAttribution` carries an asset reference and a
 *        link target instead of a string.
 *   4.4  No Personal Data may be sent to the API. `EventsQuery` therefore takes
 *        a coarse place name and has no coordinate or postal-code field at all.
 *   7.13 No systematic downloading or storage, and no exposure to a search
 *        engine, directory, or AI/ML system. That bounds our caching and, more
 *        awkwardly, bounds who we may expose this data to downstream.
 */

/** Where a vendor's catalogue is actually good. Drives an honest empty state. */
export type CoverageLevel = "primary" | "limited" | "unknown";

/**
 * Attribution a vendor's terms require, expressed as something a UI can render
 * correctly rather than as a credit string.
 *
 * SeatGeek's terms 3.1 require their LOGO, obtained from their press page, in
 * every place their material is displayed, and every instance must link to
 * their homepage. A `{ source, text }` pair - the shape the feed envelope uses
 * for Last.fm and MusicBrainz - is NOT sufficient for SeatGeek, which is one
 * more reason event data does not flow into the feed envelope.
 *
 * `logoAssetPage` is the press page rather than a direct asset URL on purpose:
 * the asset is versioned by SeatGeek, the Brand Guidelines live at the same
 * place, and hotlinking their CDN is not something their terms grant.
 */
export interface ProviderAttribution {
  readonly source: string;
  /** Alt text for the logo. NOT a substitute for rendering it. */
  readonly text: string;
  /** True when a text credit alone breaches the vendor's terms. */
  readonly logoRequired: boolean;
  /** Where to obtain the logo asset and the brand guidelines that govern it. */
  readonly logoAssetPage: string | undefined;
  /** Every rendered instance MUST link here. */
  readonly linkUrl: string;
  /**
   * What a renderer may do to the asset. SeatGeek permit proportional resizing
   * without approval; anything else needs their written consent.
   */
  readonly logoModification: "proportional-resize-only" | "unrestricted";
}

export interface EventVenue {
  readonly name: string;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly country: string | undefined;
  /** Outbound link, query-stripped. Never carries affiliate parameters. */
  readonly url: string | undefined;
}

export interface LiveEvent {
  /** Vendor-scoped id, e.g. "seatgeek:6543210". */
  readonly id: string;
  readonly title: string;
  readonly type: string | undefined;
  /** ISO 8601 UTC. Undefined when the vendor flags the datetime as TBD. */
  readonly startsAtUtc: string | undefined;
  /** Local wall-clock time at the venue, as the vendor reports it. */
  readonly startsAtLocal: string | undefined;
  readonly datetimeTbd: boolean;
  readonly venue: EventVenue | undefined;
  readonly performerNames: readonly string[];
  /** Link out to the vendor's page. Query-stripped, no affiliate parameters. */
  readonly url: string;
  /** Must be rendered wherever this event is displayed (SeatGeek terms 3.1). */
  readonly attribution: ProviderAttribution;
}

/**
 * A location query, deliberately coarse.
 *
 * There is no `lat`, `lon`, or `postalCode` field, and that is a contractual
 * constraint rather than a simplification. SeatGeek terms 4.4: "the SeatGeek
 * API is not intended for Personal Data, and you agree to not input or process
 * Personal Data using the SeatGeek API." A precise coordinate attached to a
 * request identifies a person's location under GDPR, and a postal code is
 * close enough to it to be worth avoiding for the marginal accuracy it buys.
 *
 * A caller holding coordinates must resolve them to a city name BEFORE calling
 * (from the user's profile, or a geocoder we control). The client rejects
 * anything coordinate-shaped that reaches it anyway.
 */
export interface EventsQuery {
  /** MusicBrainz artist MBID. The only identifier the rest of the app uses. */
  readonly artistMbid: string;
  /** Display name, needed because event vendors do not know MBIDs. */
  readonly artistName: string;
  /** City NAME, e.g. "Chicago". Never a coordinate. */
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  /** ISO 3166-1 alpha-2. Drives the coverage signal. */
  readonly country?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EventsResult {
  readonly events: readonly LiveEvent[];
  /**
   * Coverage for the requested region.
   *
   * `limited` means "we cannot see much here", which is a different message
   * from "this artist has no shows". A user in Berlin seeing a permanently
   * empty shelf with no explanation is a UX bug even when the code is correct.
   */
  readonly coverage: CoverageLevel;
  /** True when the artist could not be matched to a vendor performer at all. */
  readonly artistUnknownToProvider: boolean;
  readonly attribution: ProviderAttribution;
  readonly providerName: string;
}

export interface EventsProviderMetadata {
  readonly providerName: string;
  /** ISO 3166-1 alpha-2 codes where the vendor's catalogue is dependable. */
  readonly primaryCoverage: readonly string[];
  readonly attribution: ProviderAttribution;
  /** True when the vendor exposes no pricing. Always true for SeatGeek. */
  readonly pricingUnavailable: true;
  /**
   * True when the vendor's terms forbid exposing their material to a search
   * engine, directory, or AI/ML system (SeatGeek terms 7.13).
   *
   * Consumers MUST NOT place this data behind a general-purpose API token, a
   * public feed, or anything a crawler or model can reach. Surfaced on the
   * provider so the restriction is visible at the integration point rather
   * than only in a terms document.
   */
  readonly redistributionRestricted: boolean;
}

export interface EventsProvider {
  readonly metadata: EventsProviderMetadata;
  findEventsForArtist(query: EventsQuery): Promise<EventsResult>;
}

/**
 * Strips query and fragment from an outbound vendor link.
 *
 * Pull.fm is locked non-commercial (docs/PLAN.md section 1a), so outbound links
 * carry NO affiliate or tracking parameters - SeatGeek offered affiliate terms
 * in their approval email and it was declined. Taking that revenue would
 * retroactively breach Last.fm ToS 3.1-3.2, Deezer ToS section IV, and Apple's
 * preview terms simultaneously.
 *
 * Stripping the whole query string rather than blacklisting known affiliate
 * parameter names is the point: a blacklist has to be kept current, and the
 * next affiliate parameter will have a name nobody predicted.
 */
export function sanitizeOutboundUrl(url: string): string {
  const cut = Math.min(
    ...[url.indexOf("?"), url.indexOf("#")]
      .filter((i) => i !== -1)
      .concat([url.length]),
  );
  return url.slice(0, cut);
}
