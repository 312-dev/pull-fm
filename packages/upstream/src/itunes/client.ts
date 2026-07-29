/**
 * iTunes Search API - preview resolution ONLY.
 *
 * NOT AN INTERACTIVE SEARCH BACKEND. Apple documents "approximately 20 calls
 * per minute" per IP: one call every three seconds for the whole service. A
 * search-as-you-type feature would exhaust that in one user's session, so this
 * client exposes preview resolution and nothing that a UI could wire to a
 * search box. The quota counter enforces it locally rather than trusting the
 * caller.
 *
 * LICENCE (docs/UPSTREAM-TERMS.md L2):
 *   - previews may be streamed, "not downloaded, saved, cached, or
 *     synchronized". Only the resolved URL is stored, never audio bytes. This
 *     independently forbids downloading previews for audio-feature extraction.
 *   - attribution: "provided courtesy of iTunes" must accompany playback.
 *   - the preview asset itself is unsigned, has no expiry, and supports range
 *     requests, so the URL is genuinely stable and cacheable. That is the whole
 *     reason iTunes is preferred over Deezer for preview resolution.
 */

import { arrayOrSingle, optNumber, optString } from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const ITUNES_BASE_URL = "https://itunes.apple.com";

/**
 * Apple document "approximately 20 calls per minute" and state NO SCOPE for it:
 * not per key, not per IP, not per application. This repository used to assert
 * "per IP" in six places as though it were Apple's word. It is not, and the
 * distinction matters, because the real constraint is worse than either
 * reading: blocks are keyed to egress IP REPUTATION, and a service on shared
 * cloud egress has been blocked at roughly nine calls a minute - well under
 * Apple's own figure (docs/compliance/apple-itunes-terms-review.md A7, A14).
 *
 * We budget 15, because the documented consequence of exceeding the limit is
 * being blocked with no appeals process and the cost of under-spending is one
 * extra cache miss. It is necessary and NOT sufficient. Do not probe the real
 * ceiling by exceeding it.
 *
 * There is also nothing to adapt to: Apple return no rate-limit headers and
 * reject with an opaque 403 and an empty body rather than a 429, so any retry
 * logic keyed on 429 is dead code for this provider.
 */
export const ITUNES_QUOTA = { limit: 15, windowMs: 60_000 } as const;

export const ITUNES_ATTRIBUTION = "Preview provided courtesy of iTunes";

export interface ItunesPreview {
  readonly provider: "itunes";
  readonly previewUrl: string;
  readonly trackId: number | undefined;
  readonly trackName: string;
  readonly artistName: string;
  readonly collectionName: string | undefined;
  readonly durationMs: number | undefined;
  readonly artworkUrl: string | undefined;
  readonly trackViewUrl: string | undefined;
  readonly attribution: string;
  /** iTunes URLs do not expire, which is what makes them cacheable. */
  readonly expiresAt: null;
}

export interface ItunesClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  readonly baseUrl?: string;
  /** Storefront. Preview availability is territory-specific. */
  readonly country?: string;
}

function parsePreview(v: unknown): ItunesPreview | null {
  const previewUrl = optString(v, "previewUrl");
  const trackName = optString(v, "trackName");
  const artistName = optString(v, "artistName");
  if (
    previewUrl === undefined ||
    trackName === undefined ||
    artistName === undefined
  ) {
    return null;
  }
  return {
    provider: "itunes",
    previewUrl,
    trackId: optNumber(v, "trackId"),
    trackName,
    artistName,
    collectionName: optString(v, "collectionName"),
    durationMs: optNumber(v, "trackTimeMillis"),
    artworkUrl: optString(v, "artworkUrl100"),
    trackViewUrl: optString(v, "trackViewUrl"),
    attribution: ITUNES_ATTRIBUTION,
    expiresAt: null,
  };
}

export class ItunesClient implements Provider {
  readonly name = "itunes" as const;
  readonly #http: ProviderClient;
  readonly #country: string;

  constructor(opts: ItunesClientOptions = {}) {
    const { baseUrl, headers, country, ...rest } = opts;
    this.#country = country ?? "US";
    this.#http = new ProviderClient({
      ...rest,
      name: "itunes",
      baseUrl: baseUrl ?? ITUNES_BASE_URL,
      headers: { ...headers, Accept: "application/json" },
      quota: opts.quota ?? ITUNES_QUOTA,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  /**
   * Resolves a preview for an already-identified track.
   *
   * Returns the best match rather than a list, because returning candidates
   * would invite a caller to build a picker, and a picker is interactive search
   * by another name.
   */
  async resolvePreview(
    artist: string,
    title: string,
  ): Promise<ItunesPreview | null> {
    const payload = await this.#http.requestJson({
      path: "/search",
      query: {
        term: `${artist} ${title}`,
        entity: "song",
        media: "music",
        // Enough candidates to survive a compilation or a live version ranking
        // first, few enough that the response stays small.
        limit: 5,
        country: this.#country,
      },
    });
    const results = arrayOrSingle(payload, "results")
      .map(parsePreview)
      .filter((p): p is ItunesPreview => p !== null);
    return pickBestMatch(results, artist, title);
  }

  /** Lookup by Apple track id. Exact, and cheaper than a search when known. */
  async lookupTrack(trackId: number): Promise<ItunesPreview | null> {
    const payload = await this.#http.requestJson({
      path: "/lookup",
      query: { id: trackId, entity: "song", country: this.#country },
    });
    const first = arrayOrSingle(payload, "results")
      .map(parsePreview)
      .find((p): p is ItunesPreview => p !== null);
    return first ?? null;
  }
}

/**
 * Picks the candidate whose artist and title actually match.
 *
 * Taking `results[0]` is the common shortcut and it is wrong often enough to
 * matter: a search for a well-known song frequently ranks a karaoke or tribute
 * recording first, and the user hears the wrong thing with no way to tell why.
 */
export function pickBestMatch(
  candidates: readonly ItunesPreview[],
  artist: string,
  title: string,
): ItunesPreview | null {
  if (candidates.length === 0) return null;
  const wantArtist = artist.toLowerCase();
  const wantTitle = title.toLowerCase();
  let best: ItunesPreview | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const a = c.artistName.toLowerCase();
    const t = c.trackName.toLowerCase();
    let score = 0;
    if (a === wantArtist) score += 3;
    else if (a.includes(wantArtist) || wantArtist.includes(a)) score += 1;
    if (t === wantTitle) score += 3;
    else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Neither field matched at all: better to report no preview than to play an
  // unrelated track.
  return bestScore >= 2 ? best : null;
}
