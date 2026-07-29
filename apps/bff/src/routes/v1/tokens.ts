/**
 * Personal API tokens: create, list, revoke, rotate.
 *
 * The operator requirement is that a user can fetch THEIR OWN recommendations
 * from a script. Everything here follows from taking that literally: their own
 * data, read only, with a credential they can see the shape of and destroy at
 * will.
 *
 * Two rules are enforced at this layer rather than in the service, because they
 * are properties of the ROUTE rather than of the token:
 *
 *   1. Every route in this file requires an interactive SESSION. A personal
 *      token cannot mint, rotate, or revoke a token. If it could, a leaked
 *      read-only token would be a persistence mechanism: the attacker mints a
 *      second token and revoking the first accomplishes nothing.
 *
 *   2. The secret is in the response body of exactly two operations, create and
 *      rotate, and it is never retrievable afterwards. `GET /v1/tokens` returns
 *      metadata, and there is no property in its response schema that could
 *      hold a secret even if a handler tried.
 */

import type { FastifyInstance } from "fastify";

import { annotate } from "../../lib/openapi.js";
import {
  apiTokenSchema,
  problemResponses,
  uuidPathParam,
} from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import { TOKEN_SCOPES } from "../../services/tokens.js";
import type { Services } from "../deps.js";

const issuedTokenResponse = {
  type: "object",
  properties: {
    token: {
      type: "string",
      description:
        "The secret, shown exactly once. Pull.fm stores only its SHA-256 digest and cannot show it again. If it is lost, rotate the token.",
    },
    warning: { type: "string" },
    tokenRecord: apiTokenSchema,
  },
  required: ["token", "warning", "tokenRecord"],
} as const;

const SHOWN_ONCE =
  "Copy this now. Only a SHA-256 digest of it is stored, so it cannot be shown again. " +
  "Treat it like a password: it grants read access to your Pull.fm account.";

export function registerTokenRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.post(
    "/tokens",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "createApiToken",
        summary: "Create a personal API token",
        description:
          "Issues a read-only token for scripted access to your own data. The secret is returned once and never again. Requires an interactive session: a personal token cannot create another token.",
        tags: ["tokens"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              description:
                "A label you will recognise later, e.g. 'laptop sync script'.",
            },
            scopes: {
              type: "array",
              maxItems: TOKEN_SCOPES.length,
              items: { type: "string", enum: [...TOKEN_SCOPES] },
              description:
                "Read-only scopes. Defaults to read:me, read:wishlist, read:recommendations.",
            },
            expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
          },
        },
        response: {
          201: issuedTokenResponse,
          ...problemResponses(400, 401, 403, 409, 422, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "api_token",
            deny: [401],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const body = request.body as {
        name: string;
        scopes?: string[];
        expiresInDays?: number;
      };

      const issued = await services.tokens.create(subject.userId, {
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
      });

      // The audit row records the token id, never the token. There is no code
      // path in this application that writes the secret anywhere.
      await services.audit.record({
        userId: subject.userId,
        action: "token.created",
        subjectRef: issued.record.id,
        outcome: "ok",
        detail: {
          scopes: issued.record.scopes,
          expiresAt: issued.record.expiresAt,
        },
        ip: request.ip,
      });

      return reply.code(201).send({
        token: issued.token,
        warning: SHOWN_ONCE,
        tokenRecord: issued.record,
      });
    },
  );

  app.get(
    "/tokens",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "listApiTokens",
        summary: "List your personal API tokens",
        description:
          "Metadata only. The secret is not stored and therefore cannot be listed; only its last four characters are shown, so a token can be identified without being disclosed.",
        tags: ["tokens"],
        response: {
          200: {
            type: "object",
            properties: {
              items: { type: "array", items: apiTokenSchema },
            },
            required: ["items"],
          },
          ...problemResponses(401, 403, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          bola: {
            strategy: "implicit-subject",
            objectType: "api_token",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      return { items: await services.tokens.list(subject.userId) };
    },
  );

  app.delete(
    "/tokens/:id",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "revokeApiToken",
        summary: "Revoke a personal API token",
        description:
          "Takes effect immediately: the next request presenting the token fails the expiry-and-revocation predicate in the same statement as the digest lookup. A token belonging to another account returns 404, not 403, so token ids cannot be enumerated.",
        tags: ["tokens"],
        params: uuidPathParam("id"),
        response: {
          200: apiTokenSchema,
          ...problemResponses(401, 403, 404, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "path-param",
            objectType: "api_token",
            param: "id",
            deny: [404],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { id } = request.params as { id: string };
      const record = await services.tokens.revoke(subject.userId, id);
      await services.audit.record({
        userId: subject.userId,
        action: "token.revoked",
        subjectRef: record.id,
        outcome: "ok",
        ip: request.ip,
      });
      return record;
    },
  );

  app.post(
    "/tokens/:id/rotate",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "rotateApiToken",
        summary: "Rotate a personal API token",
        description:
          "Revokes the old secret and issues a new one with the same scopes, in a single transaction, so there is never a moment when both work or neither does. The replacement records which token it replaced, so a rotation chain is reconstructable during an incident.",
        tags: ["tokens"],
        params: uuidPathParam("id"),
        response: {
          201: issuedTokenResponse,
          ...problemResponses(401, 403, 404, 409, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "path-param",
            objectType: "api_token",
            param: "id",
            deny: [404],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const { id } = request.params as { id: string };
      const issued = await services.tokens.rotate(subject.userId, id);
      await services.audit.record({
        userId: subject.userId,
        action: "token.rotated",
        subjectRef: issued.record.id,
        outcome: "ok",
        detail: { rotatedFrom: id },
        ip: request.ip,
      });
      return reply.code(201).send({
        token: issued.token,
        warning: SHOWN_ONCE,
        tokenRecord: issued.record,
      });
    },
  );
}
