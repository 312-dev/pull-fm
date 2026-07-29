/**
 * The wishlist.
 *
 * The reference implementation of the two cross-cutting requirements in
 * docs/PLAN.md section 6: cursor pagination everywhere, and `Idempotency-Key`
 * on every mutating call. Both are here in full rather than deferred, because
 * both change the response contract and retrofitting either after a client
 * exists is a breaking change.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import { pageLimit } from "../../lib/cursor.js";
import {
  claim,
  complete,
  fingerprint,
  release,
  requireIdempotencyKey,
} from "../../lib/idempotency.js";
import { annotate } from "../../lib/openapi.js";
import {
  pageSchema,
  problemResponses,
  paginationQuery,
  uuidPathParam,
  wishlistItemSchema,
} from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import {
  WISHLIST_SOURCES,
  WISHLIST_STATUSES,
} from "../../services/wishlist.js";
import type { Services } from "../deps.js";

const MBID = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

export function registerWishlistRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.get(
    "/wishlist",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:wishlist",
      }),
      schema: {
        operationId: "listWishlist",
        summary: "List wishlist items, newest first",
        description:
          "Keyset pagination. The cursor is opaque, integrity-protected, and bound to the subject it was issued to, and the SQL predicate ANDs user_id unconditionally, so a forged cursor can only reposition a caller within their own rows.",
        tags: ["wishlist"],
        querystring: {
          ...paginationQuery,
          properties: {
            ...paginationQuery.properties,
            status: { type: "string", enum: [...WISHLIST_STATUSES] },
          },
        },
        response: {
          200: pageSchema(wishlistItemSchema),
          ...problemResponses(400, 401, 403, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          tokenScope: "read:wishlist",
          bola: {
            strategy: "query-param",
            objectType: "wishlist_item",
            param: "cursor",
            deny: [400, 403],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const query = request.query as {
        limit?: number;
        cursor?: string;
        status?: string;
      };
      return services.wishlist.list(subject.userId, {
        limit: pageLimit(query.limit),
        cursor: query.cursor,
        status: query.status,
      });
    },
  );

  /**
   * Adds an item.
   *
   * The idempotency claim and the insert share one transaction. If they did
   * not, a crash between them would leave a claimed key with no response, and
   * every retry of that request would receive 409 forever.
   */
  app.post(
    "/wishlist",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "addWishlistItem",
        summary: "Add an item to the wishlist",
        description:
          "Requires an Idempotency-Key. A retry with the same key returns the original response rather than re-executing; the same key with a different body returns 409. The record is keyed on (subject, key), so a key observed or guessed from another user matches nothing.",
        tags: ["wishlist"],
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", minLength: 8, maxLength: 255 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["artistName", "title"],
          properties: {
            recordingMbid: MBID,
            releaseMbid: MBID,
            artistMbid: MBID,
            artistName: { type: "string", minLength: 1, maxLength: 512 },
            title: { type: "string", minLength: 1, maxLength: 512 },
            source: { type: "string", enum: [...WISHLIST_SOURCES] },
            note: { type: "string", maxLength: 2048 },
          },
        },
        response: {
          201: wishlistItemSchema,
          ...problemResponses(400, 401, 403, 409, 422, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          bola: {
            strategy: "implicit-subject",
            objectType: "wishlist_item",
            deny: [401],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const key = requireIdempotencyKey(request.headers["idempotency-key"]);
      const hash = fingerprint("POST", "/v1/wishlist", request.body);

      const stored = await services.db.transaction((client) =>
        claim(client, subject.userId, key, hash),
      );
      if (stored !== null) {
        // Replays the ORIGINAL response, status and body, rather than
        // re-executing. The cast widens back to the base reply type because the
        // stored status is a runtime value, not one of the literals Fastify
        // inferred from this route's response schema.
        return (reply as FastifyReply).code(stored.status).send(stored.body);
      }

      try {
        const item = await services.db.transaction(async (client) => {
          const created = await services.wishlist.create(
            client,
            subject.userId,
            request.body as Parameters<typeof services.wishlist.create>[2],
          );
          await complete(client, subject.userId, key, {
            status: 201,
            body: created,
          });
          return created;
        });
        return await reply.code(201).send(item);
      } catch (err) {
        // Free the key so a retry is not permanently answered with 409.
        await release(services.db, subject.userId, key).catch(() => undefined);
        throw err;
      }
    },
  );

  app.delete(
    "/wishlist/:id",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "deleteWishlistItem",
        summary: "Remove a wishlist item",
        description:
          "The ownership predicate is in the DELETE. An item belonging to another account returns 404, not 403, because a 403 would confirm the id exists and belongs to someone, which is an enumeration oracle over the whole table.",
        tags: ["wishlist"],
        params: uuidPathParam("id"),
        response: {
          204: { type: "null" },
          ...problemResponses(401, 403, 404, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          bola: {
            strategy: "path-param",
            objectType: "wishlist_item",
            param: "id",
            deny: [404],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const { id } = request.params as { id: string };
      await services.wishlist.remove(subject.userId, id);
      return reply.code(204).send();
    },
  );

  /**
   * Purchase links.
   *
   * NO affiliate parameters, on any link, ever. docs/PLAN.md section 1a makes
   * this a hard rule: an affiliate tag would retroactively breach the Last.fm,
   * Deezer, and Apple terms simultaneously, and non-commercial status is the
   * single decision that unblocked all three.
   */
  app.get(
    "/wishlist/:id/acquire",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:wishlist",
      }),
      schema: {
        operationId: "acquireWishlistItem",
        summary: "Purchase links for a wishlist item",
        description:
          "Plain search links to stores that sell the recording. Pull.fm is non-commercial, so these carry no affiliate parameters and never will.",
        tags: ["wishlist"],
        params: uuidPathParam("id"),
        response: {
          200: {
            type: "object",
            properties: {
              item: wishlistItemSchema,
              links: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    store: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["store", "url"],
                },
              },
            },
            required: ["item", "links"],
          },
          ...problemResponses(401, 403, 404, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          tokenScope: "read:wishlist",
          bola: {
            strategy: "path-param",
            objectType: "wishlist_item",
            param: "id",
            deny: [404],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { id } = request.params as { id: string };
      return services.wishlist.acquire(subject.userId, id);
    },
  );
}
