/**
 * The product surface: volatile, behind a stable envelope.
 *
 * docs/PLAN.md section 6 splits the API into a platform surface that is the
 * same under every version of this product, and a product surface that will
 * churn once a UI exists. The split exists so "infra before UI" does not mean
 * certifying guesses to a 50,000-user standard.
 *
 * `packages/discovery` is a separate work stream and is not ready, so every
 * route here returns 501. What is NOT deferred is the contract: the `sections`
 * envelope, the `degraded` flag, the `unavailableProviders` list, and the
 * mandatory `attribution` array are declared now, in the response schemas, and
 * the OpenAPI document carries them. A client can be written against this
 * document today and will not need to change when the handlers land.
 *
 * `degraded` and `attribution` are in the contract from day one deliberately:
 *
 *   degraded      When a circuit breaker is open the feed still returns 200
 *                 with fewer sections. Adding the flag at the moment an
 *                 upstream first fails would be a breaking change at exactly
 *                 the wrong time.
 *
 *   attribution   Last.fm's terms require their specified link format, Apple
 *                 requires "provided courtesy of iTunes", and MusicBrainz
 *                 requires acknowledgement. Those are licence conditions, so
 *                 the field is mandatory in the schema rather than advisory in
 *                 a comment. A client that cannot see the attribution cannot
 *                 render it, and a product that does not render it is in
 *                 breach.
 *
 * Each operation carries `x-pullfm-not-implemented: true` in the emitted spec,
 * so the BOLA suite can distinguish "this route is deliberately 501" from
 * "this route is broken" without a hardcoded list. That exemption is visible in
 * the document, and it disappears the moment the handler lands.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate, type PullfmAnnotations } from "../../lib/openapi.js";
import { problemResponses, sectionsEnvelopeSchema } from "../../lib/schemas.js";
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
    | "rediscover";
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

/** The stable envelope every product route returns once implemented. */
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

/** Marks an operation as deliberately unimplemented, visibly, in the spec. */
function pending(annotations: PullfmAnnotations): Record<string, unknown> {
  return {
    ...annotate(annotations),
    "x-pullfm-not-implemented": true,
  };
}

function notImplemented(name: string): never {
  throw errors.notImplemented(
    `${name} is not implemented yet. The response contract is stable and documented; the ranking implementation lands with packages/discovery.`,
  );
}

export function registerProductRoutes(
  app: FastifyInstance,
  _services: Services,
): void {
  const userScoped = (objectType: string, param?: string) =>
    pending({
      authz: "user-scoped",
      dast: "include",
      tokenScope: "read:recommendations",
      bola:
        param === undefined
          ? { strategy: "implicit-subject", objectType, deny: [401] }
          : { strategy: "query-param", objectType, param, deny: [400, 403] },
    });

  app.get(
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
          "Returns a typed list of sections behind a stable envelope, so the ranking algorithm can change completely without breaking the client contract. Not implemented yet: returns 501 with a problem document.",
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
          ...problemResponses(400, 401, 403, 429, 501),
        },
        ...userScoped("feed", "cursor"),
      },
    },
    () => notImplemented("GET /v1/feed"),
  );

  app.get(
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
          ...problemResponses(400, 401, 403, 429, 501),
        },
        ...userScoped("recommendation_set"),
      },
    },
    () => notImplemented("GET /v1/recommendations"),
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
        tags: ["discovery"],
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(401, 403, 429, 501),
        },
        ...userScoped("station"),
      },
    },
    () => notImplemented("GET /v1/stations"),
  );

  app.get(
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
          properties: { id: { type: "string", maxLength: 128 } },
        },
        response: {
          200: sectionsEnvelopeSchema,
          ...problemResponses(401, 403, 404, 429, 501),
        },
        ...pending({
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
    () => notImplemented("GET /v1/stations/:id/tracks"),
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

  app.get(
    "/search",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "search",
        summary: "Search the catalogue",
        description:
          "Served from our own cache. No user request ever triggers a synchronous upstream call: MusicBrainz allows one request per second globally and iTunes about twenty per minute per IP, so a synchronous fan-out here would be a remote kill switch for the whole service.",
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
          ...problemResponses(400, 401, 429, 501),
        },
        ...pending(catalogue),
      },
    },
    () => notImplemented("GET /v1/search"),
  );

  for (const [path, operationId, summary] of [
    ["/artists/:mbid", "getArtist", "One artist"],
    [
      "/artists/:mbid/similar",
      "getSimilarArtists",
      "Artists similar to one artist",
    ],
    ["/tracks/:mbid", "getTrack", "One recording"],
    ["/tracks/:mbid/preview", "getTrackPreview", "A 30 second preview URL"],
    ["/albums/:mbid", "getAlbum", "One release"],
  ] as const) {
    app.get(
      path,
      {
        preValidation: app.requireAuth({ allow: ["session"] }),
        schema: {
          operationId,
          summary,
          description:
            "Catalogue data, owned by nobody. The identifier is validated as a canonical UUID before use, and upstream URLs are built from encoded components rather than concatenation.",
          tags: ["catalogue"],
          params: MBID_PARAM,
          response: {
            200: { type: "object", additionalProperties: true },
            ...problemResponses(400, 401, 404, 429, 501),
          },
          ...pending(catalogue),
        },
      },
      () => notImplemented(`GET /v1${path}`),
    );
  }

  /**
   * Live events: disabled by operator decision, not merely unimplemented.
   *
   * No provider is approved. Returns a stable 501 so the client can hide the
   * section, rather than 404 which is indistinguishable from a bad route.
   */
  app.get(
    "/artists/:mbid/events",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "getArtistEvents",
        summary: "Live events for an artist (disabled)",
        description:
          "Permanently 501 on this deployment: no events provider is approved. Bandsintown discontinued its developer API, Ticketmaster signup is blocked, and SeatGeek is unapproved.",
        tags: ["catalogue"],
        params: MBID_PARAM,
        response: {
          ...problemResponses(401, 429, 501),
        },
        ...annotate(catalogue),
      },
    },
    () => {
      throw errors.notImplemented(
        "Live events are disabled: no events provider is currently enabled.",
      );
    },
  );
}
