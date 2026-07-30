/**
 * Shared JSON Schema fragments.
 *
 * These are not a convenience layer. Two of the strongest controls in the API
 * are properties of these schemas rather than of any handler:
 *
 *   M12  Every response has a declared schema, and Fastify serialises with
 *        fast-json-stringify, which emits ONLY declared properties. A handler
 *        that accidentally selects `access_token_ct` into its result cannot put
 *        it on the wire, because there is no property for it to occupy. That is
 *        a structural guarantee, not a review item.
 *
 *   M14  Every request body declares `additionalProperties: false`, so a mass
 *        assignment such as `POST /v1/wishlist {"user_id": "<victim>"}` is a
 *        400 from the validator before any code runs.
 */

/**
 * A published legal document a user must accept.
 *
 * Shared, because it appears in three places that must agree: the consent status
 * response, the acceptance response, and the `consent` extension member of the
 * 403 that refuses an un-accepted subject. Three hand-written copies of this
 * object would drift, and the one that drifted would be the one a client parsed.
 */
export const legalDocumentSchema = {
  type: "object",
  properties: {
    documentId: { type: "string" },
    version: {
      type: "string",
      description:
        "The publication version. Echo this back when accepting; an acceptance for any other version is refused with 409.",
    },
    consentEpoch: {
      type: "integer",
      description:
        "Raised only by a MATERIAL revision. An acceptance of an earlier epoch no longer satisfies the gate; an acceptance of this epoch does, even after the version changes for a corrected typo.",
    },
    contentSha256: {
      type: "string",
      description:
        "sha256 of the canonical document with line endings normalised and trailing whitespace stripped. Fetch the document, compute this, and echo it when accepting: an acceptance whose digest does not match is refused, so a client cannot record assent against a stale bundled copy.",
    },
    url: { type: "string" },
    effectiveAt: {
      type: ["string", "null"],
      description:
        "Reported for display. Null means published but not yet effective. The gate never consults it; the consentEpoch is what binds.",
    },
    publishedAt: {
      type: ["string", "null"],
      description:
        "When this server first recorded the revision, from its own append-only revision table rather than from the deployed build.",
    },
  },
  required: ["documentId", "version", "consentEpoch", "contentSha256", "url"],
} as const;

/** RFC 9457 problem document, as produced by lib/errors.ts. */
export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    /**
     * DECLARED HERE RATHER THAN ONLY SET BY THE HANDLER, AND IT HAS TO BE.
     *
     * Fastify serialises a problem body with fast-json-stringify against the
     * route's declared schema for that status, which emits declared properties
     * only. An RFC 9457 extension member that is not declared here is therefore
     * not "undocumented", it is DELETED on the way out, and the client that
     * needed it sees a 403 with no idea what to render.
     *
     * Present only on `https://pull.fm/problems/consent-required`.
     */
    consent: {
      type: "object",
      description:
        "Only on a consent-required refusal. `reason` is never-accepted (no contract exists, every route except sign-out, reading your own account, the consent endpoints and the export/deletion rights is refused) or revision-pending (an earlier version was accepted, so reads still work and writes do not).",
      properties: {
        reason: {
          type: "string",
          enum: ["never-accepted", "revision-pending"],
        },
        outstanding: { type: "array", items: legalDocumentSchema },
      },
      required: ["reason", "outstanding"],
    },
  },
  required: ["type", "title", "status"],
} as const;

/**
 * Attaches the standard failure responses to an operation.
 *
 * Generic in the status codes so Fastify's own reply typing knows which codes a
 * handler may send. A handler that returns a status it did not declare is then
 * a type error rather than a response that the serialiser passes through
 * unvalidated, which is the same M12 property applied to failure paths.
 */
export function problemResponses<const C extends readonly number[]>(
  ...codes: C
): Record<C[number], unknown> {
  const responses: Record<string, unknown> = {};
  for (const code of codes) {
    responses[String(code)] = {
      description: PROBLEM_DESCRIPTIONS[code] ?? "Problem",
      content: { "application/problem+json": { schema: problemSchema } },
    };
  }
  return responses;
}

const PROBLEM_DESCRIPTIONS: Record<number, string> = {
  400: "Malformed request, or an invalid cursor or download link.",
  401: "No credential, or a credential that is not valid.",
  // Broadened deliberately. This map is keyed on the STATUS, so one sentence has
  // to describe every 403 in the API, and 403 is no longer only about a
  // credential: `registration-closed` refuses a sign-in that carries no
  // credential at all, and `consent-required` refuses a valid one. Leaving the
  // credential-only wording would have made the published description wrong for
  // the sign-in routes rather than merely incomplete. Switch on `type`, not on
  // this text.
  403: "The request was refused. Either the credential is valid but not permitted to perform this operation, or the operation itself is not open to the caller. The problem document's `type` says which.",
  404: "No such object, or an object belonging to another subject. The two are deliberately indistinguishable.",
  409: "Conflicting state, or an Idempotency-Key reused with a different body.",
  422: "The request was understood but its contents are not acceptable.",
  429: "Rate limited. Retry after the interval in the Retry-After header.",
  451: "Pull.fm is not offered in the caller's region. Retrying will not help, and no credential changes the answer.",
  501: "Not implemented on this deployment.",
  503: "A dependency is unavailable, or the service is in maintenance.",
};

/** A cursor-paginated envelope. Same shape everywhere, so clients learn it once. */
export function pageSchema(
  itemSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: itemSchema },
      cursor: {
        type: ["string", "null"],
        description:
          "Opaque cursor for the next page, or null at the end. Bound to the requesting subject; a cursor issued to another subject is rejected.",
      },
    },
    required: ["items", "cursor"],
  };
}

/** Standard pagination query parameters. */
export const paginationQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    cursor: { type: "string", maxLength: 512 },
  },
} as const;

export const uuidPathParam = (name: string): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: [name],
  properties: {
    [name]: { type: "string", format: "uuid" },
  },
});

/** A wishlist item as it appears on the wire. */
export const wishlistItemSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    recordingMbid: { type: ["string", "null"] },
    releaseMbid: { type: ["string", "null"] },
    artistMbid: { type: ["string", "null"] },
    artistName: { type: "string" },
    title: { type: "string" },
    source: { type: "string" },
    status: { type: "string" },
    note: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    acquiredAt: { type: ["string", "null"] },
  },
  required: ["id", "artistName", "title", "status", "createdAt"],
} as const;

/**
 * A connection as it appears on the wire.
 *
 * There is no property here that could hold a credential, and that is the
 * enforcement: `fast-json-stringify` emits declared properties only.
 */
export const connectionSchema = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["listenbrainz", "lastfm"] },
    providerAccountId: { type: "string" },
    status: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    connectedAt: { type: "string", format: "date-time" },
    lastVerifiedAt: { type: ["string", "null"] },
  },
  required: ["provider", "providerAccountId", "status", "connectedAt"],
} as const;

/** Public metadata for a personal API token. Never the secret. */
export const apiTokenSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    tokenPrefix: { type: "string", enum: ["pfm_live", "pfm_test"] },
    lastFour: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    rateLimitPerMinute: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    lastUsedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] },
    rotatedFromId: { type: ["string", "null"] },
  },
  required: [
    "id",
    "name",
    "tokenPrefix",
    "lastFour",
    "scopes",
    "createdAt",
    "expiresAt",
  ],
} as const;

/**
 * The stable product envelope.
 *
 * docs/PLAN.md section 6: `/feed` returns a typed list of sections, each with a
 * `kind`, so the ranking algorithm can change completely without breaking the
 * client contract. `degraded` and `unavailableProviders` are in the contract
 * from day one because retrofitting them at the moment an upstream first fails
 * would be a breaking change at the worst possible time.
 */
export const sectionsEnvelopeSchema = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "made_for_you",
              "because_you_like",
              "daily_mix",
              "explore_by_mood",
              "trending",
              "connections",
              "rediscover",
              "stations",
              "search_results",
            ],
          },
          title: { type: "string" },
          seed: {
            type: "object",
            properties: {
              mbid: { type: "string" },
              name: { type: "string" },
            },
          },
          items: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["kind", "title", "items"],
      },
    },
    cursor: { type: ["string", "null"] },
    degraded: { type: "boolean" },
    unavailableProviders: { type: "array", items: { type: "string" } },
    attribution: {
      type: "array",
      description:
        "Mandatory upstream attribution. Last.fm requires its specified link format and MusicBrainz requires acknowledgement; clients must render these.",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          text: { type: "string" },
          url: { type: "string" },
        },
        required: ["source", "text"],
      },
    },
  },
  required: [
    "sections",
    "cursor",
    "degraded",
    "unavailableProviders",
    "attribution",
  ],
} as const;

// ---------------------------------------------------------------------------
// Catalogue responses.
//
// Every one of these declares `attribution` as REQUIRED. Last.fm's terms
// mandate their specified link format, Apple requires "provided courtesy of
// iTunes" alongside a preview, and MusicBrainz requires acknowledgement. A
// client that cannot see the attribution cannot render it, and a product that
// does not render it is in breach, so the field is part of the contract rather
// than an advisory note.
//
// `resolution` says where a record came from. A catalogue route may answer from
// a full MusicBrainz record or from the thinner name the crosswalk learned, and
// a client that cannot tell them apart will present a provisional name as
// canonical.
// ---------------------------------------------------------------------------

const attributionArray = {
  type: "array",
  items: {
    type: "object",
    properties: {
      source: { type: "string" },
      text: { type: "string" },
      url: { type: "string" },
    },
    required: ["source", "text"],
  },
} as const;

export const artistSchema = {
  type: "object",
  properties: {
    mbid: { type: "string" },
    name: { type: "string" },
    sortName: { type: ["string", "null"] },
    country: { type: ["string", "null"] },
    beganYear: { type: ["integer", "null"] },
    // No `tags` property, and its absence is the enforcement. MusicBrainz core
    // data is CC0; tags, genres and ratings are supplementary data under
    // CC BY-NC-SA 3.0. Declaring the property would let a handler put
    // NonCommercial + ShareAlike content on the wire, including through the
    // personal API token surface. See docs/compliance/metabrainz-terms-review.md.
    resolution: { type: "string", enum: ["musicbrainz", "crosswalk"] },
    attribution: attributionArray,
  },
  required: ["mbid", "name", "resolution", "attribution"],
} as const;

export const similarArtistsSchema = {
  type: "object",
  properties: {
    artists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          artistMbid: { type: ["string", "null"] },
          name: { type: "string" },
          score: { type: "number" },
          sources: { type: "array", items: { type: "string" } },
          attribution: attributionArray,
        },
        required: ["name", "score", "sources", "attribution"],
      },
    },
    degraded: { type: "boolean" },
    unavailableProviders: { type: "array", items: { type: "string" } },
    attribution: attributionArray,
  },
  required: ["artists", "degraded", "unavailableProviders", "attribution"],
} as const;

export const trackSchema = {
  type: "object",
  properties: {
    mbid: { type: "string" },
    title: { type: "string" },
    artistName: { type: "string" },
    artistMbid: { type: ["string", "null"] },
    durationMs: { type: ["integer", "null"] },
    resolution: { type: "string", enum: ["musicbrainz"] },
    attribution: attributionArray,
  },
  required: ["mbid", "title", "artistName", "resolution", "attribution"],
} as const;

export const albumSchema = {
  type: "object",
  properties: {
    mbid: { type: "string" },
    title: { type: "string" },
    artistName: { type: "string" },
    artistMbid: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    country: { type: ["string", "null"] },
    trackCount: { type: ["integer", "null"] },
    resolution: { type: "string", enum: ["musicbrainz"] },
    attribution: attributionArray,
  },
  required: ["mbid", "title", "artistName", "resolution", "attribution"],
} as const;

/**
 * A 30 second preview.
 *
 * `expiresAt` and `cacheable` are on the wire because the two providers behave
 * differently and only the server knows which one answered. An iTunes URL is
 * unsigned and permanent; a Deezer URL is signed and dies in minutes, so a
 * client that caches one serves its user a 403 later. Making the client infer
 * that from `provider` would work right up until a third provider is added.
 */
export const previewSchema = {
  type: "object",
  properties: {
    recordingMbid: { type: "string" },
    provider: { type: "string", enum: ["itunes", "deezer"] },
    url: { type: "string" },
    durationMs: { type: ["integer", "null"] },
    expiresAt: { type: ["integer", "null"] },
    cacheable: { type: "boolean" },
    attribution: {
      type: "object",
      description:
        "What must be rendered alongside this preview. Apple's grant is six CONJUNCTIVE conditions: condition (iii) requires the exact phrase in `text`, and condition (ii) requires an approved store badge, proximate to the preview, linking directly to the page where THIS track can be purchased. A client that plays the preview without the badge is outside the licence, not merely impolite, which is why the badge travels inside the same object as the URL.",
      properties: {
        source: { type: "string", enum: ["itunes", "deezer"] },
        text: { type: "string" },
        badge: {
          type: "object",
          description:
            "Present only where a licence conditions playback on a store badge. NOT the same obligation as the events endpoint's logo: that one links to a provider homepage, this one links to a specific track's purchase page.",
          properties: {
            required: { type: "boolean" },
            variants: {
              type: "array",
              items: { type: "string" },
              description:
                'The badge artwork Apple actually ships. The clause names a "Download on iTunes" badge that no longer exists.',
            },
            assetPage: { type: "string" },
            linkUrl: {
              type: "string",
              description:
                "This track's purchase page. A provider homepage does not satisfy the condition.",
            },
            placement: { type: "string", enum: ["proximate-to-preview"] },
            ordering: {
              type: "string",
              enum: ["first"],
              description:
                "Apple's guidelines require their badge first where several services' badges share a layout.",
            },
          },
          required: [
            "required",
            "variants",
            "assetPage",
            "linkUrl",
            "placement",
            "ordering",
          ],
        },
      },
      required: ["source", "text"],
    },
  },
  required: [
    "recordingMbid",
    "provider",
    "url",
    "expiresAt",
    "cacheable",
    "attribution",
  ],
} as const;

/**
 * Live events.
 *
 * NOT the `sections` envelope, and the attribution object is why. SeatGeek's
 * terms 3.1 require their LOGO wherever their material appears, linked to their
 * homepage, and the feed envelope's `{ source, text, url }` cannot express
 * that. Routing events through the feed would produce a response that satisfies
 * our schema while silently dropping a contractual obligation. See
 * apps/bff/src/services/events.ts for the full argument.
 *
 * `coverage` and `artistUnknownToProvider` are required so a client can render
 * an honest empty state: "we cannot see much here" and "this artist has no
 * shows" are different answers, and SeatGeek is a US and Canada catalogue.
 */
export const eventsSchema = {
  type: "object",
  properties: {
    artistMbid: { type: "string" },
    artistName: { type: "string" },
    coverage: {
      type: "string",
      enum: ["primary", "limited", "unknown"],
      description:
        "How dependable this provider's catalogue is for the requested region. `limited` means we cannot see much here, which is a different message from an artist having no shows.",
    },
    artistUnknownToProvider: {
      type: "boolean",
      description:
        "True when the artist could not be matched to a provider performer at all.",
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          type: { type: ["string", "null"] },
          startsAtUtc: { type: ["string", "null"] },
          startsAtLocal: { type: ["string", "null"] },
          datetimeTbd: { type: "boolean" },
          venue: {
            type: ["object", "null"],
            properties: {
              name: { type: "string" },
              city: { type: ["string", "null"] },
              state: { type: ["string", "null"] },
              country: { type: ["string", "null"] },
              url: { type: ["string", "null"] },
            },
            required: ["name"],
          },
          performerNames: { type: "array", items: { type: "string" } },
          url: { type: "string" },
        },
        required: ["id", "title", "datetimeTbd", "url"],
      },
    },
    attribution: {
      type: "object",
      description:
        "Attribution the provider's terms require. `logoRequired` true means a text credit alone is a breach: the logo must be obtained from `logoAssetPage` and every rendered instance must link to `linkUrl`.",
      properties: {
        source: { type: "string" },
        text: { type: "string" },
        logoRequired: { type: "boolean" },
        logoAssetPage: { type: ["string", "null"] },
        linkUrl: { type: "string" },
        logoModification: {
          type: "string",
          enum: ["proportional-resize-only", "unrestricted"],
        },
      },
      required: [
        "source",
        "text",
        "logoRequired",
        "linkUrl",
        "logoModification",
      ],
    },
    providerName: { type: "string" },
  },
  required: [
    "artistMbid",
    "artistName",
    "coverage",
    "artistUnknownToProvider",
    "events",
    "attribution",
    "providerName",
  ],
} as const;
