/**
 * The product surface: volatile, behind a stable envelope.
 *
 * docs/PLAN.md section 6 splits the API into a platform surface that is the
 * same under every version of this product, and a product surface that will
 * churn once a UI exists. The split exists so "infra before UI" does not mean
 * certifying guesses to a 50,000-user standard.
 *
 * `/feed` returns a typed list of `sections`, each with a `kind`. The client
 * renders by kind and knows nothing about how items were chosen, so the ranking
 * algorithm can change completely without breaking the contract, and a kind a
 * client does not recognise is a shelf it skips rather than a parse error.
 * Gate 2 tests the envelope, not the taxonomy.
 *
 * Two fields are in the contract from day one deliberately:
 *
 *   degraded      When a circuit breaker is open the feed still returns 200
 *                 with fewer sections. Adding the flag at the moment an
 *                 upstream first fails would be a breaking change at exactly
 *                 the wrong time.
 *
 *   attribution   Last.fm's terms require their specified link format and Apple
 *                 requires "provided courtesy of iTunes". Those are licence
 *                 conditions, so the field is mandatory in the schema rather
 *                 than advisory in a comment: a client that cannot see the
 *                 attribution cannot render it, and a product that does not
 *                 render it is in breach. MusicBrainz core data is CC0 and
 *                 needs no credit; it carries one anyway so a mixed shelf can
 *                 say where each item came from.
 *
 * NO ROUTE HERE CALLS MUSICBRAINZ OR ITUNES.
 * ------------------------------------------
 * MusicBrainz permits one request per second across the whole service and
 * iTunes about twenty calls a minute. A handler that reached either
 * synchronously would be a remote kill switch operated by whoever refreshes
 * fastest, so the catalogue routes read the cache and the crosswalk and answer
 * 404 on a miss. "We have not resolved this yet" and "no such record" are
 * genuinely indistinguishable from here, and pretending otherwise would need
 * the very call that is forbidden. See apps/bff/src/services/upstream.ts for
 * the per-provider reasoning, including why ListenBrainz, Last.fm, and Deezer
 * are treated differently.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import { subjectOf } from "../../plugins/auth.js";
import { errors } from "../../lib/errors.js";
import { pageLimit } from "../../lib/cursor.js";
import { annotate, type PullfmAnnotations } from "../../lib/openapi.js";
import {
  albumSchema,
  artistSchema,
  eventsSchema,
  previewSchema,
  problemResponses,
  sectionsEnvelopeSchema,
  similarArtistsSchema,
  trackSchema,
} from "../../lib/schemas.js";
import type { Services } from "../deps.js";

/** A feed section. `kind` lets the client render without knowing the algorithm. */
export interface FeedSection {
  kind:
    | "made_for_you"
    | "because_you_like"
    | "daily_mix"
    | "explore_by_mood"
    | "trending"
    | "connections"
    | "rediscover"
    | "stations"
    | "search_results";
  title: string;
  /** Present when the section is seeded by a specific entity. */
  seed?: { mbid: string; name: string };
  items: unknown[];
}

/** Attribution required by an upstream provider's terms. */
export interface Attribution {
  source: string;
  text: string;
  url?: string;
}

/** The stable envelope every product route returns. */
export interface SectionsEnvelope {
  sections: FeedSection[];
  cursor: string | null;
  degraded: boolean;
  unavailableProviders: string[];
  attribution: Attribution[];
}

const MBID_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["mbid"],
  properties: {
    // Validated as a canonical UUID before it can reach any upstream URL
    // construction (THREAT-MODEL T15/M31). An unvalidated identifier
    // containing `@`, `/`, `?`, `#`, or CRLF redirects a credentialed upstream
    // request, which is the cheapest known path from a request to asset A1.
    mbid: {
      type: "string",
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
  },
} as const;

/**
 * Marks a response as personal.
 *
 * Not decoration: a shared cache that stored one subject's feed and served it
 * to the next is THREAT-MODEL T12 happening inside infrastructure none of our
 * controls reach.
 */
function personalised(reply: FastifyReply): void {
  void reply.header("cache-control", "private, no-store");
}

export function registerProductRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  const { discovery, events } = services;

  const userScoped = (
    objectType: string,
    param?: string,
  ): Record<string, unknown> =>
    annotate({
      authz: "user-scoped",
      dast: "include",
      tokenScope: "read:recommendations",
      bola:
        param === undefined
          ? { strategy: "implicit-subject", objectType, deny: [401] }
          : { strategy: "query-param", objectType, param, deny: [400, 403] },
    });

  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    "/feed",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:recommendations",
      }),
      schema: {
        operationId: "getFeed",
        summary: "The personalised feed",
        description:
          "A typed list of sections behind a stable envelope, so the ranking algorithm can change completely without breaking the client contract. Paged over SECTIONS rather than items: a section is the unit the client renders and the unit whose cost is bounded, and a blend of four sources has no stable global item ordering to page over. The cursor is bound to the requesting subject and a cursor issued to another subject is rejected.",
        tags: ["discovery"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", maxLength: 512 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(400, 401, 403, 429),
        },
        ...userScoped("feed", "cursor"),
      },
    },
    async (request, reply) => {
      personalised(reply);
      return discovery.feed(subjectOf(request).userId, {
        limit: pageLimit(request.query.limit, 50),
        cursor: request.query.cursor,
      });
    },
  );

  app.get<{ Querystring: { seed?: string; limit?: number } }>(
    "/recommendations",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:recommendations",
      }),
      schema: {
        operationId: "getRecommendations",
        summary: "Recommendations for the authenticated account",
        description:
          "The endpoint a personal API token exists for: your own recommendations, in Pull.fm's own derived form, with the attribution the upstream terms require. It is not a proxy for raw Last.fm or MusicBrainz payloads and deliberately exposes none.",
        tags: ["discovery"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            seed: { type: "string", maxLength: 128 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(400, 401, 403, 429),
        },
        ...userScoped("recommendation_set"),
      },
    },
    async (request, reply) => {
      personalised(reply);
      return discovery.recommendations(subjectOf(request).userId, {
        seed: request.query.seed,
        limit: pageLimit(request.query.limit, 50),
      });
    },
  );

  app.get(
    "/stations",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:recommendations",
      }),
      schema: {
        operationId: "listStations",
        summary: "Stations generated for the authenticated account",
        description:
          "A station is derived, not stored: a seed artist plus its owner. Its identifier is a signed value binding both, so there is no station row whose id could be substituted, and a foreign identifier is a 404 without a database lookup.",
        tags: ["discovery"],
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(401, 403, 429),
        },
        ...userScoped("station"),
      },
    },
    async (request, reply) => {
      personalised(reply);
      return discovery.stations(subjectOf(request).userId);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    "/stations/:id/tracks",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:recommendations",
      }),
      schema: {
        operationId: "getStationTracks",
        summary: "Tracks for one station",
        tags: ["discovery"],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", maxLength: 512 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(401, 403, 404, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          tokenScope: "read:recommendations",
          bola: {
            strategy: "path-param",
            objectType: "station",
            param: "id",
            deny: [404],
          },
        }),
      },
    },
    async (request, reply) => {
      personalised(reply);
      return discovery.stationTracks(
        subjectOf(request).userId,
        request.params.id,
        pageLimit(request.query.limit, 50),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Catalogue. Owned by nobody, so BOLA does not apply and a BOLA test could
  // never pass; rate limiting is the control that does apply, because these are
  // the routes that spend metered upstream quota (THREAT-MODEL T16).
  // -------------------------------------------------------------------------
  const catalogue: PullfmAnnotations = {
    authz: "authenticated-shared",
    dast: "include",
  };

  app.get<{ Querystring: { q: string; limit?: number } }>(
    "/search",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "search",
        summary: "Search the catalogue",
        description:
          "Served from our own crosswalk. No user request ever triggers a synchronous upstream call: MusicBrainz allows one request per second globally and iTunes about twenty per minute per IP, so a synchronous fan-out here would be a remote kill switch for the whole service. The crosswalk is warmed by every resolution the feed already performs, so results improve with use rather than needing a backfill first.",
        tags: ["catalogue"],
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 256 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(400, 401, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      // A catalogue answer is identical for every caller, so it is shareable.
      void reply.header("cache-control", "public, max-age=60");
      return discovery.search(
        request.query.q,
        pageLimit(request.query.limit, 50),
      );
    },
  );

  app.get<{ Params: { mbid: string } }>(
    "/artists/:mbid",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getArtist",
        summary: "One artist",
        description:
          "Answered from the MusicBrainz cache when one is warm, otherwise from the name the crosswalk learned from ListenBrainz. `resolution` says which, so a provisional name is not presented as canonical. A 404 means we have never resolved this MBID rather than that no such artist exists; telling those apart needs the MusicBrainz call this route is not permitted to make. Carries core (CC0) fields only: tags, genres and ratings are supplementary data under a NonCommercial ShareAlike licence and are deliberately absent.",
        tags: ["catalogue"],
        params: MBID_PARAM,
        response: {
          200: artistSchema,
          ...problemResponses(400, 401, 404, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      void reply.header("cache-control", "public, max-age=300");
      const artist = await discovery.artist(request.params.mbid);
      if (artist === null) throw errors.notFound("artist");
      return artist;
    },
  );

  app.get<{ Params: { mbid: string }; Querystring: { limit?: number } }>(
    "/artists/:mbid/similar",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getSimilarArtists",
        summary: "Artists similar to one artist",
        description:
          "Blends ListenBrainz labs with Last.fm; agreement between the two raises an artist's score rather than merely deduplicating it. Both sources are app-credentialed, which is why this route needs no user connection. labs.api is an experimental tier with no SLA and contributes nothing rather than degrading the response when it is down.",
        tags: ["catalogue"],
        params: MBID_PARAM,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
        response: {
          200: similarArtistsSchema,
          ...problemResponses(400, 401, 404, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      void reply.header("cache-control", "public, max-age=300");
      return discovery.similarArtists(
        request.params.mbid,
        pageLimit(request.query.limit, 50),
      );
    },
  );

  app.get<{ Params: { mbid: string } }>(
    "/tracks/:mbid",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getTrack",
        summary: "One recording",
        tags: ["catalogue"],
        params: MBID_PARAM,
        response: {
          200: trackSchema,
          ...problemResponses(400, 401, 404, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      void reply.header("cache-control", "public, max-age=300");
      const track = await discovery.track(request.params.mbid);
      if (track === null) throw errors.notFound("recording");
      return track;
    },
  );

  app.get<{ Params: { mbid: string } }>(
    "/tracks/:mbid/preview",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getTrackPreview",
        summary: "A 30 second preview URL",
        description:
          "iTunes URLs are unsigned and permanent, so they are stored and reused. Deezer URLs are signed with an expiry and are re-resolved live, immediately before playback, and never persisted anywhere - a stored one passes every test written against a warm cache and then 403s for users. `expiresAt` and `cacheable` say which was returned. The preview audio itself is streamed and never downloaded, which Apple's terms require independently.",
        tags: ["catalogue"],
        params: MBID_PARAM,
        response: {
          200: previewSchema,
          ...problemResponses(400, 401, 404, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      const preview = await discovery.preview(request.params.mbid);
      if (preview === null) throw errors.notFound("preview");
      // A signed, expiring URL must never be stored by an intermediary, and a
      // cache header is the only control we have over caches we do not operate.
      void reply.header(
        "cache-control",
        preview.cacheable ? "public, max-age=300" : "private, no-store",
      );
      return preview;
    },
  );

  app.get<{ Params: { mbid: string } }>(
    "/albums/:mbid",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getAlbum",
        summary: "One release",
        tags: ["catalogue"],
        params: MBID_PARAM,
        response: {
          200: albumSchema,
          ...problemResponses(400, 401, 404, 429),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      void reply.header("cache-control", "public, max-age=300");
      const album = await discovery.album(request.params.mbid);
      if (album === null) throw errors.notFound("release");
      return album;
    },
  );

  /**
   * Live events.
   *
   * SESSION AUTHENTICATION ONLY, and that is a licence condition rather than a
   * design preference. SeatGeek's terms 7.13 forbid making their material
   * available to "a search engine, directory, or AI or machine learning
   * application or model". A personal API token is a long-lived, script-facing
   * credential whose consumer we cannot see, so putting event data behind it
   * would build a machine-readable events feed one invisible integration away
   * from the thing that clause names. `requireAuth({ allow: ["session"] })`
   * refuses a `pfm_` credential with 403 before the handler runs.
   *
   * The response is deliberately NOT the feed `sections` envelope. Terms 3.1
   * require the SeatGeek logo wherever their material appears, linked to their
   * homepage; the envelope's `{ source, text, url }` attribution cannot express
   * that, so routing events through it would silently drop a contractual
   * obligation while still satisfying our own schema. Full argument in
   * apps/bff/src/services/events.ts.
   *
   * No coordinate or postal code is accepted, because terms 4.4 forbid sending
   * Personal Data to their API and a precise coordinate identifies a person's
   * location under GDPR. A caller holding coordinates resolves them to a city
   * name first.
   */
  app.get<{
    Params: { mbid: string };
    Querystring: {
      city?: string;
      state?: string;
      country?: string;
      limit?: number;
    };
  }>(
    "/artists/:mbid/events",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getArtistEvents",
        summary: "Live events for an artist",
        description:
          "Session authentication only: the provider's terms forbid exposing their material to a search engine, directory, or AI/ML system, and a personal API token is a script-facing credential whose consumer we cannot see. The response carries its own attribution object with `logoRequired`, because the provider requires a logo rather than a text credit, and it is deliberately not the feed sections envelope, whose attribution shape cannot express that. `coverage` and `artistUnknownToProvider` let a client render an honest empty state; the provider is a US and Canada catalogue. Returns 501 when no events provider is enabled on this deployment.",
        tags: ["catalogue"],
        params: MBID_PARAM,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            // City NAME, never a coordinate. There is no lat, lon, or
            // postalCode property here, and adding one would breach terms 4.4.
            city: { type: "string", maxLength: 128 },
            state: { type: "string", maxLength: 64 },
            country: { type: "string", minLength: 2, maxLength: 2 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: eventsSchema,
          ...problemResponses(400, 401, 404, 429, 501),
        },
        ...annotate(catalogue),
      },
    },
    async (request, reply) => {
      if (!events.enabled) {
        throw errors.notImplemented(
          "Live events are not enabled on this deployment.",
        );
      }

      // The provider matches on a NAME, so an artist we cannot name is one we
      // cannot ask about. 404 rather than an empty list: "we do not know this
      // MBID" and "this artist has no shows" are different answers, and
      // `artistUnknownToProvider` already means the second one.
      const artist = await discovery.artist(request.params.mbid);
      if (artist === null) throw errors.notFound("artist");

      const result = await events.forArtist({
        artistMbid: request.params.mbid,
        artistName: artist.name,
        city: request.query.city,
        state: request.query.state,
        country: request.query.country,
        limit: request.query.limit,
      });

      // Their terms bound how long their material may be stored, and a shared
      // edge cache is storage we do not control.
      void reply.header("cache-control", "private, max-age=300");
      return {
        artistMbid: request.params.mbid,
        artistName: artist.name,
        coverage: result.coverage,
        artistUnknownToProvider: result.artistUnknownToProvider,
        events: result.events,
        attribution: result.attribution,
        providerName: result.providerName,
      };
    },
  );
}
