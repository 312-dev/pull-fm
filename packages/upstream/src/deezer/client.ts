/**
 * Deezer - preview fallback, and the one provider whose output must NEVER be
 * cached.
 *
 * Deezer preview URLs are signed with an expiry (`?hdnea=exp=...~hmac=...`).
 * A stored URL 403s once the token lapses, so any design that writes one into
 * the crosswalk produces previews that work in testing and fail for users
 * minutes later. docs/PLAN.md section 1a states the rule; 0001_initial.sql
 * enforces it with `track_previews_deezer_expiry_chk`; this client enforces it
 * by returning an expiry on every result and by exposing `isExpired` so a
 * caller has no excuse for guessing.
 *
 * Also non-commercial-only (ToS section IV, verbatim: "strictly limited for a
 * non-commercial purpose and in a non-commercial environment"). Compliant only
 * because Pull.fm is locked non-commercial.
 *
 * ERROR SHAPE. Deezer answers HTTP 200 with `{ "error": { ... } }` for unknown
 * resources and for quota exhaustion. Status code alone is not a health signal.
 */

import { UpstreamError } from "../errors.js";
import {
  arrayOrSingle,
  isRecord,
  optNumber,
  optRecord,
  optString,
} from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const DEEZER_BASE_URL = "https://api.deezer.com";

/** Observed ~50 requests per 5 seconds, per IP. Budgeted at 40. */
export const DEEZER_QUOTA = { limit: 40, windowMs: 5_000 } as const;

export const DEEZER_ATTRIBUTION = "Preview provided by Deezer";

/**
 * Fallback lifetime when a URL carries no parseable `exp`.
 *
 * Deliberately short. Treating an unknown expiry as long-lived is how a signed
 * URL ends up cached; treating it as nearly-expired only costs a re-resolve.
 */
export const DEEZER_ASSUMED_TTL_MS = 60_000;

export interface DeezerPreview {
  readonly provider: "deezer";
  readonly previewUrl: string;
  readonly trackId: number | undefined;
  readonly trackName: string;
  readonly artistName: string;
  readonly albumName: string | undefined;
  readonly durationMs: number | undefined;
  readonly artworkUrl: string | undefined;
  readonly attribution: string;
  /** Always set. A Deezer preview without an expiry is a parsing bug. */
  readonly expiresAt: number;
  /** Structural reminder at the type level: this value must not be persisted. */
  readonly cacheable: false;
}

export interface DeezerClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  readonly baseUrl?: string;
}

/**
 * Reads the Akamai token expiry out of a signed preview URL.
 *
 * Format: `?hdnea=exp=<epoch seconds>~acl=<path>~hmac=<hex>`.
 */
export function parsePreviewExpiry(url: string, now: number): number {
  const q = url.indexOf("?");
  if (q === -1) return now + DEEZER_ASSUMED_TTL_MS;
  const params = new URLSearchParams(url.slice(q + 1));
  const token = params.get("hdnea");
  if (token === null) return now + DEEZER_ASSUMED_TTL_MS;
  for (const part of token.split("~")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) !== "exp") continue;
    const seconds = Number(part.slice(eq + 1));
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return now + DEEZER_ASSUMED_TTL_MS;
}

export function isExpired(preview: DeezerPreview, now = Date.now()): boolean {
  return preview.expiresAt <= now;
}

function assertNoErrorEnvelope(payload: unknown): void {
  const error = optRecord(payload, "error");
  if (error === undefined) return;
  const type = optString(error, "type") ?? "DeezerError";
  const message = optString(error, "message") ?? "unspecified";
  const code = optNumber(error, "code");
  // 4 is "Quota limit exceeded" and 700 is "service busy"; both are transient.
  const transient = code === 4 || code === 700;
  throw new UpstreamError({
    provider: "deezer",
    kind: transient ? "rate_limited" : "http",
    message: `${type}: ${message}`,
    status: transient ? 429 : 404,
  });
}

function parseTrack(v: unknown, now: number): DeezerPreview | null {
  const previewUrl = optString(v, "preview");
  const trackName = optString(v, "title");
  if (
    previewUrl === undefined ||
    previewUrl === "" ||
    trackName === undefined
  ) {
    return null;
  }
  const artist = optRecord(v, "artist");
  const album = optRecord(v, "album");
  const durationSeconds = optNumber(v, "duration");
  return {
    provider: "deezer",
    previewUrl,
    trackId: optNumber(v, "id"),
    trackName,
    artistName: optString(artist, "name") ?? "Unknown Artist",
    albumName: optString(album, "title"),
    durationMs:
      durationSeconds === undefined ? undefined : durationSeconds * 1000,
    artworkUrl: optString(album, "cover_medium"),
    attribution: DEEZER_ATTRIBUTION,
    expiresAt: parsePreviewExpiry(previewUrl, now),
    cacheable: false,
  };
}

export class DeezerClient implements Provider {
  readonly name = "deezer" as const;
  readonly #http: ProviderClient;
  readonly #now: () => number;

  constructor(opts: DeezerClientOptions = {}) {
    const { baseUrl, headers, clock, ...rest } = opts;
    this.#now = clock === undefined ? () => Date.now() : () => clock.now();
    this.#http = new ProviderClient({
      ...rest,
      ...(clock === undefined ? {} : { clock }),
      name: "deezer",
      baseUrl: baseUrl ?? DEEZER_BASE_URL,
      headers: { ...headers, Accept: "application/json" },
      quota: opts.quota ?? DEEZER_QUOTA,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  /**
   * Resolves a fresh, signed preview. MUST be called immediately before
   * playback; the returned URL is valid for seconds to minutes, not hours.
   */
  async resolvePreview(
    artist: string,
    title: string,
  ): Promise<DeezerPreview | null> {
    const payload = await this.#http.requestJson({
      path: "/search",
      query: { q: `artist:"${artist}" track:"${title}"`, limit: 5 },
    });
    assertNoErrorEnvelope(payload);
    const now = this.#now();
    const candidates = arrayOrSingle(payload, "data")
      .map((t) => parseTrack(t, now))
      .filter((t): t is DeezerPreview => t !== null);
    return pickBestMatch(candidates, artist, title);
  }

  /** Re-resolves by Deezer track id. The cheap path before playback. */
  async refreshPreview(trackId: number): Promise<DeezerPreview | null> {
    const payload = await this.#http.requestJson({
      path: `/track/${String(trackId)}`,
    });
    assertNoErrorEnvelope(payload);
    if (!isRecord(payload)) return null;
    return parseTrack(payload, this.#now());
  }
}

function pickBestMatch(
  candidates: readonly DeezerPreview[],
  artist: string,
  title: string,
): DeezerPreview | null {
  const wantArtist = artist.toLowerCase();
  const wantTitle = title.toLowerCase();
  let best: DeezerPreview | null = null;
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
  return bestScore >= 2 ? best : null;
}
