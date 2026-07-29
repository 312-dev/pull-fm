/**
 * The WorkOS User Management client.
 *
 * Small and hand-written rather than the vendor SDK, for the same reason there
 * is no ORM: this is the process that holds the KEK, and every dependency added
 * to it is a path in AT-4 (supply chain to the KEK). The four calls this
 * application actually makes are a code exchange, a refresh, a session
 * revocation, and a user deletion. That does not justify a dependency tree.
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
  };
  access_token?: unknown;
  refresh_token?: unknown;
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
    const email = parsed?.user?.email;
    const firstName = parsed?.user?.first_name;
    const lastName = parsed?.user?.last_name;
    return {
      user: {
        id,
        email: typeof email === "string" ? email.toLowerCase() : null,
        firstName: typeof firstName === "string" ? firstName : null,
        lastName: typeof lastName === "string" ? lastName : null,
      },
      accessToken,
      refreshToken,
    };
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

  /** Exchanges a refresh token for a fresh session. */
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
