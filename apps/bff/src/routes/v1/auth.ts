/**
 * Sign-in, refresh, and sign-out.
 *
 * docs/PLAN.md section 4: WorkOS AuthKit, social and magic link only, no
 * passwords ever. That is not a convenience decision. WorkOS does not export
 * password hashes at all, so the only way to keep the migration path open is to
 * never create a hash for them to withhold. It also deletes an entire
 * vulnerability class: no password store, no reset flow, no stuffing surface.
 *
 * The consequence for this file is that there is no login endpoint. AuthKit
 * runs the interactive part, and the only thing that comes back to us is an
 * authorization code, which we exchange here.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate } from "../../lib/openapi.js";
import { problemResponses } from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import type { Services } from "../deps.js";

/**
 * A session as returned to a client.
 *
 * Yes, this response contains tokens, and it is the one place in the API that
 * ever does. It is the sign-in response: there is no way to hand a client a
 * session without handing it a session. Every OTHER route is covered by the
 * rule that no response contains a credential, which is why this operation is
 * classified `public` rather than `user-scoped` and is therefore not iterated
 * by the BOLA suite's credential-shape assertion. That exemption is visible in
 * the annotation rather than hidden in the suite.
 */
const sessionResponse = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: ["string", "null"] },
        displayName: { type: ["string", "null"] },
      },
      required: ["id"],
    },
  },
  required: ["accessToken", "refreshToken", "user"],
} as const;

export function registerAuthRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  /**
   * AuthKit callback.
   *
   * A GET because AuthKit redirects a browser here. The code is single-use at
   * WorkOS, so replay protection is the provider's and does not need to be
   * duplicated locally.
   */
  app.get(
    "/auth/callback",
    {
      schema: {
        operationId: "authCallback",
        summary: "Exchange an AuthKit authorization code for a session",
        description:
          "Called by WorkOS AuthKit after an interactive sign-in. Exchanges the single-use code for an access token, a refresh token, and the local user record, creating that record on first sign-in.",
        tags: ["auth"],
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: {
            code: { type: "string", minLength: 1, maxLength: 2048 },
            code_verifier: { type: "string", maxLength: 256 },
            state: { type: "string", maxLength: 512 },
          },
        },
        response: {
          200: sessionResponse,
          ...problemResponses(401, 429, 503),
        },
        ...annotate({ authz: "public", dast: "exclude" }),
      },
    },
    async (request) => {
      const query = request.query as { code: string; code_verifier?: string };
      const session = await services.workos.authenticateWithCode(
        query.code,
        query.code_verifier,
      );

      const user = await services.users.upsert({
        workosUserId: session.user.id,
        email: session.user.email,
        displayName:
          [session.user.firstName, session.user.lastName]
            .filter((p): p is string => p !== null && p.length > 0)
            .join(" ") || null,
      });

      await services.audit.record({
        userId: user.id,
        action: "auth.callback",
        outcome: "ok",
        ip: request.ip,
      });

      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
        },
      };
    },
  );

  /** Exchanges a refresh token for a new session. */
  app.post(
    "/auth/refresh",
    {
      schema: {
        operationId: "authRefresh",
        summary: "Exchange a refresh token for a new session",
        tags: ["auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
        response: {
          200: sessionResponse,
          ...problemResponses(400, 401, 429, 503),
        },
        ...annotate({ authz: "public", dast: "exclude" }),
      },
    },
    async (request) => {
      const body = request.body as { refreshToken: string };
      const session = await services.workos.refresh(body.refreshToken);
      const user = await services.users.upsert({
        workosUserId: session.user.id,
        email: session.user.email,
        displayName: null,
      });
      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
        },
      };
    },
  );

  /**
   * Sign-out, meaning revocation rather than "forget the token client side".
   *
   * Both halves are necessary and neither is sufficient:
   *
   *   Upstream  WorkOS revokes the session, so the refresh token stops minting
   *             new access tokens. Without this, "sign out" lasts until the
   *             current access token expires and then quietly un-signs-out.
   *
   *   Local     The session id is added to a deny list in the QUOTA Redis for
   *             the remaining lifetime of the access token, so the token the
   *             client already holds stops working immediately rather than at
   *             its natural expiry. The quota instance is used because it runs
   *             `noeviction`: on the LRU cache instance a revocation entry is
   *             evictable, and a cache-fill event would silently un-revoke
   *             every signed-out session.
   */
  app.post(
    "/auth/logout",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "authLogout",
        summary: "Revoke the current session",
        description:
          "Revokes the session at WorkOS and adds it to the local deny list for the remaining lifetime of the presented access token. Personal API tokens are not sessions and are unaffected; revoke those with DELETE /v1/tokens/{id}.",
        tags: ["auth"],
        response: {
          200: {
            type: "object",
            properties: {
              revoked: { type: "boolean" },
              upstreamRevoked: { type: "boolean" },
            },
            required: ["revoked", "upstreamRevoked"],
          },
          ...problemResponses(401, 403, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      if (subject.sessionId === null) {
        throw errors.badRequest(
          "This credential carries no session id and cannot be revoked here.",
        );
      }

      let upstreamRevoked = false;
      try {
        upstreamRevoked = await services.workos.revokeSession(
          subject.sessionId,
        );
      } catch {
        // Local revocation still happens. A provider outage must not leave a
        // user unable to sign out of the device in front of them.
        upstreamRevoked = false;
      }

      // Access tokens are short-lived; an hour is a safe upper bound for the
      // deny-list entry and costs one key for at most that long.
      await app.revokeSessionLocally(
        subject.sessionId,
        Math.floor(Date.now() / 1000) + 3600,
      );

      await services.audit.record({
        userId: subject.userId,
        action: "auth.session.revoked",
        subjectRef: subject.sessionId,
        outcome: "ok",
        detail: { upstreamRevoked },
        ip: request.ip,
      });

      return { revoked: true, upstreamRevoked };
    },
  );
}
