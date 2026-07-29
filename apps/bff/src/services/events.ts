/**
 * Live events, and the two contractual rules that shape the whole feature.
 *
 * The vendor is SeatGeek. Their terms
 * (packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md) impose two
 * constraints that are NOT preferences and are NOT enforced anywhere else in
 * the codebase, so they are stated here, at the integration point, rather than
 * only in a terms document nobody re-reads.
 *
 * RULE 1: SESSION AUTHENTICATION ONLY. NEVER A PERSONAL API TOKEN.
 * ---------------------------------------------------------------
 * Terms 7.13 forbid making their material available to "a search engine,
 * directory, or AI or machine learning application or model".
 *
 * A personal API token is a general-purpose, long-lived, script-facing
 * credential. Its entire purpose is to let something that is not a browser read
 * data on a schedule, and we have no way to know what that something is. Put
 * SeatGeek data behind it and the honest description of what we have built is a
 * machine-readable events feed - which is one integration away from being the
 * thing 7.13 names, and the integration would be somebody else's and invisible
 * to us. It is not a risk we can monitor our way out of, so the route accepts
 * `session` only and `requireAuth` refuses a `pfm_` credential with 403 before
 * the handler runs.
 *
 * This is also why `EventsProviderMetadata.redistributionRestricted` exists on
 * the provider: the restriction is visible at the integration point, so the
 * next person to add a surface has to decide about it rather than discover it.
 *
 * RULE 2: EVENTS DO NOT GO INTO THE FEED `sections` ENVELOPE.
 * ----------------------------------------------------------
 * Terms 3.1 require SeatGeek attribution "in the form of the SeatGeek logo
 * currently available at https://seatgeek.com/press", in every place their
 * material is displayed, with every instance linked to their homepage.
 *
 * The feed envelope's attribution is `{ source, text, url }`. That shape can
 * express "Data provided by Last.fm" and cannot express "render this logo,
 * obtained from this page, resized proportionally and not otherwise modified,
 * linked here". Routing events through it would not fail: it would silently
 * produce a response that satisfies our schema while dropping a contractual
 * obligation, and the breach would be invisible until somebody read the terms
 * again. So events are their own endpoint with their own `attribution` payload
 * carrying `logoRequired`, and a client that renders a text credit is visibly
 * wrong rather than quietly non-compliant.
 *
 * COVERAGE IS PART OF THE ANSWER
 * ------------------------------
 * SeatGeek is a US and Canada catalogue. A user in Berlin seeing a permanently
 * empty shelf with no explanation is a UX bug even when every line of code is
 * correct, so `coverage` and `artistUnknownToProvider` travel with the result
 * and let a client say "we cannot see much here" rather than "no shows".
 *
 * NO PERSONAL DATA REACHES THE VENDOR (terms 4.4). The query carries a city
 * NAME and nothing finer. There is no coordinate or postal-code field anywhere
 * in `EventsQuery`, and the client rejects anything coordinate-shaped that
 * reaches it regardless.
 */

import { isUpstreamError, type EventsResult } from "@pull-fm/upstream";

import { errors } from "../lib/errors.js";
import type { UpstreamBundle } from "./upstream.js";

export interface EventsLookup {
  readonly artistMbid: string;
  readonly artistName: string;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly country?: string | undefined;
  readonly limit?: number | undefined;
}

export class EventsService {
  readonly #upstream: UpstreamBundle;

  constructor(upstream: UpstreamBundle) {
    this.#upstream = upstream;
  }

  /** True when this deployment has a credential and the kill switch is on. */
  get enabled(): boolean {
    return this.#upstream.events !== undefined;
  }

  /**
   * Events for one artist.
   *
   * A provider degradation (open breaker, spent quota, kill switch thrown)
   * produces an empty result rather than an error: an events shelf that does
   * not render is a smaller failure than a catalogue page that will not load,
   * and the flags in the response already give the client something honest to
   * say.
   */
  async forArtist(lookup: EventsLookup): Promise<EventsResult> {
    const provider = this.#upstream.events;
    if (provider === undefined) {
      throw errors.notImplemented(
        "Live events are not enabled on this deployment.",
      );
    }

    try {
      return await provider.findEventsForArtist({
        artistMbid: lookup.artistMbid,
        artistName: lookup.artistName,
        city: lookup.city,
        state: lookup.state,
        country: lookup.country,
        limit: lookup.limit,
      });
    } catch (err) {
      if (!isUpstreamError(err)) throw err;
      return {
        events: [],
        coverage: "unknown",
        artistUnknownToProvider: false,
        attribution: provider.metadata.attribution,
        providerName: provider.metadata.providerName,
      };
    }
  }
}
