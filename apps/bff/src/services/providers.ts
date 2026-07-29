/**
 * Connect-flow adapters for the two credential providers.
 *
 * Scope note: these are the AUTHENTICATION halves only. Data fetching lives in
 * `packages/upstream` behind the shared rate-limited clients, because that is
 * where the quota accounting, circuit breakers, and kill switches are
 * (THREAT-MODEL M33/M34/M37). Nothing here is on a user read path: a connect
 * flow happens once per account per provider, so it does not consume the
 * metered budgets that AT-5 is about.
 *
 * Both adapters follow the same rules:
 *   - URLs are built from components with encoded parameters, never by string
 *     concatenation, so a hostile identifier cannot redirect a credentialed
 *     request (T15/M31).
 *   - Redirects are disabled. A 302 from an upstream into our private network,
 *     or to an attacker's host, would carry the credential with it.
 *   - Responses are size-capped and schema-checked before use. An upstream
 *     response is untrusted input (API10:2023), not a typed object.
 *   - Errors never carry the response body. An upstream error body can echo the
 *     request, including the shared API secret.
 */

import { createHash } from "node:crypto";

import { errors } from "../lib/errors.js";
import type { Config } from "../config.js";
import type {
  ProviderAdapter,
  ProviderCredential,
  ProviderRegistry,
} from "./connections.js";

/** Upstream responses are small; anything larger is a decompression bomb. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

async function getJson(
  url: URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      // A redirect chain is how a credentialed request ends up somewhere we did
      // not intend, including inside our own private network.
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw errors.upstreamUnavailable("provider");
    }
    if (res.status >= 300) {
      throw errors.upstreamUnavailable("provider");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw errors.upstreamUnavailable("provider");
    }
  } catch (err) {
    if (err instanceof Error && "status" in err) throw err;
    throw errors.upstreamUnavailable("provider");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Last.fm.
 *
 * The flow is: send the user to last.fm/api/auth with a callback, receive a
 * request token on the callback, exchange it for a SESSION KEY via
 * auth.getSession. The session key never expires, which is why THREAT-MODEL
 * rates a connect-flow CSRF here as Critical: a graft is permanent.
 *
 * The signature is MD5 by Last.fm's specification. That is their protocol
 * decision, not ours, and it is a signature over a request to them rather than
 * anything protecting our own data. It is called out here so a future reader
 * does not mistake it for a choice we made.
 */
export function lastfmAdapter(
  apiKey: string,
  sharedSecret: string,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  const sign = (params: Record<string, string>): string => {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k] ?? ""}`)
      .join("");
    return createHash("md5")
      .update(`${message}${sharedSecret}`, "utf8")
      .digest("hex");
  };

  return {
    authorizeUrl(state, callbackUrl) {
      // The state rides in the callback URL. Last.fm appends its own `token`
      // parameter to whatever we give it, so the state survives the round trip
      // and the callback can bind it to the session that started the flow.
      const callback = new URL(callbackUrl);
      callback.searchParams.set("state", state);

      const url = new URL("https://www.last.fm/api/auth/");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("cb", callback.toString());
      return url.toString();
    },

    async completeCallback(query) {
      const token = query["token"];
      if (typeof token !== "string" || token.length === 0) {
        throw errors.badRequest(
          "The provider did not return an authorization token.",
        );
      }

      const params = { api_key: apiKey, method: "auth.getSession", token };
      const url = new URL("https://ws.audioscrobbler.com/2.0/");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set("api_sig", sign(params));
      url.searchParams.set("format", "json");

      const body = (await getJson(url, {}, fetchImpl)) as {
        session?: { name?: unknown; key?: unknown };
      };
      const name = body.session?.name;
      const key = body.session?.key;
      if (typeof name !== "string" || typeof key !== "string") {
        throw errors.upstreamUnavailable("last.fm");
      }

      // `key` is the session key. It is returned to the caller of this function
      // and sealed immediately; it is never logged, never attached to the
      // request, and never placed in an error (THREAT-MODEL M09).
      return {
        providerAccountId: name,
        accessToken: key,
        scopes: ["read", "scrobble"],
      };
    },
  };
}

/**
 * ListenBrainz.
 *
 * No OAuth exists: the user generates a token on listenbrainz.org and pastes
 * it. That makes the connect flow simpler and removes the CSRF surface
 * entirely, but it also means the token arrives in a request body, so it must
 * be verified before it is stored. Storing an unverified string would produce a
 * connection that looks healthy and fails on first use.
 */
export function listenbrainzAdapter(
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  return {
    authorizeUrl() {
      // No redirect flow. The client sends the user to their settings page and
      // POSTs the token back to us.
      return null;
    },

    completeCallback() {
      return Promise.reject(
        errors.unprocessable(
          "ListenBrainz has no redirect flow. Supply the user token in the request body instead.",
        ),
      );
    },

    async verifyDirect(credential): Promise<ProviderCredential> {
      const url = new URL("https://api.listenbrainz.org/1/validate-token");
      const body = (await getJson(
        url,
        { authorization: `Token ${credential}` },
        fetchImpl,
      )) as { valid?: unknown; user_name?: unknown };

      if (body.valid !== true || typeof body.user_name !== "string") {
        throw errors.unprocessable(
          "That ListenBrainz token was not accepted by the provider.",
        );
      }
      return {
        providerAccountId: body.user_name,
        accessToken: credential,
        scopes: ["read", "submit"],
      };
    },
  };
}

/**
 * Builds the registry from configuration.
 *
 * A provider whose credentials are absent is simply not registered, and the
 * routes answer 501 for it. That is better than registering a broken adapter
 * that fails at the moment a user tries to connect: an unconfigured provider
 * should be visibly unavailable, not intermittently broken.
 */
export function buildProviderRegistry(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): ProviderRegistry {
  const registry: ProviderRegistry = {
    listenbrainz: listenbrainzAdapter(fetchImpl),
  };
  if (
    cfg.LASTFM_API_KEY !== undefined &&
    cfg.LASTFM_SHARED_SECRET !== undefined
  ) {
    registry.lastfm = lastfmAdapter(
      cfg.LASTFM_API_KEY,
      cfg.LASTFM_SHARED_SECRET,
      fetchImpl,
    );
  }
  return registry;
}
