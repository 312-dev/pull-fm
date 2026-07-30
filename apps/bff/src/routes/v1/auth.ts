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
 *
 * ---------------------------------------------------------------------------
 * THE EEA / UK / SWITZERLAND REFUSAL LIVES ON THIS FILE'S ROUTES AND NOWHERE
 * ELSE
 *
 * Pull.fm does not open accounts for people in the EEA, the United Kingdom or
 * Switzerland (lib/registration-geo.ts carries the list and the whole argument
 * about how the country is established). Three things about WHERE that is
 * enforced are decisions rather than convenience, and all three were nearly
 * wrong:
 *
 *   1. IT IS THE SIGN-IN SURFACE, NOT ALL TRAFFIC. The obligation attaches to
 *      holding a person's personal data, and the account is where that
 *      relationship forms. A catalogue read is not a data relationship, and
 *      refusing every request would be a different product decision that
 *      nobody made.
 *
 *   2. IT RUNS BEFORE THE IDENTITY PROVIDER IS CALLED, AND THAT IS THE WHOLE
 *      POINT ON `/auth/start`. Read the block below this one: that route
 *      CREATES A WORKOS USER for any address handed to it, verified against
 *      the live API. A refusal that ran after the provider call - or only at
 *      `/auth/verify` - would leave a personal-data record, at a processor, for
 *      a person we just told we will not serve. That is an ORPHAN IDENTITY: a
 *      record of somebody we refused, held by us, which is the precise outcome
 *      this posture exists to avoid, and it would be worse than not blocking at
 *      all because it would be invisible. The hook is `onRequest`, so it runs
 *      before body parsing, before the send budgets and before one byte reaches
 *      WorkOS.
 *
 *   3. IT IS ON `/auth/verify` AND `/auth/callback` TOO, not just `/auth/start`.
 *      `establish()` is what writes the local `users` row, and both of those
 *      routes call it. Blocking only the first step would refuse the code and
 *      then happily complete registration for anyone who obtained a code from
 *      somewhere else, which makes the control decorative.
 *
 * WHAT IS DELIBERATELY NOT BLOCKED, because refusing it would harm an existing
 * user rather than prevent a new relationship:
 *
 *   `/auth/logout`   Refusing a revocation traps a live session open. A logout
 *                    must work from anywhere, always.
 *   `/auth/refresh`  An account that already exists keeps working. Nobody is
 *                    deleted, disabled, or locked out by this change; the
 *                    refusal is about forming a NEW relationship. An existing
 *                    user travelling in a listed country keeps their session,
 *                    their personal API tokens and every other route.
 *
 * Be honest about the residual: an existing user in a listed country who lets
 * their refresh token lapse cannot obtain a fresh magic link, because
 * `/auth/start` cannot tell them apart from a new registration without asking
 * the database whether the address has an account - and answering differently
 * for an address that exists is exactly the enumeration oracle that route
 * spends thirty lines refusing to be. The oracle is the worse of the two, so
 * the residual stands and is written down here rather than discovered later.
 *
 * ---------------------------------------------------------------------------
 * THE CLOSED-BETA ALLOWLIST SITS BESIDE THE GEO REFUSAL AND USES A DIFFERENT
 * HOOK, AND THE DIFFERENCE IS FORCED RATHER THAN CHOSEN
 *
 * lib/registration-allowlist.ts carries the whole argument for why the list
 * exists (the owner being the only End User is what makes SeatGeek's clause 4.3
 * EULA duty have nothing to attach to, and that has to be enforced rather than
 * hoped for). What belongs HERE is where it runs.
 *
 * IT CANNOT BE `onRequest`, AND THE GEO CHECK'S ANSWER IS WRONG FOR IT. The
 * geo refusal reads a HEADER, which Fastify has already parsed by `onRequest`,
 * so the earliest hook is also a usable one and it takes it. An address is in
 * the request BODY, and at `onRequest` the body has not been read off the socket
 * yet: `request.body` is undefined and there is nothing to compare. So the four
 * hooks that could see it were considered in order:
 *
 *   preParsing      the body is still a stream. There is a parsed address here
 *                   only if this hook parses one itself, which is a second
 *                   parser that can disagree with the real one.
 *   preValidation   the body is parsed but NOT validated. `email` may be absent,
 *                   a number, an array or an object, `additionalProperties:
 *                   false` has not run, and `format: email` has not run. A gate
 *                   here has to re-implement the narrowing the schema already
 *                   does, and a security check whose input contract differs from
 *                   the handler's is a check that can be walked around by
 *                   sending a shape it did not anticipate.
 *   preHandler      the body is parsed AND validated, so `email` is a string
 *                   that satisfied the schema, and the handler has not run.
 *                   CHOSEN.
 *   the handler     too late, and this is the whole point. See below.
 *
 * `preHandler` IS EARLY ENOUGH FOR THE PROPERTY THAT ACTUALLY MATTERS, which is
 * not "as early as possible" but "before the identity provider is contacted".
 * `POST /user_management/magic_auth/send` CREATES A WORKOS USER for any address
 * handed to it and EMAILS that address, so a refusal that ran a moment later
 * would leave a personal-data record at a processor for somebody we just refused
 * AND put an unexpected sign-in mail in a stranger's inbox. Both of those calls
 * happen inside `services.magicAuth.requestCode`, which the HANDLER invokes, and
 * every `preHandler` runs before the handler. The send budgets are in the same
 * method, so they too are downstream. The refused caller is therefore invisible
 * to WorkOS and receives nothing.
 *
 * WHERE IT IS ENFORCED, AND THE ONE PLACE THE SHAPE HAD TO CHANGE:
 *
 *   `POST /auth/start`    THE point of enforcement. This is where an account
 *                         comes into being, and where the provider is written
 *                         to. `preHandler`.
 *   `POST /auth/verify`   Also gated, `preHandler`, for the same reason the geo
 *                         check gates it and one more. The geo reason:
 *                         `establish()` writes the local `users` row, so a gate
 *                         that stopped at step one would refuse the code and then
 *                         complete a registration for anybody holding a code
 *                         obtained elsewhere. The additional reason is specific
 *                         to a list that CHANGES: a code lives ten minutes, so
 *                         "you cannot get here without passing /auth/start" is
 *                         true only if the list has not narrowed in between.
 *                         Relying on that property would mean removing an address
 *                         from the list does not take effect for ten minutes,
 *                         which is not a property worth depending on when the
 *                         alternative costs one line.
 *   `GET /auth/callback`  Gated, but NOT with the hook, because there is no
 *                         address anywhere in the request: the hosted flow sends
 *                         a `code` and the address is only knowable from the
 *                         provider's answer to it. So the check is in the
 *                         handler, between `authenticateWithCode` and
 *                         `establish`. That is late by the standard set above and
 *                         it is the earliest point that exists. Being honest
 *                         about what it does and does not buy: no local account
 *                         is created and no session is returned, but the WorkOS
 *                         user and session were already created by the hosted
 *                         flow before we were called, and `WorkOsSession` carries
 *                         no session id so there is nothing here to revoke. It is
 *                         gated anyway rather than left open, because a
 *                         deployment that turns the hosted flow on must not
 *                         acquire an unguarded registration path by doing so.
 *
 * DELIBERATELY UNGATED, and this is the same line the geo refusal draws:
 *
 *   `/auth/refresh`  A session that was legitimately created keeps working.
 *                    Refusing a refresh would lock out an account that already
 *                    exists, which is a punishment rather than a control, and the
 *                    control is about FORMING a relationship. The route also
 *                    carries no address at all, so there is nothing an address
 *                    gate could read even if one were wanted.
 *   `/auth/logout`   Refusing a revocation traps a live session open on a device
 *                    its owner is trying to leave. It must work from anywhere,
 *                    always, for anybody.
 *
 * The residual, stated rather than left to be found: an address that is NOT on
 * the list and whose session lapses cannot sign in again, because `/auth/verify`
 * is gated and cannot tell an existing account from a new one without asking the
 * database - which is the same enumeration oracle the geo residual above refuses
 * to build, for the same reason. During a closed beta with one intended user that
 * is the intent rather than a defect, and the US staging database held zero rows
 * when the list was added, so nobody is affected today. It stops being acceptable
 * the moment the beta has real users, which is the same moment the list should be
 * emptied.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerHookHandler,
} from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate } from "../../lib/openapi.js";
import { decideRegistrationAllowlist } from "../../lib/registration-allowlist.js";
import {
  COUNTRY_HEADER,
  decideRegistrationGeo,
} from "../../lib/registration-geo.js";
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

  /**
   * Refuses account formation from the EEA, the UK and Switzerland.
   *
   * `onRequest`, so the refusal precedes body parsing, the send budgets and any
   * call to WorkOS. See the header of this file for why it is attached to these
   * three routes and not to the others, and lib/registration-geo.ts for how the
   * country is established and why an unverifiable peer fails closed.
   *
   * DEPLOY_ENV IS THE SWITCH, NOT AN ENVIRONMENT VARIABLE OF ITS OWN. `local`
   * is the only deployment with no Cloudflare edge and no origin nginx in front
   * of it, so it is the only one where a missing country header is the expected
   * state rather than the control being broken. Deriving the posture from a
   * value that already describes the deployment means there is no separate knob
   * that can be set to `false` in production by mistake, and no way for staging
   * and production to disagree with each other.
   *
   * NOTHING IS WRITTEN TO THE AUDIT TRAIL HERE, ON PURPOSE. A refusal row would
   * carry `ip`, which is personal data about a person whose personal data we
   * just declined to hold; lib/audit.ts already makes that argument twice, for
   * the magic-auth rows and for the directory reaper. A counter records that
   * refusals happened and in what volume, which is what an operator needs, and
   * it identifies nobody.
   */
  const refuseRestrictedRegion: onRequestHookHandler = (
    request,
    _reply,
    done,
  ) => {
    const decision = decideRegistrationGeo({
      // The SOCKET peer, never `request.ip`. `trustProxy` is on, so `request.ip`
      // is a header value and a header is what this check exists to distrust.
      peerAddress: request.socket.remoteAddress,
      countryHeader: request.headers[COUNTRY_HEADER],
      enforced: cfg.DEPLOY_ENV !== "local",
    });

    if (decision.allowed) {
      done();
      return;
    }

    // The `country` label is bounded, which is the only reason it is allowed to
    // exist: `decideRegistrationGeo` returns null unless the value matched
    // /^[A-Z]{2}$/, so the label space is the 676 possible two-letter codes and
    // not "whatever the caller sent". An unbounded label here would be the
    // metrics-endpoint-becomes-the-outage failure the onResponse hook in
    // server.ts already warns about, driven by a header a client controls.
    services.metrics.counter(
      "pullfm_registration_region_refusals_total",
      "Sign-in attempts refused because Pull.fm is not offered in the caller's region.",
      { reason: decision.reason, country: decision.country ?? "none" },
    );

    // Thrown rather than sent, so the central error handler produces the same
    // problem+json shape, with the request id in `instance`, that every other
    // refusal in this API produces.
    done(errors.regionUnavailable());
  };

  /**
   * Records that a closed-beta refusal happened, and NOTHING ABOUT WHO.
   *
   * THE LABEL SET IS BOUNDED ON PURPOSE AND THE OBVIOUS LABEL IS ABSENT. The
   * useful-looking label here would be the address, and it is exactly the one
   * that cannot exist: an email address is client-controlled and unbounded, so
   * labelling with it mints one time series per address a stranger types and
   * turns `/metrics` into the outage it was added to detect. The `onResponse`
   * hook in server.ts already makes this argument for route templates, and the
   * geo counter makes it for the country code, which is bounded to 676 values
   * precisely because it was checked. `route` is bounded by the route table:
   * three templates, and no caller can invent a fourth.
   *
   * It is also the reason the address is not logged and no audit row is written.
   * lib/audit.ts argues twice over that a refusal row carrying `ip` is personal
   * data about somebody whose personal data we just declined to hold, and an
   * address is worse: `audit_log` rows deliberately outlive the user. A counter
   * tells an operator that refusals are happening and at what volume, which is
   * what an operator needs, and it identifies nobody.
   */
  const countAllowlistRefusal = (request: FastifyRequest): void => {
    services.metrics.counter(
      "pullfm_registration_allowlist_refusals_total",
      "Sign-in attempts refused because the address is not on the closed-beta allowlist.",
      { route: request.routeOptions.url ?? "unrouted" },
    );
  };

  /**
   * Refuses account formation by an address that is not on the allowlist.
   *
   * `preHandler`, NOT `onRequest`, and the geo hook above is not a template for
   * this one: it reads a header, which exists at `onRequest`, and this reads the
   * body, which does not. The full comparison of the four candidate hooks, and
   * the reason `preHandler` is still early enough (every path to WorkOS and to
   * the send budgets runs inside the HANDLER), is in the header of this file.
   *
   * The body is validated by the time this runs, so `email` is a string that
   * satisfied `format: email`. That is the point of choosing the hook after
   * validation rather than before it: this hook and the handler narrow the body
   * the same way, because the schema did it once for both.
   */
  const refuseUnlistedAddress: preHandlerHookHandler = (
    request,
    _reply,
    done,
  ) => {
    const { email } = request.body as { email: string };

    if (
      decideRegistrationAllowlist(email, cfg.AUTH_REGISTRATION_ALLOWLIST)
        .allowed
    ) {
      done();
      return;
    }

    countAllowlistRefusal(request);
    // Thrown rather than sent, so the central error handler produces the one
    // uniform problem+json body. Every refused address gets byte-identical
    // bytes: see the enumeration-oracle argument on `errors.registrationClosed`.
    done(errors.registrationClosed());
  };

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
   * ---------------------------------------------------------------------------
   * THIS UNAUTHENTICATED ROUTE MUTATES THE WORKOS DIRECTORY.
   *
   * Verified against the live API on 2026-07-29:
   * `POST /user_management/magic_auth/send` CREATES a WorkOS user when the
   * address does not already have one, with `email_verified: false`, and
   * answers 200. It does not refuse an unknown address.
   *
   * So calling this route causes a personal-data record to exist for whatever
   * address the caller typed, including an address belonging to a real person
   * who has never heard of Pull.fm. There is no lawful basis under GDPR
   * Article 6 for holding that indefinitely, and the affected person is not a
   * user, so they would have no reason to come looking for us to exercise a
   * right over it.
   *
   * Two controls, and BOTH are load-bearing. Neither is sufficient alone: the
   * budgets bound the rate but a patient attacker outlasts them, and the reaper
   * bounds the duration but not how fast records appear within it.
   *
   *   1. The send budgets below. They read like abuse protection and they are
   *      also the primary bound on directory pollution. ANYONE RETUNING THEM
   *      NEEDS TO KNOW THAT, which is why it is said here and again in
   *      services/magic-auth.ts rather than left to be rediscovered.
   *   2. services/directory-reaper.ts, a scheduled sweep that deletes records
   *      which were auto-created here and never verified.
   * ---------------------------------------------------------------------------
   *
   * The response is IDENTICAL for a registered address, an unregistered one,
   * and one the identity provider refused, and it is padded to a floor so the
   * clock does not answer the question the body refuses to. The reasoning and
   * the honest limits of the timing control are in services/magic-auth.ts.
   *
   * Both rate limits live in the `noeviction` quota Redis and fail CLOSED. On
   * this route a limiter that fails open is not a missing control, it is an
   * open mail relay pointed at arbitrary third parties AND an unbounded write
   * channel into the identity provider's directory.
   */
  app.post(
    "/auth/start",
    {
      onRequest: refuseRestrictedRegion,
      // The address is in the body, so this cannot be an `onRequest` hook the way
      // the region refusal above is. It is still ahead of every call this route
      // makes to WorkOS and of both send budgets, because all of them are inside
      // the handler. See the header of this file.
      preHandler: refuseUnlistedAddress,
      schema: {
        operationId: "authStart",
        summary: "Request a magic-link sign-in code",
        description:
          "Sends a one-time code to the address. Step one of two; exchange the code at POST /v1/auth/verify. The response is identical whether or not the address has an account, so it cannot be used to find out. Rate limited; a 429 carries Retry-After. An address that is sent a code and never verified leaves no account behind. Pull.fm is offered in the United States; a request from a region where it is not offered is refused with 451 before anything is sent. Pull.fm is also in a closed beta: while it is, an address that is not admitted is refused with 403 before any mail is sent, and the refusal is identical for every refused address so it cannot be used to discover which addresses are admitted.",
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
          ...problemResponses(400, 403, 429, 451, 503),
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
      // Both steps, not just the first. `establish()` below writes the local
      // `users` row, so a block that stopped at `/auth/start` would still let a
      // code obtained elsewhere complete a registration from a refused region.
      onRequest: refuseRestrictedRegion,
      // Same argument for the allowlist, plus one the region check does not have:
      // a code lives ten minutes, so trusting "you cannot get here without
      // passing /auth/start" would mean an address removed from the list keeps
      // working for ten minutes. Gating here makes a narrowed list take effect at
      // once, and it costs one line.
      preHandler: refuseUnlistedAddress,
      schema: {
        operationId: "authVerify",
        summary: "Exchange a magic-link code for a session",
        description:
          "Step two of two. On success the response carries the session in the transport you asked for. Every rejected code returns the same 401 with the same body, so a failure says nothing about which part was wrong. Attempts are rate limited; a 429 carries Retry-After. Choose `cookie` for a browser client: the tokens are then sealed into an HttpOnly cookie and never appear in the response body at all. Refused with 451 from a region where Pull.fm is not offered, and with 403 while Pull.fm is in a closed beta if the address is not admitted.",
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
          ...problemResponses(400, 401, 403, 429, 451, 503),
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
      // Also calls `establish()`, so it is also a way to end up with an account.
      // A deployment that turns the hosted flow on must not acquire a second,
      // unguarded registration path by doing so.
      onRequest: refuseRestrictedRegion,
      // NO `preHandler: refuseUnlistedAddress` here, and its absence is a decision
      // rather than an omission: this request contains no address for a hook to
      // read. The allowlist is applied inside the handler, at the first line where
      // one exists. Nothing else in this file is enforced that late.
      schema: {
        operationId: "authCallback",
        summary: "INTERNAL. Hosted-redirect sign-in callback",
        description:
          "Internal integration surface, not part of the public client contract. It exists only for a deployment that runs a hosted redirect sign-in, and the Pull.fm client never uses it: clients sign in with POST /v1/auth/start and POST /v1/auth/verify without leaving the application.",
        tags: ["internal"],
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
          ...problemResponses(401, 403, 429, 451, 503),
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

      /**
       * The allowlist, checked HERE rather than in a hook, because this is the
       * first line at which an address exists.
       *
       * Nothing in the request names a person: the hosted flow sends a `code`,
       * and the address is only knowable from the provider's answer to it. So
       * `refuseUnlistedAddress` cannot be attached to this route at all, and the
       * "refuse before the provider is contacted" rule that governs the other two
       * routes is unachievable here rather than merely skipped. See the header of
       * this file for what that does and does not buy: `establish()` never runs,
       * so no local account and no session come out of it, but the WorkOS user and
       * session already existed before this handler was entered and
       * `WorkOsSession` carries no session id to revoke.
       *
       * A null address from the provider normalises to the empty string, which is
       * on no list, so the unusual case fails closed.
       */
      if (
        !decideRegistrationAllowlist(
          session.user.email ?? "",
          cfg.AUTH_REGISTRATION_ALLOWLIST,
        ).allowed
      ) {
        countAllowlistRefusal(request);
        // The identical error, so this refusal is indistinguishable from the two
        // above and from each other.
        throw errors.registrationClosed();
      }

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
          "Revokes the session rather than asking the client to forget it, so the access token the caller already holds stops working and the refresh token stops minting new ones. Clears the session cookie. Personal API tokens are not sessions and are unaffected; revoke those with DELETE /v1/tokens/{id}.",
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
          // Not gated by the consent requirement even though it is a POST. A user
          // who has read the Terms and refused them must be able to end their
          // session, and "you cannot sign out until you agree" would be both
          // indefensible and a security defect: it would keep a live session open
          // on a device its owner is trying to leave.
          consent: "exempt-session-control",
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
