/**
 * ListenBrainz - the primary discovery source.
 *
 * Only the endpoints docs/UPSTREAM-TERMS.md verified live are implemented as
 * load-bearing. The ones the audit found broken are either absent or explicitly
 * modelled as failures, because a client that hides a broken endpoint behind a
 * fallback lets us build a feed section on something that does not work.
 *
 *   WORKING   /1/cf/recommendation/user/{name}/recording
 *             /1/user/{name}/playlists/createdfor
 *             /1/lb-radio/artist/{mbid}
 *             /1/stats/user/{name}/artists
 *   BROKEN    /1/explore/lb-radio         500 "currently disabled due to high load"
 *             /1/popularity/top-recordings-for-artist/{mbid}   500
 *   ELSEWHERE similar-artists lives on labs.api.listenbrainz.org and needs an
 *             exact `algorithm` enum. labs.* is experimental with NO SLA, so it
 *             is a separate client with its own breaker and returns [] on any
 *             failure rather than propagating.
 *
 * AUTH. Per-user token, `Authorization: Token <t>`. The token is passed as an
 * argument to each call and never stored on the client, so one client instance
 * serves every user and no long-lived object ever holds a credential (see the
 * semgrep rule `pullfm-no-decrypted-token-on-request`).
 */

import { UpstreamError, isUpstreamError } from "../errors.js";
import {
  arrayOrSingle,
  isRecord,
  optMbid,
  optNumber,
  optRecord,
  optString,
} from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const LISTENBRAINZ_BASE_URL = "https://api.listenbrainz.org";
export const LISTENBRAINZ_LABS_BASE_URL = "https://labs.api.listenbrainz.org";

/** Observed: `x-ratelimit-limit: 30` per 10 seconds, per token. */
/**
 * FALLBACK ONLY. The real limit comes from the response headers.
 *
 * ListenBrainz publish no numeric rate limit anywhere and their documentation
 * instructs clients to read `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
 * `X-RateLimit-Reset-In` from each response to discover it. This constant is an
 * observation from 2026-07-28, used until the first response arrives and
 * whenever a response omits the headers, and `adaptiveQuota` below is what
 * stops it becoming a guess that fails silently the day they lower the real
 * ceiling (docs/compliance/metabrainz-terms-review.md F3).
 */
export const LISTENBRAINZ_QUOTA = { limit: 30, windowMs: 10_000 } as const;

/**
 * The labs similar-artists algorithm enum, verified live. Labs rejects a
 * missing or unknown value with a 400, and the string is not guessable, so it
 * is pinned here as a constant rather than left to a caller.
 */
export const LABS_SIMILAR_ARTISTS_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

export interface RecordingRecommendation {
  readonly recordingMbid: string;
  readonly score: number;
}

export interface PlaylistSummary {
  readonly identifier: string;
  readonly title: string;
  readonly annotation: string | undefined;
  readonly createdAt: string | undefined;
}

export interface ArtistListen {
  readonly artistMbid: string | undefined;
  readonly artistName: string;
  readonly listenCount: number;
}

export interface RadioRecording {
  readonly recordingMbid: string;
  readonly recordingName: string;
  readonly artistMbid: string | undefined;
  readonly artistName: string;
  readonly similarity: number;
}

export interface SimilarArtist {
  readonly artistMbid: string;
  readonly name: string | undefined;
  readonly score: number;
}

export interface ListenBrainzClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  readonly baseUrl?: string;
  readonly labsBaseUrl?: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Token ${token}` };
}

export class ListenBrainzClient implements Provider {
  readonly name = "listenbrainz" as const;
  readonly #http: ProviderClient;
  readonly #labs: ProviderClient;

  constructor(opts: ListenBrainzClientOptions = {}) {
    const { baseUrl, labsBaseUrl, headers, ...rest } = opts;
    const common = {
      ...rest,
      name: "listenbrainz" as const,
      headers: { ...headers, Accept: "application/json" },
      quota: opts.quota ?? LISTENBRAINZ_QUOTA,
      // The provider is the authority on its own limit; the constant above is
      // only what we use before it has told us.
      adaptiveQuota: true,
    };
    this.#http = new ProviderClient({
      ...common,
      baseUrl: baseUrl ?? LISTENBRAINZ_BASE_URL,
    });
    // A separate breaker for labs: it is an experimental tier with no SLA, and
    // letting its failures open the circuit on the main API would take out the
    // primary discovery source whenever an experiment breaks.
    this.#labs = new ProviderClient({
      ...common,
      baseUrl: labsBaseUrl ?? LISTENBRAINZ_LABS_BASE_URL,
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
      retry: { maxAttempts: 1, ...opts.retry },
      timeoutMs: opts.timeoutMs ?? 3_000,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  /** Confirms a user-supplied token before it is stored in the vault. */
  async validateToken(
    token: string,
  ): Promise<{ valid: boolean; userName: string | undefined }> {
    const payload = await this.#http.requestJson({
      path: "/1/validate-token",
      headers: authHeaders(token),
      emptyStatuses: [401],
    });
    if (payload === null) return { valid: false, userName: undefined };
    return {
      valid: isRecord(payload) && payload["valid"] === true,
      userName: optString(payload, "user_name"),
    };
  }

  /** Collaborative-filtered recordings. The backbone of "Made For You". */
  async recommendedRecordings(
    userName: string,
    token: string,
    count = 25,
  ): Promise<RecordingRecommendation[]> {
    const payload = await this.#http.requestJson({
      path: `/1/cf/recommendation/user/${encodeURIComponent(userName)}/recording`,
      query: { count },
      headers: authHeaders(token),
      emptyStatuses: [404],
    });
    const inner = optRecord(payload, "payload");
    const out: RecordingRecommendation[] = [];
    for (const item of arrayOrSingle(inner, "mbids")) {
      const mbid = optMbid(item, "recording_mbid");
      if (mbid === undefined) continue;
      out.push({ recordingMbid: mbid, score: optNumber(item, "score") ?? 0 });
    }
    return out;
  }

  /** Weekly Jams / Weekly Discovery, generated for the user by troi-bot. */
  async createdForPlaylists(
    userName: string,
    token: string,
  ): Promise<PlaylistSummary[]> {
    const payload = await this.#http.requestJson({
      path: `/1/user/${encodeURIComponent(userName)}/playlists/createdfor`,
      headers: authHeaders(token),
      emptyStatuses: [404],
    });
    const out: PlaylistSummary[] = [];
    for (const wrapper of arrayOrSingle(payload, "playlists")) {
      const pl = optRecord(wrapper, "playlist");
      if (pl === undefined) continue;
      const identifier = optString(pl, "identifier");
      const title = optString(pl, "title");
      if (identifier === undefined || title === undefined) continue;
      out.push({
        identifier,
        title,
        annotation: optString(pl, "annotation"),
        createdAt: optString(pl, "date"),
      });
    }
    return out;
  }

  /** Artist radio: similar artists expanded into concrete recordings. */
  async artistRadio(
    artistMbid: string,
    token: string,
  ): Promise<RadioRecording[]> {
    const payload = await this.#http.requestJson({
      path: `/1/lb-radio/artist/${encodeURIComponent(artistMbid)}`,
      headers: authHeaders(token),
      emptyStatuses: [404],
    });
    if (!isRecord(payload)) return [];
    const out: RadioRecording[] = [];
    // Keyed by seed MBID rather than returning a list, so the shape is
    // { "<mbid>": { artist_name, recordings: [...] } }.
    for (const bucket of Object.values(payload)) {
      for (const rec of arrayOrSingle(bucket, "recordings")) {
        const mbid = optMbid(rec, "recording_mbid");
        const name = optString(rec, "recording_name");
        if (mbid === undefined || name === undefined) continue;
        out.push({
          recordingMbid: mbid,
          recordingName: name,
          artistMbid: optMbid(rec, "artist_mbid"),
          artistName: optString(rec, "artist_name") ?? "Unknown Artist",
          similarity: optNumber(rec, "similarity") ?? 0,
        });
      }
    }
    return out;
  }

  async topArtists(
    userName: string,
    token: string,
    range = "month",
  ): Promise<ArtistListen[]> {
    const payload = await this.#http.requestJson({
      path: `/1/stats/user/${encodeURIComponent(userName)}/artists`,
      query: { range },
      // 204 means "not enough listens yet", which is a normal state for a new
      // account and must not read as an error.
      emptyStatuses: [204, 404],
      headers: authHeaders(token),
    });
    const inner = optRecord(payload, "payload");
    const out: ArtistListen[] = [];
    for (const item of arrayOrSingle(inner, "artists")) {
      const name = optString(item, "artist_name");
      if (name === undefined) continue;
      out.push({
        artistMbid: optMbid(item, "artist_mbid"),
        artistName: name,
        listenCount: optNumber(item, "listen_count") ?? 0,
      });
    }
    return out;
  }

  /**
   * labs.api similar artists. BEST EFFORT: returns [] on any failure.
   *
   * The audit is explicit that labs is an experimental tier with no SLA, so a
   * failure here is an expected operating condition, not an incident. Callers
   * cannot distinguish "no similar artists" from "labs is down", and that is
   * the correct contract for a section that is optional by design.
   */
  async similarArtists(
    artistMbid: string,
    algorithm: string = LABS_SIMILAR_ARTISTS_ALGORITHM,
  ): Promise<SimilarArtist[]> {
    let payload: unknown;
    try {
      payload = await this.#labs.requestJson({
        path: "/similar-artists/json",
        query: { artist_mbids: artistMbid, algorithm },
        emptyStatuses: [400, 404, 500],
      });
    } catch (err) {
      if (isUpstreamError(err)) return [];
      throw err;
    }
    if (payload === null) return [];
    const out: SimilarArtist[] = [];
    for (const item of Array.isArray(payload) ? payload : []) {
      const mbid = optMbid(item, "artist_mbid");
      if (mbid === undefined) continue;
      out.push({
        artistMbid: mbid,
        name: optString(item, "name"),
        score: optNumber(item, "score") ?? 0,
      });
    }
    return out;
  }

  /**
   * Prompt-based LB Radio. Returns null rather than throwing.
   *
   * As of the 2026-07-28 audit this endpoint answers 500 "currently disabled
   * due to high load". It is implemented so that the day it comes back we
   * change one flag rather than write a client, and it returns null so no
   * caller can accidentally depend on it working.
   */
  async exploreRadio(
    prompt: string,
    token: string,
  ): Promise<RadioRecording[] | null> {
    try {
      const payload = await this.#http.requestJson({
        path: "/1/explore/lb-radio",
        query: { prompt, mode: "easy" },
        headers: authHeaders(token),
        emptyStatuses: [500],
      });
      if (payload === null) return null;
      const inner = optRecord(payload, "payload");
      const out: RadioRecording[] = [];
      for (const rec of arrayOrSingle(inner, "jspf")) {
        const mbid = optMbid(rec, "recording_mbid");
        const name = optString(rec, "recording_name");
        if (mbid === undefined || name === undefined) continue;
        out.push({
          recordingMbid: mbid,
          recordingName: name,
          artistMbid: optMbid(rec, "artist_mbid"),
          artistName: optString(rec, "artist_name") ?? "Unknown Artist",
          similarity: optNumber(rec, "similarity") ?? 0,
        });
      }
      return out;
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "server_error") {
        return null;
      }
      throw err;
    }
  }
}
