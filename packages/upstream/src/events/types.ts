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
 */

/** Where a vendor's catalogue is actually good. Drives an honest empty state. */
export type CoverageLevel = "primary" | "limited" | "unknown";

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
  readonly attribution: string;
}

export interface EventsQuery {
  /** MusicBrainz artist MBID. The only identifier the rest of the app uses. */
  readonly artistMbid: string;
  /** Display name, needed because event vendors do not know MBIDs. */
  readonly artistName: string;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  /** ISO 3166-1 alpha-2. Drives the coverage signal. */
  readonly country?: string | undefined;
  readonly postalCode?: string | undefined;
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
  readonly attribution: string;
  readonly providerName: string;
}

export interface EventsProviderMetadata {
  readonly providerName: string;
  /** ISO 3166-1 alpha-2 codes where the vendor's catalogue is dependable. */
  readonly primaryCoverage: readonly string[];
  readonly attribution: string;
  /** True when the vendor exposes no pricing. Always true for SeatGeek. */
  readonly pricingUnavailable: true;
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
