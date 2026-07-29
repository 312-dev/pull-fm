/**
 * ReccoBeats - audio features, keyless.
 *
 * Returns exactly Spotify's deprecated `audio-features` schema, which is what
 * `audio_features` in 0001_initial.sql is shaped around. It is the only
 * self-serve source left: AcousticBrainz froze in 2022 and self-reports low
 * quality, Spotify removed the endpoint in 2024, and Essentia needs audio we
 * are not licensed to download.
 *
 * OPERATOR RISK, stated plainly (docs/UPSTREAM-TERMS.md): anonymous operator,
 * no SLA, no status page, no revenue model. The audit's judgment is that this
 * is a convenience layer, not infrastructure. Two consequences are built in:
 *
 *   1. `ttlSeconds: null` - features are cached PERMANENTLY on first fetch, so
 *      the day ReccoBeats disappears we degrade to "no new features" rather
 *      than "no features".
 *   2. Never on the hot path. Callers read `audio_features` from Postgres and
 *      fill gaps in the background.
 *
 * TWO-CALL SEQUENCE, and it is not optional:
 *   GET /v1/track?ids=<spotify_id>        -> a ReccoBeats UUID
 *   GET /v1/track/<uuid>/audio-features   -> features keyed on THAT uuid
 * Passing a Spotify id to the second call returns 404.
 */

import {
  arrayOrSingle,
  isMbid,
  optNumber,
  optRecord,
  optString,
} from "../json.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const RECCOBEATS_BASE_URL = "https://api.reccobeats.com";

/** Undocumented limits. Budgeted low: an anonymous service owes us nothing. */
export const RECCOBEATS_QUOTA = { limit: 60, windowMs: 60_000 } as const;

export interface AudioFeatures {
  readonly tempo: number | undefined;
  readonly musicalKey: number | undefined;
  readonly mode: number | undefined;
  readonly energy: number | undefined;
  readonly valence: number | undefined;
  readonly danceability: number | undefined;
  readonly acousticness: number | undefined;
  readonly instrumentalness: number | undefined;
  readonly liveness: number | undefined;
  readonly speechiness: number | undefined;
  readonly loudness: number | undefined;
  readonly source: "reccobeats";
  /** Written into audio_features.confidence. Never outranks a better source. */
  readonly confidence: number;
}

export interface ReccoBeatsClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  readonly baseUrl?: string;
}

/** audio_features.musical_key is CHECKed to 0..11; anything else is dropped. */
function parseKey(v: unknown): number | undefined {
  const k = optNumber(v, "key");
  if (k === undefined) return undefined;
  return Number.isInteger(k) && k >= 0 && k <= 11 ? k : undefined;
}

export function parseAudioFeatures(payload: unknown): AudioFeatures {
  return {
    tempo: optNumber(payload, "tempo"),
    musicalKey: parseKey(payload),
    mode: optNumber(payload, "mode"),
    energy: optNumber(payload, "energy"),
    valence: optNumber(payload, "valence"),
    danceability: optNumber(payload, "danceability"),
    acousticness: optNumber(payload, "acousticness"),
    instrumentalness: optNumber(payload, "instrumentalness"),
    liveness: optNumber(payload, "liveness"),
    speechiness: optNumber(payload, "speechiness"),
    loudness: optNumber(payload, "loudness"),
    source: "reccobeats",
    // Higher than AcousticBrainz's 0.5 default (MetaBrainz call that data
    // unreliable) but not authoritative: the operator publishes no methodology.
    confidence: 0.7,
  };
}

export class ReccoBeatsClient implements Provider {
  readonly name = "reccobeats" as const;
  readonly #http: ProviderClient;

  constructor(opts: ReccoBeatsClientOptions = {}) {
    const { baseUrl, headers, ...rest } = opts;
    this.#http = new ProviderClient({
      ...rest,
      name: "reccobeats",
      baseUrl: baseUrl ?? RECCOBEATS_BASE_URL,
      headers: { ...headers, Accept: "application/json" },
      quota: opts.quota ?? RECCOBEATS_QUOTA,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  /** Step one: Spotify id -> ReccoBeats UUID. Null when they do not have it. */
  async resolveTrackId(spotifyId: string): Promise<string | null> {
    const payload = await this.#http.requestJson({
      path: "/v1/track",
      query: { ids: spotifyId },
      emptyStatuses: [400, 404],
    });
    for (const item of arrayOrSingle(payload, "content")) {
      const id = optString(item, "id");
      if (id !== undefined && isMbid(id)) return id;
    }
    return null;
  }

  /** Step two. Requires the ReccoBeats UUID, not the Spotify id. */
  async audioFeaturesByUuid(uuid: string): Promise<AudioFeatures | null> {
    const payload = await this.#http.requestJson({
      path: `/v1/track/${encodeURIComponent(uuid)}/audio-features`,
      emptyStatuses: [404],
    });
    if (payload === null) return null;
    // Some responses nest the features; accept either shape rather than
    // failing on a service that has no changelog.
    const inner = optRecord(payload, "audioFeatures") ?? payload;
    return parseAudioFeatures(inner);
  }

  /** Both hops. Two upstream calls, so callers must cache the result forever. */
  async audioFeatures(spotifyId: string): Promise<AudioFeatures | null> {
    const uuid = await this.resolveTrackId(spotifyId);
    if (uuid === null) return null;
    return this.audioFeaturesByUuid(uuid);
  }
}
