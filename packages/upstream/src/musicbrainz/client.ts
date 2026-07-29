/**
 * MusicBrainz web service (ws/2).
 *
 * THIS FILE IS THE ONLY SANCTIONED CALLER OF musicbrainz.org. The semgrep rule
 * `pullfm-musicbrainz-must-use-ratelimited-client` (.semgrep/pullfm.yml) fails
 * CI if any other file fetches that host, and its only excluded path is a glob
 * ending in `musicbrainz/client.ts`. Do not move or rename this file without
 * updating that rule.
 *
 * Two conditions of use, both licence terms rather than preferences:
 *
 *   1. 1 request per second, averaged, PER IP - not per user, not per process.
 *      That is ~86,400 lookups/day for the entire service, so a RateLimiter is
 *      required at construction rather than optional. Sharing one instance
 *      across every client is the caller's responsibility and the reason the
 *      limiter is injected.
 *   2. A descriptive User-Agent naming the application and a contact address.
 *      Generic agents are throttled harder. The constructor rejects a missing
 *      or obviously generic agent rather than discovering the block later.
 *
 * At scale the documented unlock is a local mirror via the Live Data Feed
 * (docs/UPSTREAM-TERMS.md). Nothing here pretends otherwise.
 */

import { UpstreamError } from "../errors.js";
import {
  arrayOrSingle,
  isRecord,
  optMbid,
  optNumber,
  optString,
  reqString,
} from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { RateLimiter } from "../rate-limiter.js";
import type { Provider, ProviderStatus } from "../types.js";

export const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";

/** MusicBrainz's published average: one request per second, per IP, globally. */
export const MUSICBRAINZ_MIN_INTERVAL_MS = 1000;

export interface MusicBrainzArtist {
  readonly mbid: string;
  readonly name: string;
  readonly sortName: string | undefined;
  readonly country: string | undefined;
  readonly beganYear: number | undefined;
  readonly tags: readonly string[];
}

export interface MusicBrainzRecording {
  readonly mbid: string;
  readonly title: string;
  readonly lengthMs: number | undefined;
  readonly artistMbid: string | undefined;
  readonly artistName: string;
}

export interface MusicBrainzRelease {
  readonly mbid: string;
  readonly title: string;
  /** As MusicBrainz reports it: "1997", "1997-06", or "1997-06-16". */
  readonly date: string | undefined;
  readonly country: string | undefined;
  readonly trackCount: number | undefined;
  readonly artistMbid: string | undefined;
  readonly artistName: string;
}

export interface MusicBrainzSearchHit<T> {
  readonly entity: T;
  /** MusicBrainz's own 0-100 relevance score. */
  readonly score: number;
}

export interface MusicBrainzClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl" | "rateLimiter"
> {
  /** Required: `PullFM/0.1.0 (ope@312.dev)`. A licence condition. */
  readonly userAgent: string;
  /** Required and shared process-wide. The 1 req/s ceiling is per IP. */
  readonly rateLimiter: RateLimiter;
  readonly baseUrl?: string;
}

const USER_AGENT_RE = /^[\w.-]+\/[\d.]+\s+\(.+\)$/;

function parseArtist(v: unknown): MusicBrainzArtist {
  const mbid = optMbid(v, "id");
  if (mbid === undefined) {
    throw new UpstreamError({
      provider: "musicbrainz",
      kind: "malformed",
      message: "artist is missing a valid id",
    });
  }
  const lifeSpan = isRecord(v) ? v["life-span"] : undefined;
  const begin = optString(lifeSpan, "begin");
  const tags = arrayOrSingle(v, "tags")
    .map((t) => optString(t, "name"))
    .filter((n): n is string => n !== undefined);
  return {
    mbid,
    name: reqString(v, "name", "artist.name"),
    sortName: optString(v, "sort-name"),
    country: optString(v, "country"),
    beganYear: begin === undefined ? undefined : Number.parseInt(begin, 10),
    tags,
  };
}

function parseRecording(v: unknown): MusicBrainzRecording {
  const mbid = optMbid(v, "id");
  if (mbid === undefined) {
    throw new UpstreamError({
      provider: "musicbrainz",
      kind: "malformed",
      message: "recording is missing a valid id",
    });
  }
  // "artist-credit" is the hyphenated key hand-rolled clients always get wrong;
  // the name lives on the credit, not on the nested artist, because a credit
  // can rename the artist for that release ("Bowie" vs "David Bowie").
  const credits = arrayOrSingle(v, "artist-credit");
  const first = credits[0];
  const nested = isRecord(first) ? first["artist"] : undefined;
  const artistName =
    optString(first, "name") ?? optString(nested, "name") ?? "Unknown Artist";
  return {
    mbid,
    title: reqString(v, "title", "recording.title"),
    lengthMs: optNumber(v, "length"),
    artistMbid: optMbid(nested, "id"),
    artistName,
  };
}

function parseRelease(v: unknown): MusicBrainzRelease {
  const mbid = optMbid(v, "id");
  if (mbid === undefined) {
    throw new UpstreamError({
      provider: "musicbrainz",
      kind: "malformed",
      message: "release is missing a valid id",
    });
  }
  const credits = arrayOrSingle(v, "artist-credit");
  const first = credits[0];
  const nested = isRecord(first) ? first["artist"] : undefined;
  // `media` is a list of discs; the track count of a release is their sum, and
  // taking the first medium's count silently under-reports every box set.
  let trackCount: number | undefined;
  for (const medium of arrayOrSingle(v, "media")) {
    const count = optNumber(medium, "track-count");
    if (count === undefined) continue;
    trackCount = (trackCount ?? 0) + count;
  }
  return {
    mbid,
    title: reqString(v, "title", "release.title"),
    date: optString(v, "date"),
    country: optString(v, "country"),
    trackCount,
    artistMbid: optMbid(nested, "id"),
    artistName:
      optString(first, "name") ?? optString(nested, "name") ?? "Unknown Artist",
  };
}

function parseSearch<T>(
  payload: unknown,
  key: string,
  parse: (v: unknown) => T,
): MusicBrainzSearchHit<T>[] {
  const raw = arrayOrSingle(payload, key);
  const out: MusicBrainzSearchHit<T>[] = [];
  for (const item of raw) {
    try {
      out.push({ entity: parse(item), score: optNumber(item, "score") ?? 0 });
    } catch {
      // One malformed row in a search result is not worth failing the lookup
      // that a user is waiting on; the remaining candidates are still usable.
    }
  }
  return out;
}

export class MusicBrainzClient implements Provider {
  readonly name = "musicbrainz" as const;
  readonly #http: ProviderClient;

  constructor(opts: MusicBrainzClientOptions) {
    if (!USER_AGENT_RE.test(opts.userAgent)) {
      throw new Error(
        'MUSICBRAINZ_USER_AGENT must identify the app and a contact, e.g. "PullFM/0.1.0 (ope@312.dev)"',
      );
    }
    const { userAgent, baseUrl, headers, ...rest } = opts;
    this.#http = new ProviderClient({
      ...rest,
      name: "musicbrainz",
      baseUrl: baseUrl ?? MUSICBRAINZ_BASE_URL,
      headers: {
        ...headers,
        "User-Agent": userAgent,
        Accept: "application/json",
      },
      // 1 req/s means a queued request can wait a long time legitimately; a
      // short timeout here would abandon slots we already paid a second for.
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  async lookupArtist(mbid: string): Promise<MusicBrainzArtist | null> {
    const payload = await this.#http.requestJson({
      path: `/artist/${encodeURIComponent(mbid)}`,
      query: { fmt: "json", inc: "tags" },
      emptyStatuses: [404],
    });
    return payload === null ? null : parseArtist(payload);
  }

  async lookupRecording(mbid: string): Promise<MusicBrainzRecording | null> {
    const payload = await this.#http.requestJson({
      path: `/recording/${encodeURIComponent(mbid)}`,
      query: { fmt: "json", inc: "artist-credits" },
      emptyStatuses: [404],
    });
    return payload === null ? null : parseRecording(payload);
  }

  /**
   * One release. `inc=media` is asked for because a release with no track
   * count renders as an album with no tracks, which reads as a data bug rather
   * than as the missing `inc` parameter it actually is.
   */
  async lookupRelease(mbid: string): Promise<MusicBrainzRelease | null> {
    const payload = await this.#http.requestJson({
      path: `/release/${encodeURIComponent(mbid)}`,
      query: { fmt: "json", inc: "artist-credits+media" },
      emptyStatuses: [404],
    });
    return payload === null ? null : parseRelease(payload);
  }

  /** Lucene search. Used by the crosswalk resolver, never on a hot path. */
  async searchArtist(
    name: string,
    limit = 5,
  ): Promise<MusicBrainzSearchHit<MusicBrainzArtist>[]> {
    const payload = await this.#http.requestJson({
      path: "/artist",
      query: { fmt: "json", query: `artist:"${escapeLucene(name)}"`, limit },
    });
    return parseSearch(payload, "artists", parseArtist);
  }

  async searchRecording(
    artist: string,
    title: string,
    limit = 5,
  ): Promise<MusicBrainzSearchHit<MusicBrainzRecording>[]> {
    const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
    const payload = await this.#http.requestJson({
      path: "/recording",
      query: { fmt: "json", query, limit },
    });
    return parseSearch(payload, "recordings", parseRecording);
  }
}

/**
 * Escapes Lucene syntax. An unescaped quote in an artist name does not just
 * fail: it silently changes the query into a different one that returns
 * plausible-looking wrong results, which is the worst possible failure for a
 * crosswalk that records its answers permanently.
 */
export function escapeLucene(input: string): string {
  return input.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}
