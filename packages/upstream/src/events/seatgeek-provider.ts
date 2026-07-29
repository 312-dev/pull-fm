/**
 * SeatGeek behind the vendor-neutral EventsProvider interface.
 *
 * TWO-LEVEL CACHE, and the split is the whole design:
 *
 *   performer:<mbid>          -> SeatGeek performer id, cached for 30 days
 *   events:<performerId>:<geo> -> the event list, cached for 6 hours
 *
 * Name resolution is the expensive, unreliable half (slug guessing fails, `q`
 * search is fuzzy), and its answer almost never changes. Event lists change at
 * most daily. Caching them together would force a name resolution every time an
 * event list expired, which is exactly the cost the id cache exists to remove.
 *
 * A resolution miss is a normal empty result, not an error: most artists in a
 * discovery feed are not on tour, and a plausible number are simply not in
 * SeatGeek's catalogue at all.
 */

import { isUpstreamError } from "../errors.js";
import { normalizeKey, trigramSimilarity } from "../normalize.js";
import type { CachedUpstream } from "../cache/cache-first.js";
import type { SeatGeekClient, SeatGeekEvent } from "../seatgeek/client.js";
import {
  SEATGEEK_ATTRIBUTION,
  SEATGEEK_PRIMARY_COVERAGE,
  parseEvent,
} from "../seatgeek/client.js";
import { isRecord, optNumber } from "../json.js";
import type {
  CoverageLevel,
  EventsProvider,
  EventsProviderMetadata,
  EventsQuery,
  EventsResult,
  LiveEvent,
} from "./types.js";
import { sanitizeOutboundUrl } from "./types.js";

/** Performer ids are stable; only a catalogue merge would change one. */
export const PERFORMER_ID_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Event data changes daily at most, so six hours is generous and cheap. */
export const EVENTS_TTL_SECONDS = 6 * 60 * 60;

/**
 * Minimum trigram similarity between the requested artist name and the matched
 * performer name. `q` search is fuzzy enough to return "Radiohead Tribute" for
 * "Radiohead", and a wrong performer id gets cached for 30 days.
 */
export const PERFORMER_MATCH_THRESHOLD = 0.6;

export interface SeatGeekEventsProviderOptions {
  readonly client: SeatGeekClient;
  readonly cache: CachedUpstream;
  readonly now?: () => number;
}

export function coverageFor(country: string | undefined): CoverageLevel {
  if (country === undefined || country === "") return "unknown";
  return SEATGEEK_PRIMARY_COVERAGE.includes(country.toUpperCase())
    ? "primary"
    : "limited";
}

function toLiveEvent(e: SeatGeekEvent): LiveEvent {
  return {
    id: `seatgeek:${String(e.id)}`,
    title: e.shortTitle ?? e.title,
    type: e.type,
    startsAtUtc: e.datetimeTbd ? undefined : e.datetimeUtc,
    startsAtLocal: e.datetimeTbd ? undefined : e.datetimeLocal,
    datetimeTbd: e.datetimeTbd,
    venue:
      e.venue === undefined
        ? undefined
        : {
            name: e.venue.name ?? "Unknown venue",
            city: e.venue.city,
            state: e.venue.state,
            country: e.venue.country,
            url:
              e.venue.url === undefined
                ? undefined
                : sanitizeOutboundUrl(e.venue.url),
          },
    performerNames: e.performers.map((p) => p.name),
    // Every outbound link is query-stripped: no affiliate parameters, ever.
    url: sanitizeOutboundUrl(e.url ?? `https://seatgeek.com/e/${String(e.id)}`),
    attribution: SEATGEEK_ATTRIBUTION,
  };
}

function geoKey(q: EventsQuery): string {
  return [
    q.country?.toUpperCase() ?? "",
    q.state?.toUpperCase() ?? "",
    normalizeKey(q.city ?? ""),
    q.postalCode ?? "",
  ].join("|");
}

export class SeatGeekEventsProvider implements EventsProvider {
  readonly metadata: EventsProviderMetadata = {
    providerName: "seatgeek",
    primaryCoverage: SEATGEEK_PRIMARY_COVERAGE,
    attribution: SEATGEEK_ATTRIBUTION,
    pricingUnavailable: true,
  };

  readonly #client: SeatGeekClient;
  readonly #cache: CachedUpstream;

  constructor(opts: SeatGeekEventsProviderOptions) {
    this.#client = opts.client;
    this.#cache = opts.cache;
  }

  /**
   * MBID -> SeatGeek performer id, cached for 30 days.
   *
   * Negative results are cached too (as 0). Without that, every artist not in
   * SeatGeek's catalogue costs a name search on every single feed render, which
   * is most of the artists in a discovery feed.
   */
  async performerIdFor(
    artistMbid: string,
    artistName: string,
  ): Promise<number | null> {
    const result = await this.#cache.fetch<number>({
      provider: "seatgeek",
      key: `performer:${artistMbid}`,
      ttlSeconds: PERFORMER_ID_TTL_SECONDS,
      load: async () => {
        const candidates = await this.#client.searchPerformers(artistName);
        const want = normalizeKey(artistName);
        let best: { id: number; score: number } | null = null;
        for (const c of candidates) {
          const score = trigramSimilarity(want, normalizeKey(c.name));
          if (best === null || score > best.score) {
            best = { id: c.id, score };
          }
        }
        return {
          performerId:
            best !== null && best.score >= PERFORMER_MATCH_THRESHOLD
              ? best.id
              : 0,
        };
      },
      parse: (payload) => optNumber(payload, "performerId") ?? 0,
    });
    return result.value === 0 ? null : result.value;
  }

  async findEventsForArtist(query: EventsQuery): Promise<EventsResult> {
    const coverage = coverageFor(query.country);
    const empty = (unknownArtist: boolean): EventsResult => ({
      events: [],
      coverage,
      artistUnknownToProvider: unknownArtist,
      attribution: SEATGEEK_ATTRIBUTION,
      providerName: "seatgeek",
    });

    let performerId: number | null;
    try {
      performerId = await this.performerIdFor(
        query.artistMbid,
        query.artistName,
      );
    } catch (err) {
      // A degradation (circuit open, quota spent, kill switch) is not an error
      // the user should see: the events shelf simply does not render.
      if (isUpstreamError(err) && err.isDegradation) return empty(false);
      throw err;
    }
    if (performerId === null) return empty(true);

    const key = `events:${String(performerId)}:${geoKey(query)}`;
    const result = await this.#cache.fetch<LiveEvent[]>({
      provider: "seatgeek",
      key,
      ttlSeconds: EVENTS_TTL_SECONDS,
      load: async () => {
        const events = await this.#client.listEvents({
          performerId,
          city: query.city,
          state: query.state,
          country: query.country,
          postalCode: query.postalCode,
          perPage: query.limit ?? 20,
        });
        // The raw vendor rows are cached, not our mapped shape, so a change to
        // the mapping does not require a cache flush to take effect.
        return { events };
      },
      parse: (payload) => {
        const rows = isRecord(payload) ? payload["events"] : undefined;
        if (!Array.isArray(rows)) return [];
        const out: LiveEvent[] = [];
        for (const row of rows) {
          const parsed = parseCachedEvent(row);
          if (parsed !== null) out.push(parsed);
        }
        return out;
      },
    });

    return {
      events: result.value,
      coverage,
      artistUnknownToProvider: false,
      attribution: SEATGEEK_ATTRIBUTION,
      providerName: "seatgeek",
    };
  }
}

/**
 * Re-parses a cached vendor row through the same parser the live path uses.
 *
 * Casting the cached JSON to `SeatGeekEvent` would be shorter and wrong: a row
 * written by an older build has whatever shape that build produced, and the
 * cache is the one place where yesterday's schema is still live.
 */
function parseCachedEvent(row: unknown): LiveEvent | null {
  const event = parseEvent(row);
  return event === null ? null : toLiveEvent(event);
}
