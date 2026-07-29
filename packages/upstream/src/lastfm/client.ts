/**
 * Last.fm 2.0 API - thin enrichment only.
 *
 * LICENCE POSITION (docs/UPSTREAM-TERMS.md L1, docs/PLAN.md section 1a):
 *
 *   - Non-commercial use only (ToS 3.1-3.2). Pull.fm is locked non-commercial,
 *     so we are compliant, and any affiliate revenue would retroactively breach
 *     this. Nothing in this file produces a monetisable link.
 *   - Cached Last.fm data is capped at 100 MB (ToS 4.3.4). That cap is enforced
 *     by CacheGovernor, not here, but it is the reason Last.fm is scoped to
 *     enrichment rather than being the similarity backbone: a similarity graph
 *     over a real catalogue exceeds 100 MB immediately.
 *   - Attribution is mandatory (ToS 2.7, 4.2.2), in the specific
 *     `last.fm/music/[artist]` link form. `artistUrl` below is that format, and
 *     every returned entity carries the URL the UI must render.
 *
 * ERRORS. Last.fm signals failure in-band: an HTTP 200 can carry
 * `{ "error": 29, "message": "Rate limit exceeded" }`. A client that only looks
 * at the status code treats rate limiting as success and keeps hammering, which
 * is how an API key gets suspended. Every response is inspected for the error
 * envelope before it is parsed.
 */

import { createHash } from "node:crypto";

import { UpstreamError } from "../errors.js";
import {
  arrayOrSingle,
  isRecord,
  optMbid,
  optNumber,
  optRecord,
  optString,
} from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const LASTFM_BASE_URL = "https://ws.audioscrobbler.com/2.0";

/** Undocumented in their terms; ~5 req/s is the community-observed ceiling. */
export const LASTFM_QUOTA = { limit: 5, windowMs: 1_000 } as const;

/** Required attribution text to render alongside any Last.fm-derived data. */
export const LASTFM_ATTRIBUTION = "Data provided by Last.fm";

/**
 * Last.fm error codes worth distinguishing.
 * 8, 11, 16 are transient; 29 is rate limiting; the rest are ours to fix.
 */
const RETRYABLE_LASTFM_ERRORS = new Set([8, 11, 16, 29]);

export interface LastfmArtist {
  readonly name: string;
  readonly mbid: string | undefined;
  /** The attribution link. ToS 2.7 requires this exact form. */
  readonly url: string;
  readonly match: number | undefined;
  readonly listeners: number | undefined;
  readonly tags: readonly string[];
}

export interface LastfmTrack {
  readonly title: string;
  readonly artistName: string;
  readonly mbid: string | undefined;
  readonly url: string;
  readonly match: number | undefined;
  readonly durationMs: number | undefined;
}

export interface LastfmSession {
  readonly userName: string;
  readonly sessionKey: string;
}

export interface LastfmClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  /** Global, application-owned. Not a per-user secret. */
  readonly apiKey: string;
  /** Required only for signed calls (auth.getSession). */
  readonly sharedSecret?: string;
  readonly baseUrl?: string;
}

/**
 * The attribution link format Last.fm's terms require.
 *
 * Their canonical URLs use `+` for spaces, and encodeURIComponent produces
 * `%20`, so the substitution is not cosmetic: `%20` URLs redirect, and a
 * redirect chain is not the "specified format" the terms ask for.
 */
export function artistUrl(name: string): string {
  return `https://www.last.fm/music/${encodeURIComponent(name).replace(/%20/g, "+")}`;
}

export function trackUrl(artist: string, title: string): string {
  const a = encodeURIComponent(artist).replace(/%20/g, "+");
  const t = encodeURIComponent(title).replace(/%20/g, "+");
  return `https://www.last.fm/music/${a}/_/${t}`;
}

/** api_sig: md5 of the sorted param pairs plus the shared secret. */
export function signParams(
  params: Readonly<Record<string, string>>,
  sharedSecret: string,
): string {
  const joined = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k] ?? ""}`)
    .join("");
  return createHash("md5")
    .update(`${joined}${sharedSecret}`, "utf8")
    .digest("hex");
}

function assertNoInBandError(payload: unknown): void {
  if (!isRecord(payload)) return;
  const code = optNumber(payload, "error");
  if (code === undefined) return;
  const message = optString(payload, "message") ?? "unspecified Last.fm error";
  throw new UpstreamError({
    provider: "lastfm",
    kind: RETRYABLE_LASTFM_ERRORS.has(code)
      ? code === 29
        ? "rate_limited"
        : "server_error"
      : "http",
    message: `error ${String(code)}: ${message}`,
    status: code === 29 ? 429 : undefined,
  });
}

function parseArtist(v: unknown): LastfmArtist | null {
  const name = optString(v, "name");
  if (name === undefined) return null;
  const stats = optRecord(v, "stats");
  return {
    name,
    mbid: optMbid(v, "mbid"),
    // Prefer their URL when present, but never depend on it: attribution is a
    // licence condition, so a missing field must not produce a missing link.
    url: optString(v, "url") ?? artistUrl(name),
    match: optNumber(v, "match"),
    listeners: optNumber(stats, "listeners") ?? optNumber(v, "listeners"),
    tags: arrayOrSingle(optRecord(v, "tags") ?? optRecord(v, "toptags"), "tag")
      .map((t) => optString(t, "name"))
      .filter((n): n is string => n !== undefined),
  };
}

function parseTrack(v: unknown): LastfmTrack | null {
  const title = optString(v, "name");
  if (title === undefined) return null;
  const artist = optRecord(v, "artist");
  const artistName =
    optString(artist, "name") ?? optString(v, "artist") ?? "Unknown Artist";
  const durationSeconds = optNumber(v, "duration");
  return {
    title,
    artistName,
    mbid: optMbid(v, "mbid"),
    url: optString(v, "url") ?? trackUrl(artistName, title),
    match: optNumber(v, "match"),
    // track.getSimilar returns seconds; track.getInfo returns milliseconds.
    // Both are called "duration". Values under 10,000 are treated as seconds.
    durationMs:
      durationSeconds === undefined
        ? undefined
        : durationSeconds < 10_000
          ? durationSeconds * 1000
          : durationSeconds,
  };
}

export class LastfmClient implements Provider {
  readonly name = "lastfm" as const;
  readonly #http: ProviderClient;
  readonly #apiKey: string;
  readonly #sharedSecret: string | undefined;

  constructor(opts: LastfmClientOptions) {
    if (opts.apiKey === "") throw new Error("LASTFM_API_KEY is required");
    const { apiKey, sharedSecret, baseUrl, headers, ...rest } = opts;
    this.#apiKey = apiKey;
    this.#sharedSecret = sharedSecret;
    this.#http = new ProviderClient({
      ...rest,
      name: "lastfm",
      baseUrl: baseUrl ?? LASTFM_BASE_URL,
      headers: { ...headers, Accept: "application/json" },
      quota: opts.quota ?? LASTFM_QUOTA,
    });
  }

  /**
   * The circuit breaker for the main API, so the cache can convert a fresh hit
   * into the half-open trial call the breaker is waiting for. See
   * `CachedUpstream.setProbeWanted`. Read-only in practice; nothing outside a
   * test should be driving it.
   */
  get breaker(): CircuitBreaker {
    return this.#http.breaker;
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  async #call(
    method: string,
    params: Readonly<Record<string, string | number | undefined>>,
  ): Promise<unknown> {
    const payload = await this.#http.requestJson({
      path: "/",
      query: {
        ...params,
        method,
        api_key: this.#apiKey,
        format: "json",
      },
      // 403 with error 10 is an invalid key: a real body we want to read and
      // report precisely, not a bare transport failure.
      acceptStatuses: [400, 403],
    });
    assertNoInBandError(payload);
    return payload;
  }

  /** artist.getSimilar. The thin enrichment layer over ListenBrainz. */
  async similarArtists(name: string, limit = 20): Promise<LastfmArtist[]> {
    const payload = await this.#call("artist.getSimilar", {
      artist: name,
      limit,
      autocorrect: 1,
    });
    return arrayOrSingle(optRecord(payload, "similarartists"), "artist")
      .map(parseArtist)
      .filter((a): a is LastfmArtist => a !== null);
  }

  async artistInfo(name: string): Promise<LastfmArtist | null> {
    const payload = await this.#call("artist.getInfo", {
      artist: name,
      autocorrect: 1,
    });
    const artist = optRecord(payload, "artist");
    return artist === undefined ? null : parseArtist(artist);
  }

  async similarTracks(
    artist: string,
    title: string,
    limit = 20,
  ): Promise<LastfmTrack[]> {
    const payload = await this.#call("track.getSimilar", {
      artist,
      track: title,
      limit,
      autocorrect: 1,
    });
    return arrayOrSingle(optRecord(payload, "similartracks"), "track")
      .map(parseTrack)
      .filter((t): t is LastfmTrack => t !== null);
  }

  async trackInfo(artist: string, title: string): Promise<LastfmTrack | null> {
    const payload = await this.#call("track.getInfo", {
      artist,
      track: title,
      autocorrect: 1,
    });
    const track = optRecord(payload, "track");
    return track === undefined ? null : parseTrack(track);
  }

  /**
   * user.getTopArtists. Requires only the username, not the session key: a
   * public profile is readable without acting on the user's behalf, so the
   * credential stays in the vault for calls that genuinely need it.
   */
  async userTopArtists(
    userName: string,
    period = "3month",
    limit = 50,
  ): Promise<LastfmArtist[]> {
    const payload = await this.#call("user.getTopArtists", {
      user: userName,
      period,
      limit,
    });
    return arrayOrSingle(optRecord(payload, "topartists"), "artist")
      .map(parseArtist)
      .filter((a): a is LastfmArtist => a !== null);
  }

  /**
   * auth.getSession - the callback half of Last.fm's request-token flow.
   *
   * Signed, and the signature covers the api_key and token but NOT the format
   * parameter; including `format` in the signed set produces a valid-looking
   * signature that always fails, which is the classic hour-long debugging
   * detour with this API.
   */
  async getSession(token: string): Promise<LastfmSession> {
    if (this.#sharedSecret === undefined) {
      throw new Error("LASTFM_SHARED_SECRET is required for auth.getSession");
    }
    const signed = {
      api_key: this.#apiKey,
      method: "auth.getSession",
      token,
    };
    const payload = await this.#http.requestJson({
      path: "/",
      query: {
        ...signed,
        api_sig: signParams(signed, this.#sharedSecret),
        format: "json",
      },
      acceptStatuses: [400, 403],
    });
    assertNoInBandError(payload);
    const session = optRecord(payload, "session");
    const userName = optString(session, "name");
    const sessionKey = optString(session, "key");
    if (userName === undefined || sessionKey === undefined) {
      throw new UpstreamError({
        provider: "lastfm",
        kind: "malformed",
        message: "auth.getSession returned no session",
      });
    }
    return { userName, sessionKey };
  }
}
