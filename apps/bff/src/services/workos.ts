/**
 * The WorkOS User Management client.
 *
 * Small and hand-written rather than the vendor SDK, for the same reason there
 * is no ORM: this is the process that holds the KEK, and every dependency added
 * to it is a path in AT-4 (supply chain to the KEK). The calls this application
 * actually makes are a Magic Auth send, a Magic Auth exchange, a refresh, a
 * profile read and write, a session revocation, and a user deletion. That does
 * not justify a dependency tree.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INTERACTIVE SURFACE IS MAGIC AUTH AND NOTHING ELSE
 *
 * Read this before adding "just Google sign-in". It is not an oversight and it
 * is not a phase-one shortcut.
 *
 * `authenticateWithMagicAuth` is a plain server-to-server POST. The client
 * collects an email address on a screen WE render, we ask WorkOS to send a
 * code, the user types the code into a screen WE render, and we exchange it
 * here. At no point does the user leave the application, see a hosted login
 * page, or see a hostname that is not ours. That property is the product
 * decision, and it is the reason this file has no authorize-URL builder.
 *
 * The two obvious additions both destroy it:
 *
 *   Social login  requires a browser redirect to a hosted AuthKit page. Making
 *                 that page live on a Pull.fm hostname costs 99 USD/month for a
 *                 WorkOS custom domain, which for a non-commercial project with
 *                 no revenue (docs/PLAN.md section 1a) is not a rounding error.
 *                 Without it, users are bounced to a third-party domain during
 *                 sign-in, which is exactly the shape they have been trained to
 *                 treat as phishing.
 *
 *   Passkeys      bind the credential to a relying-party ID, which is a domain.
 *                 Adopting them now commits the project to `pull.fm` forever:
 *                 every existing passkey stops working the day the domain
 *                 changes, and there is no migration, only re-enrolment of the
 *                 entire user base. Deferring costs nothing and keeps the
 *                 option open.
 *
 * Both are DEFERRED, not rejected. What would have to be true to revisit:
 * social login needs the custom domain to be affordable or the redirect to be
 * acceptable; passkeys need the domain to be settled. Neither is true today.
 *
 * docs/PLAN.md section 4 predates this decision and says "social + magic-link".
 * The no-password reasoning there is unchanged and still load-bearing; the
 * social half is what this narrows.
 *
 * Rules enforced here rather than trusted to call sites:
 *   - The API key is attached by this module and never returned, logged, or
 *     placed on an error. A thrown error carries a status and a stable code,
 *     not the response body, because an upstream error body can echo the
 *     request including its Authorization header (see lib/errors.ts).
 *   - Every request has a timeout. An outsourced identity provider with no
 *     timeout is a way to exhaust our own connection budget from outside.
 *   - The base URL is fixed to api.workos.com in production by configuration
 *     (see config.ts), so this client cannot be pointed at an impostor.
 */

import { errors } from "../lib/errors.js";

export interface WorkOsUser {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /**
   * Whether WorkOS considers the address proven.
   *
   * `null` means the field was ABSENT from the response, which is deliberately
   * not folded into `false`. The directory reaper deletes on this field, so the
   * difference between "we know it is unverified" and "we did not see the
   * field" is the difference between a correct deletion and destroying a real
   * account because a response shape changed. Everything downstream must treat
   * null as "do not act".
   */
  readonly emailVerified: boolean | null;
  /** ISO 8601, or null when absent. Same fail-closed rule as above. */
  readonly createdAt: string | null;
}

export interface WorkOsSession {
  readonly user: WorkOsUser;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface WorkOsClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  /** Injected in tests so no network call is made. */
  readonly fetchImpl?: typeof fetch;
}

interface AuthenticateResponse {
  user?: {
    id?: unknown;
    email?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    email_verified?: unknown;
    created_at?: unknown;
  };
  access_token?: unknown;
  refresh_token?: unknown;
}

/** One page of `GET /user_management/users`. */
export interface WorkOsUserPage {
  readonly users: readonly WorkOsUser[];
  /** Opaque cursor for the next page, or null at the end. */
  readonly after: string | null;
}

export class WorkOsClient {
  readonly #baseUrl: string;
  readonly #clientId: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: WorkOsClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#clientId = opts.clientId;
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async #request(
    path: string,
    init: { method: string; body?: unknown; auth: "api-key" | "none" },
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      if (init.auth === "api-key") {
        headers["authorization"] = `Bearer ${this.#apiKey}`;
      }

      const res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers,
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });

      const text = await res.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: res.status, body };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw errors.upstreamUnavailable("identity");
      }
      throw errors.upstreamUnavailable("identity");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Narrows a WorkOS user object.
   *
   * An upstream response that does not match its own contract is treated as
   * hostile input (API10:2023), not as something to coerce into shape.
   */
  #toUser(body: unknown): WorkOsUser {
    const parsed = body as AuthenticateResponse["user"] | null;
    const id = parsed?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw errors.upstreamUnavailable("identity");
    }
    const email = parsed?.email;
    const firstName = parsed?.first_name;
    const lastName = parsed?.last_name;
    const emailVerified = parsed?.email_verified;
    const createdAt = parsed?.created_at;
    return {
      id,
      email: typeof email === "string" ? email.toLowerCase() : null,
      firstName: typeof firstName === "string" ? firstName : null,
      lastName: typeof lastName === "string" ? lastName : null,
      // Absent stays null rather than becoming false. See the field comment on
      // WorkOsUser: the reaper acts on this, so an unread field must not look
      // like a negative answer.
      emailVerified: typeof emailVerified === "boolean" ? emailVerified : null,
      createdAt: typeof createdAt === "string" ? createdAt : null,
    };
  }

  #toSession(body: unknown): WorkOsSession {
    const parsed = body as AuthenticateResponse | null;
    const id = parsed?.user?.id;
    const accessToken = parsed?.access_token;
    const refreshToken = parsed?.refresh_token;
    if (
      typeof id !== "string" ||
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string"
    ) {
      // An upstream response that does not match its own contract is treated as
      // hostile input (API10:2023), not as something to coerce.
      throw errors.upstreamUnavailable("identity");
    }
    return {
      user: this.#toUser(parsed?.user),
      accessToken,
      refreshToken,
    };
  }

  /**
   * Asks WorkOS to create a Magic Auth code and email it.
   *
   * ---------------------------------------------------------------------------
   * THIS CALL MUTATES THE WORKOS DIRECTORY. VERIFIED AGAINST THE LIVE API.
   *
   * If the address does not correspond to an existing WorkOS user, this
   * endpoint CREATES ONE, with `email_verified: false`, and returns 200. It
   * does not refuse an unknown address. That was confirmed by probing the live
   * staging environment on 2026-07-29: a send to a nonexistent address at
   * example.com returned 200 and left a real `user_...` record in the
   * directory.
   *
   * The consequence is the reason services/directory-reaper.ts exists.
   * `POST /v1/auth/start` is unauthenticated, so without a compensating control
   * anyone can cause a personal-data record to be created for a person who
   * never consented, never signed up, and has no relationship with Pull.fm.
   * That is processing without a lawful basis, not merely untidy.
   *
   * Two controls follow from it, and both are load-bearing:
   *
   *   1. The send budgets in services/magic-auth.ts. They were written as mail
   *      bombing protection and they are now ALSO the primary bound on how fast
   *      the directory can be polluted. Anyone retuning them must know that.
   *   2. The reaper, which deletes records that were auto-created here and
   *      never verified, so an unconsented record cannot persist.
   *
   * The "declined" branch below is retained rather than deleted. WorkOS refuses
   * a send for reasons other than an unknown address (their own abuse controls,
   * a suspended user), and the caller must still render those identically to a
   * success. Its existence is not a claim that unknown addresses are refused.
   * ---------------------------------------------------------------------------
   *
   * Returns an outcome rather than throwing on a 4xx, and the distinction is
   * the whole anti-enumeration control:
   *
   *   "sent"      WorkOS accepted the request.
   *   "declined"  WorkOS refused it for a reason specific to this address. The
   *               CALLER must render this identically to "sent", and
   *               services/magic-auth.ts is where that is enforced.
   *
   * A transport failure or a 5xx still throws, because that is a fact about our
   * infrastructure rather than about the address, and reporting it is honest.
   * An attacker learns "Pull.fm is having a bad day", not "this person has an
   * account here".
   */
  async sendMagicAuthCode(email: string): Promise<"sent" | "declined"> {
    const { status } = await this.#request("/user_management/magic_auth/send", {
      method: "POST",
      auth: "api-key",
      body: { email },
    });
    if (status >= 200 && status < 300) return "sent";
    if (status >= 400 && status < 500) return "declined";
    throw errors.upstreamUnavailable("identity");
  }

  /**
   * Exchanges a Magic Auth code for a session.
   *
   * The email is part of the exchange, so a code is only usable with the
   * address it was minted for. Codes are single-use at WorkOS, so replay
   * protection is the provider's; the local budget in services/magic-auth.ts
   * exists to stop guessing, which is a different attack.
   */
  async authenticateWithMagicAuth(
    email: string,
    code: string,
  ): Promise<WorkOsSession> {
    const { status, body } = await this.#request(
      "/user_management/authenticate",
      {
        method: "POST",
        auth: "none",
        body: {
          client_id: this.#clientId,
          client_secret: this.#apiKey,
          grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
          code,
          email,
        },
      },
    );
    if (status !== 200) {
      // Uniform failure. Wrong code, expired code, already-used code and
      // unknown address are one answer, because distinguishing them is the
      // enumeration oracle THREAT-MODEL T23 describes.
      throw errors.unauthorized("The sign-in could not be completed.");
    }
    return this.#toSession(body);
  }

  /**
   * Updates the profile held at the identity provider.
   *
   * WorkOS owns the profile; the local row is a cache of it for rendering. The
   * write therefore goes upstream FIRST and the local row is only updated once
   * WorkOS has accepted it, so a failure leaves the two consistent rather than
   * leaving us displaying a name the identity provider never accepted.
   */
  async updateUser(
    workosUserId: string,
    patch: { firstName?: string | null; lastName?: string | null },
  ): Promise<WorkOsUser> {
    const body: Record<string, unknown> = {};
    if (patch.firstName !== undefined) body["first_name"] = patch.firstName;
    if (patch.lastName !== undefined) body["last_name"] = patch.lastName;

    const { status, body: response } = await this.#request(
      `/user_management/users/${encodeURIComponent(workosUserId)}`,
      { method: "PUT", auth: "api-key", body },
    );
    if (status < 200 || status >= 300) {
      throw errors.upstreamUnavailable("identity");
    }
    return this.#toUser(response);
  }

  /**
   * Lists directory users, one page at a time.
   *
   * Exists solely for the directory reaper. It is a read of the whole user
   * directory, which is the most sensitive listing this API offers, so it is
   * never reachable from a route: nothing in routes/ calls it, and the only
   * caller is a scheduled job that runs out of band.
   *
   * `after` is WorkOS's opaque cursor. Pagination is followed rather than
   * assumed to fit in one page, because a directory that has been polluted is
   * exactly the case the reaper needs to handle and is also the case most
   * likely to exceed a single page.
   */
  async listUsers(opts: {
    limit: number;
    after?: string | null;
  }): Promise<WorkOsUserPage> {
    const query = new URLSearchParams({
      limit: String(opts.limit),
      // Oldest first. The reaper only ever deletes records older than its
      // window, so walking from the oldest end means the candidates are found
      // in the first pages and a large directory does not have to be traversed
      // in full before any work happens.
      order: "asc",
    });
    if (opts.after !== undefined && opts.after !== null) {
      query.set("after", opts.after);
    }

    const { status, body } = await this.#request(
      `/user_management/users?${query.toString()}`,
      { method: "GET", auth: "api-key" },
    );
    if (status < 200 || status >= 300) {
      throw errors.upstreamUnavailable("identity");
    }

    const parsed = body as
      | { data?: unknown; list_metadata?: { after?: unknown } }
      | null
      | undefined;
    if (!Array.isArray(parsed?.data)) {
      // A listing we cannot parse must not be treated as an empty directory:
      // the reaper would report "nothing to do" and a real problem would look
      // like a clean run.
      throw errors.upstreamUnavailable("identity");
    }

    const after = parsed.list_metadata?.after;
    return {
      users: parsed.data.map((entry) => this.#toUser(entry)),
      after: typeof after === "string" && after.length > 0 ? after : null,
    };
  }

  /** Reads the profile held at the identity provider. Null when it is gone. */
  async getUser(workosUserId: string): Promise<WorkOsUser | null> {
    const { status, body } = await this.#request(
      `/user_management/users/${encodeURIComponent(workosUserId)}`,
      { method: "GET", auth: "api-key" },
    );
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw errors.upstreamUnavailable("identity");
    }
    return this.#toUser(body);
  }

  /** Exchanges an AuthKit authorization code for a session. */
  async authenticateWithCode(
    code: string,
    codeVerifier?: string,
  ): Promise<WorkOsSession> {
    const { status, body } = await this.#request(
      "/user_management/authenticate",
      {
        method: "POST",
        auth: "none",
        body: {
          client_id: this.#clientId,
          client_secret: this.#apiKey,
          grant_type: "authorization_code",
          code,
          ...(codeVerifier === undefined
            ? {}
            : { code_verifier: codeVerifier }),
        },
      },
    );
    if (status !== 200) {
      // Uniform failure. Distinguishing "bad code" from "expired code" from
      // "unknown user" here is the enumeration oracle T23 describes.
      throw errors.unauthorized("The sign-in could not be completed.");
    }
    return this.#toSession(body);
  }

  /**
   * Exchanges a refresh token for a fresh session.
   *
   * This is WorkOS's `authenticateWithRefreshToken` grant. Both transports use
   * it: a bearer client posts the refresh token it holds, and a cookie client
   * posts nothing at all because the refresh token is inside the sealed cookie
   * and never left the server's control.
   */
  async refresh(refreshToken: string): Promise<WorkOsSession> {
    const { status, body } = await this.#request(
      "/user_management/authenticate",
      {
        method: "POST",
        auth: "none",
        body: {
          client_id: this.#clientId,
          client_secret: this.#apiKey,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
      },
    );
    if (status !== 200) {
      throw errors.unauthorized("The session could not be refreshed.");
    }
    return this.#toSession(body);
  }

  /**
   * Revokes a session at the identity provider.
   *
   * Local revocation alone is not enough: the refresh token would still mint
   * new access tokens. Local revocation without this is a logout that only
   * looks like one.
   */
  async revokeSession(sessionId: string): Promise<boolean> {
    const { status } = await this.#request(
      `/user_management/sessions/${encodeURIComponent(sessionId)}/revoke`,
      { method: "POST", auth: "api-key" },
    );
    return status >= 200 && status < 300;
  }

  /**
   * Deletes the identity upstream as part of account deletion.
   *
   * 404 counts as success: the goal is "this identity no longer exists", and a
   * webhook-driven deletion that already removed it must not make our own
   * cascade fail.
   */
  async deleteUser(workosUserId: string): Promise<boolean> {
    const { status } = await this.#request(
      `/user_management/users/${encodeURIComponent(workosUserId)}`,
      { method: "DELETE", auth: "api-key" },
    );
    return (status >= 200 && status < 300) || status === 404;
  }
}
