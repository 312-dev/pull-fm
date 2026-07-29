/**
 * The per-user credential vault, as an API surface.
 *
 * A deliberate deviation from the fixture spec in `security/testdata/openapi/`
 * is recorded here rather than left to be noticed:
 *
 *   The fixture classifies these routes as `path-param` BOLA with `service` as
 *   the object identity. That is not what `:service` is. It is a two-value
 *   enum, identical for every user, so substituting "subject A's service" for
 *   "subject B's service" substitutes nothing and the resulting test can never
 *   fail. security/BOLA-TESTING.md says as much in its own text ("uses a fixed
 *   service enum, so there is nothing to enumerate").
 *
 *   These routes are therefore classified `implicit-subject`, which is the
 *   accurate description and the testable one: the connection is resolved from
 *   the session (THREAT-MODEL M10), there is no connection id anywhere in the
 *   API, and the assertion that matters is that subject B's response never
 *   contains a trace of subject A.
 *
 * The callback is the interesting route, and it is the one THREAT-MODEL rates
 * Critical (T22). It requires a session AND a state that belongs to that
 * session, which is what makes connection grafting fail in both directions.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate } from "../../lib/openapi.js";
import { connectionSchema, problemResponses } from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import { isProvider, PROVIDERS } from "../../services/connections.js";
import type { Services } from "../deps.js";

const serviceParam = {
  type: "object",
  additionalProperties: false,
  required: ["service"],
  properties: {
    service: { type: "string", enum: [...PROVIDERS] },
  },
} as const;

export function registerConnectionRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.get(
    "/connections",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:connections",
      }),
      schema: {
        operationId: "listConnections",
        summary: "List connected music services",
        description:
          "Metadata only. There is no property in this response that could hold a credential, which is enforced structurally: Fastify serialises with fast-json-stringify and emits only declared properties, so a handler that accidentally selected a ciphertext column could not put it on the wire.",
        tags: ["connections"],
        response: {
          200: {
            type: "object",
            properties: { items: { type: "array", items: connectionSchema } },
            required: ["items"],
          },
          ...problemResponses(401, 403, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          tokenScope: "read:connections",
          bola: {
            strategy: "implicit-subject",
            objectType: "connection",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      return { items: await services.connections.list(subject.userId) };
    },
  );

  /**
   * Starts a connect flow.
   *
   * Two provider shapes, one route:
   *   Last.fm       redirect flow. Returns an authorize URL; the user comes
   *                 back through the callback with a request token that is
   *                 exchanged via auth.getSession.
   *   ListenBrainz  no OAuth at all. The user generates a token on the
   *                 ListenBrainz site and supplies it here, and we verify it
   *                 against the provider before sealing it.
   */
  app.post(
    "/connections/:service",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "startConnection",
        summary: "Begin connecting a music service",
        description:
          "For providers with a redirect flow, returns an authorize URL and mints a single-use state bound to this subject and this provider for ten minutes. For ListenBrainz, accepts the user-generated token directly, verifies it upstream, and seals it into the vault.",
        tags: ["connections"],
        params: serviceParam,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            token: {
              type: "string",
              minLength: 8,
              maxLength: 512,
              description:
                "ListenBrainz only: the user token generated at listenbrainz.org/settings.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              provider: { type: "string" },
              authorizeUrl: { type: ["string", "null"] },
              expiresAt: { type: ["string", "null"] },
              connection: connectionSchema,
            },
            required: ["provider"],
          },
          ...problemResponses(400, 401, 403, 422, 429, 501, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "connection",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { service } = request.params as { service: string };
      if (!isProvider(service)) throw errors.notFound("No such service.");
      const body = (request.body ?? {}) as { token?: string };

      // Direct-credential providers never enter the state machine: there is no
      // redirect, so there is no CSRF surface to protect with a state.
      if (body.token !== undefined) {
        const adapter = services.connections.adapterFor(service);
        if (adapter.verifyDirect === undefined) {
          throw errors.unprocessable(
            `${service} does not accept a directly supplied token. Start the redirect flow instead.`,
          );
        }
        const credential = await adapter.verifyDirect(body.token);
        const connection = await services.connections.store(
          subject.userId,
          service,
          credential,
        );
        await services.audit.record({
          userId: subject.userId,
          action: "connection.created",
          subjectRef: service,
          outcome: "ok",
          ip: request.ip,
        });
        return {
          provider: service,
          authorizeUrl: null,
          expiresAt: null,
          connection,
        };
      }

      const started = await services.connections.startConnect(
        subject.userId,
        service,
      );
      await services.audit.record({
        userId: subject.userId,
        action: "connection.connect_started",
        subjectRef: service,
        outcome: "ok",
        ip: request.ip,
      });
      return {
        provider: service,
        authorizeUrl: started.authorizeUrl,
        expiresAt: started.expiresAt,
      };
    },
  );

  /**
   * The connect callback (THREAT-MODEL T22, rated Critical).
   *
   * Last.fm's `auth.getSession` requires a callback, which docs/PLAN.md section
   * 6 records as a route the original plan was missing. A callback with no
   * server-side state is a connection-grafting vulnerability, and because
   * Last.fm session keys never expire, a successful graft is a permanent read
   * channel into the victim's listening activity.
   *
   * Both directions of the attack are closed by the same predicate:
   *
   *   Attacker's account onto victim's subject: the attacker cannot make the
   *   victim's browser complete a flow, because the state carried in the
   *   callback belongs to the attacker's subject and the DELETE requires
   *   `user_id = <victim>`. Nothing is consumed and nothing is bound.
   *
   *   Victim's account onto attacker's subject: the attacker's session cannot
   *   consume the victim's state for the same reason.
   */
  app.get(
    "/connections/:service/callback",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "connectionCallback",
        summary: "Complete a connect flow",
        description:
          "Consumes the single-use state atomically, requiring that it belongs to the authenticated subject. An unknown, expired, replayed, or foreign state all produce the same 400, so the response cannot be used to probe which states exist.",
        tags: ["connections"],
        params: serviceParam,
        querystring: {
          type: "object",
          additionalProperties: true,
          required: ["state"],
          properties: {
            state: { type: "string", minLength: 8, maxLength: 512 },
            token: { type: "string", maxLength: 512 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              provider: { type: "string" },
              connection: connectionSchema,
            },
            required: ["provider", "connection"],
          },
          ...problemResponses(400, 401, 403, 429, 501, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "query-param",
            objectType: "connect_state",
            param: "state",
            deny: [400, 403],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { service } = request.params as { service: string };
      if (!isProvider(service)) throw errors.notFound("No such service.");

      const query = request.query as Record<string, string>;
      const adapter = services.connections.adapterFor(service);

      await services.connections.consumeState(
        subject.userId,
        query["state"] ?? "",
        service,
      );

      const credential = await adapter.completeCallback(query);
      const connection = await services.connections.store(
        subject.userId,
        service,
        credential,
      );

      await services.audit.record({
        userId: subject.userId,
        action: "connection.callback",
        subjectRef: service,
        outcome: "ok",
        ip: request.ip,
      });

      return { provider: service, connection };
    },
  );

  app.delete(
    "/connections/:service",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "deleteConnection",
        summary: "Disconnect a music service",
        description:
          "Removes the stored credential. The ownership predicate is in the DELETE itself, so a service the caller has not connected simply matches no rows and returns 404.",
        tags: ["connections"],
        params: serviceParam,
        response: {
          200: {
            type: "object",
            properties: {
              provider: { type: "string" },
              disconnected: { type: "boolean" },
            },
            required: ["provider", "disconnected"],
          },
          ...problemResponses(401, 403, 404, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "connection",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { service } = request.params as { service: string };
      if (!isProvider(service)) throw errors.notFound("No such service.");

      const removed = await services.connections.disconnect(
        subject.userId,
        service,
      );
      if (!removed) throw errors.notFound("That service is not connected.");

      await services.audit.record({
        userId: subject.userId,
        action: "connection.deleted",
        subjectRef: service,
        outcome: "ok",
        ip: request.ip,
      });
      return { provider: service, disconnected: true };
    },
  );
}
