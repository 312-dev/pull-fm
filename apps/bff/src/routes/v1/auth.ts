/**
 * Sign-in, refresh, and sign-out.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THIS SURFACE IS A DELIBERATE ARCHITECTURAL DECISION
 *
 * Sign-in is MAGIC LINK ONLY. There is no social login, no passkey, and no
 * password, and each of those absences has a different reason. Read this before
 * adding one; the full argument is at the top of services/workos.ts.
 *
 *   No password   docs/PLAN.md section 4. WorkOS does not export password
 *                 hashes at all, so the only way to keep the migration path
 *                 open is to never create a hash for them to withhold. It also
 *                 deletes a whole vulnerability class: no password store, no
 *                 reset flow, no credential-stuffing surface.
 *
 *   No social     `authenticateWithMagicAuth` is a plain server-to-server call,
 *                 so the login screens are OURS and the user never leaves the
 *                 application or sees a third-party hostname. Social login
 *                 requires a hosted AuthKit redirect; keeping it on a Pull.fm
 *                 hostname costs 99 USD/month for a WorkOS custom domain, which
 *                 a non-commercial project (docs/PLAN.md section 1a) does not
 *                 have. Without it, sign-in bounces users to a domain that is
 *                 not ours, which is the exact shape of a phishing flow.
 *
 *   No passkey    a passkey is bound to a relying-party ID, which is a domain
 *                 name. Enrolling users now would commit the project to
 *                 `pull.fm` permanently, because a domain change invalidates
 *                 every passkey with no migration path.
 *
 * Both omissions are DEFERRED, not rejected, and migration 0005 puts a CHECK
 * constraint on `users.auth_method` so widening the set is a schema change and
 * therefore a review rather than a quiet drift.
 *
 * `GET /auth/callback` survives from the AuthKit-redirect design and still
 * works, because a deployment may still choose to run a hosted flow. It is not
 * the path this product uses.
 *
 * ---------------------------------------------------------------------------
 * TWO TRANSPORTS, ONE CREDENTIAL
 *
 * A session is a WorkOS access token plus its refresh token. How the client
 * receives them is its choice, declared on `POST /auth/verify`:
 *
 *   transport: "bearer"  the tokens come back in the response body. What a
 *                        mobile client wants, because it has its own keychain
 *                        and no cookie jar worth using.
 *   transport: "cookie"  the tokens are sealed into an HttpOnly cookie and the
 *                        response body contains NO credential at all. What a
 *                        browser client wants, because a refresh token that
 *                        JavaScript can read is a permanent account takeover one
 *                        XSS away.
 *
 * Everything downstream is identical: the cookie is opened at the edge of
 * plugins/auth.ts and the access token inside it goes through the same JWKS
 * verification a bearer token does. See lib/session-cookie.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate } from "../../lib/openapi.js";
import { problemResponses } from "../../lib/schemas.js";
import {
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
} from "../../lib/session-cookie.js";
import { subjectOf } from "../../plugins/auth.js";
import { emailKey, MAGIC_AUTH_CODE_TTL_S } from "../../services/magic-auth.js";
import type { WorkOsSession } from "../../services/workos.js";
import type { Services } from "../deps.js";

/**
 * A session as returned to a bearer client.
 *
 * Yes, this response contains tokens, and these are the only routes in the API
 * that ever do. It is the sign-in response: there is no way to hand a client a
 * session without handing it a session. Every OTHER route is covered by the
 * rule that no response contains a credential, which is why these operations
 * are classified `public` rather than `user-scoped` and are therefore not
 * iterated by the BOLA suite's credential-shape assertion. That exemption is
 * visible in the annotation rather than hidden in the suite.
 *
 * A `transport: "cookie"` sign-in returns this same schema with the token
 * properties ABSENT, which the schema permits because they are not in
 * `required`. Fastify serialises with fast-json-stringify and emits only what
 * the handler returned, so "absent" here is a fact about the bytes on the wire
 * rather than a promise in a comment.
 */
const sessionResponse = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    /** Present on a cookie sign-in, so a client can schedule its own refresh. */
    expiresAt: { type: "string", format: "date-time" },
    transport: { type: "string", enum: ["bearer", "cookie"] },
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
  required: ["user", "transport"],
} as const;

type Transport = "bearer" | "cookie";

export function registerAuthRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  const cfg = services.cfg;

  /** Seals a session into the cookie and attaches it to the reply. */
  function attachSessionCookie(
    reply: FastifyReply,
    session: WorkOsSession,
  ): number {
    const expiresAt = Math.floor(Date.now() / 1000) + cfg.SESSION_COOKIE_TTL_S;
    void reply.header(
      "set-cookie",
      serializeSessionCookie(
        cfg.sessionCookieName,
        services.sessionCookies.seal({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          workosUserId: session.user.id,
          expiresAt,
        }),
        {
          secure: cfg.sessionCookieSecure,
          maxAgeSeconds: cfg.SESSION_COOKIE_TTL_S,
        },
      ),
    );
    // A response that hands out a session must never be stored by a proxy, a
    // browser cache, or a service worker.
    void reply.header("cache-control", "no-store");
    return expiresAt;
  }

  /**
   * Turns a WorkOS session into the local user record and the wire response.
   *
   * Shared by every route that establishes a session, so the local row, the
   * audit trail and the cookie can never diverge between them.
   */
  async function establish(
    request: FastifyRequest,
    reply: FastifyReply,
    session: WorkOsSession,
    transport: Transport,
    action:
      "auth.magic_auth.verified" | "auth.callback" | "auth.session.refreshed",
  ): Promise<Record<string, unknown>> {
    const user = await services.users.upsert({
      workosUserId: session.user.id,
      email: session.user.email,
      displayName:
        [session.user.firstName, session.user.lastName]
          .filter((p): p is string => p !== null && p.length > 0)
          .join(" ") || null,
    });

    // Completing the exchange IS proof of mailbox control, so this records both
    // the sign-in and the verification. See migration 0005.
    if (action !== "auth.session.refreshed") {
      await services.users.recordAuthentication(user.id);
    }

    await services.audit.record({
      userId: user.id,
      action,
      outcome: "ok",
      detail: { transport },
      ip: request.ip,
    });

    const body: Record<string, unknown> = {
      transport,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
      },
    };

    if (transport === "cookie") {
      const expiresAt = attachSessionCookie(reply, session);
      body["expiresAt"] = new Date(expiresAt * 1000).toISOString();
      // Deliberately no tokens in the body. That omission is the entire point
      // of the cookie transport: the refresh token never becomes reachable from
      // JavaScript, so an XSS cannot mint sessions for the rest of its lifetime.
      return body;
    }

    void reply.header("cache-control", "no-store");
    body["accessToken"] = session.accessToken;
    body["refreshToken"] = session.refreshToken;
    return body;
  }

  /**
   * Step one of sign-in: ask for a code.
   *
   * The response is IDENTICAL for a registered address, an unregistered one,
   * and one the identity provider refused, and it is padded to a floor so the
   * clock does not answer the question the body refuses to. The reasoning and
   * the honest limits of the timing control are in services/magic-auth.ts.
   *
   * Both rate limits live in the `noeviction` quota Redis and fail CLOSED. On
   * this route a limiter that fails open is not a missing control, it is an
   * open mail relay pointed at arbitrary third parties.
   */
  app.post(
    "/auth/start",
    {
      schema: {
        operationId: "authStart",
        summary: "Request a magic-link sign-in code",
        description:
          "Sends a one-time code to the address. The response is identical whether or not the address has an account, and is padded to a fixed floor so the response time does not disclose it either. Rate limited per source address and per email address independently: the first stops one host enumerating many addresses, the second stops many hosts flooding one mailbox, and neither limit subsumes the other.",
        tags: ["auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email"],
          properties: {
            email: {
              type: "string",
              format: "email",
              minLength: 3,
              maxLength: 320,
            },
          },
        },
        response: {
          202: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["sent"] },
              expiresInSeconds: { type: "integer" },
              message: { type: "string" },
            },
            required: ["status", "expiresInSeconds", "message"],
          },
          ...problemResponses(400, 429, 503),
        },
        ...annotate({ authz: "public", dast: "exclude" }),
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };

      await services.magicAuth.requestCode(email, request.ip);

      // No user id: at this point there may be no account, and looking one up
      // to find out would recreate the oracle the whole route avoids. The
      // truncated digest is the correlation handle for an incident.
      await services.audit.record({
        userId: null,
        action: "auth.magic_auth.requested",
        subjectRef: emailKey(email),
        outcome: "ok",
        ip: request.ip,
      });

      return reply
        .code(202)
        .header("cache-control", "no-store")
        .send({
          status: "sent",
          expiresInSeconds: MAGIC_AUTH_CODE_TTL_S,
          message:
            "If that address can receive mail, a sign-in code is on its way. " +
            "The same response is returned whether or not an account exists.",
        });
    },
  );

  /**
   * Step two of sign-in: exchange the code for a session.
   *
   * Every failure mode collapses to one 401 with one body: a wrong code, an
   * expired code, a code already used, a code minted for a different address,
   * and an address with no account are indistinguishable. Separating them would
   * turn this route into the enumeration oracle that `/auth/start` was
   * carefully built not to be, which would make that work pointless.
   */
  app.post(
    "/auth/verify",
    {
      schema: {
        operationId: "authVerify",
        summary: "Exchange a magic-link code for a session",
        description:
          "Wrong, expired, replayed, and foreign codes all return the same 401 with the same body. Attempts are budgeted per address and per source in the noeviction quota Redis, because a short numeric code is guessable at volume and relying on an upstream limit we cannot inspect or test is not a control. Choose `cookie` for a browser client: the tokens are then sealed into an HttpOnly cookie and never appear in the response body at all.",
        tags: ["auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "code"],
          properties: {
            email: {
              type: "string",
              format: "email",
              minLength: 3,
              maxLength: 320,
            },
            code: { type: "string", minLength: 1, maxLength: 64 },
            transport: {
              type: "string",
              enum: ["bearer", "cookie"],
              default: "bearer",
              description:
                "`bearer` returns the tokens in the body, for a client with its own credential store. `cookie` seals them into an HttpOnly, SameSite=Strict cookie and returns no credential, for a browser.",
            },
          },
        },
        response: {
          200: sessionResponse,
          ...problemResponses(400, 401, 429, 503),
        },
        ...annotate({ authz: "public", dast: "exclude" }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        code: string;
        transport?: Transport;
      };
      const transport = body.transport ?? "bearer";

      let session: WorkOsSession;
      try {
        session = await services.magicAuth.verifyCode(
          body.email,
          body.code,
          request.ip,
        );
      } catch (err) {
        await services.audit.record({
          userId: null,
          action: "auth.magic_auth.failed",
          subjectRef: emailKey(body.email),
          outcome: "denied",
          ip: request.ip,
        });
        throw err;
      }

      return await establish(
        request,
        reply,
        session,
        transport,
        "auth.magic_auth.verified",
      );
    },
  );

  /**
   * AuthKit callback.
   *
   * A GET because AuthKit redirects a browser here. Retained for deployments
   * that run a hosted flow; the product itself signs in through the two routes
   * above and never sends a user to a hosted page. The code is single-use at
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
          "Called by WorkOS AuthKit after an interactive sign-in. Exchanges the single-use code for an access token, a refresh token, and the local user record, creating that record on first sign-in. Not used by the Pull.fm client, which signs in through POST /v1/auth/start and /v1/auth/verify without ever leaving the application.",
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
    async (request, reply) => {
      const query = request.query as { code: string; code_verifier?: string };
      const session = await services.workos.authenticateWithCode(
        query.code,
        query.code_verifier,
      );
      return await establish(
        request,
        reply,
        session,
        "bearer",
        "auth.callback",
      );
    },
  );

  /**
   * Exchanges a refresh token for a new session.
   *
   * Both transports, one route, and which one is in use is inferred rather than
   * declared: a body with a refresh token is a bearer client, and a request
   * with only the sealed cookie is a browser. A browser client therefore never
   * has to hold, read, or send its refresh token to refresh, which is the
   * property the cookie transport exists to provide.
   *
   * This is WorkOS's `authenticateWithRefreshToken` grant in both cases.
   */
  app.post(
    "/auth/refresh",
    {
      /**
       * Treat an absent body as an empty one.
       *
       * A cookie client has nothing to send, and a POST with no body leaves
       * `request.body` undefined, which the body schema then rejects with a 400
       * before the handler can look at the cookie. Defaulting here rather than
       * dropping the schema keeps `additionalProperties: false` in force, which
       * is the M14 control on every other body in this API.
       */
      preValidation: (request, _reply, done) => {
        request.body ??= {};
        done();
      },
      schema: {
        operationId: "authRefresh",
        summary: "Exchange a refresh token for a new session",
        description:
          "Send `refreshToken` in the body to refresh a bearer session. Send no body at all, with the session cookie and the X-Pullfm-Session header, to refresh a cookie session: the refresh token is inside the sealed cookie and is re-sealed in place, so it is never exposed to the client.",
        tags: ["auth"],
        body: {
          type: "object",
          additionalProperties: false,
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
    async (request, reply) => {
      const body = (request.body ?? {}) as { refreshToken?: string };

      let refreshToken: string;
      let transport: Transport;

      if (typeof body.refreshToken === "string") {
        refreshToken = body.refreshToken;
        transport = "bearer";
      } else {
        const sealed = readCookie(
          request.headers.cookie,
          cfg.sessionCookieName,
        );
        // The CSRF control applies here as much as anywhere: without it a
        // cross-site POST could silently rotate a victim's session, and a
        // rotated refresh token invalidates the one their real client holds,
        // which is a logout the attacker can trigger at will.
        const opened =
          sealed === null || request.headers["x-pullfm-session"] === undefined
            ? null
            : services.sessionCookies.open(sealed);
        if (opened === null) {
          throw errors.unauthorized("The session could not be refreshed.");
        }
        refreshToken = opened.refreshToken;
        transport = "cookie";
      }

      const session = await services.workos.refresh(refreshToken);
      return await establish(
        request,
        reply,
        session,
        transport,
        "auth.session.refreshed",
      );
    },
  );

  /**
   * Sign-out, meaning revocation rather than "forget the token client side".
   *
   * Three halves now, and none is sufficient alone:
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
   *
   *   Cookie    The cookie is cleared unconditionally, including for a bearer
   *             caller. Clearing a cookie that is not there costs one header;
   *             leaving a stale one behind on a shared browser does not.
   */
  app.post(
    "/auth/logout",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "authLogout",
        summary: "Revoke the current session",
        description:
          "Revokes the session at WorkOS, adds it to the local deny list for the remaining lifetime of the presented access token, and clears the session cookie. Personal API tokens are not sessions and are unaffected; revoke those with DELETE /v1/tokens/{id}.",
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
    async (request, reply) => {
      const subject = subjectOf(request);

      // Cleared first, so a client whose upstream revocation fails still ends
      // up without a cookie rather than with one that outlives the attempt.
      void reply.header(
        "set-cookie",
        clearSessionCookie(cfg.sessionCookieName, cfg.sessionCookieSecure),
      );
      void reply.header("cache-control", "no-store");

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
