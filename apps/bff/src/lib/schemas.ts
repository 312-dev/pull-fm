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
  403: "The credential is valid but not permitted to perform this operation.",
  404: "No such object, or an object belonging to another subject. The two are deliberately indistinguishable.",
  409: "Conflicting state, or an Idempotency-Key reused with a different body.",
  422: "The request was understood but its contents are not acceptable.",
  429: "Rate limited. Retry after the interval in the Retry-After header.",
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
