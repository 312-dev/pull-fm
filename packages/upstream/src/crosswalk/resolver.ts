/**
 * Name -> MBID resolution.
 *
 * Upstream sources disagree about spelling ("Bjork" vs "Björk", "Sigur Ros" vs
 * "Sigur Rós"), so resolution is fuzzy and the expensive fallback is a
 * MusicBrainz search - a provider that permits ONE request per second across
 * the entire service. That single fact dictates the whole design:
 *
 *   1. exact  lookup on the normalised key           (one indexed read)
 *   2. fuzzy  trigram lookup above a threshold       (one index scan)
 *   3. remote MusicBrainz search, rate-limited       (1 req/s, global)
 *   4. record the answer permanently
 *
 * Step 4 is what makes step 3 rare. Gate 2 requires a warm hit rate above 90%,
 * and `stats` here is the number that gate reads.
 *
 * CONFIDENCE is recorded rather than discarded because a fuzzy match is a
 * guess. Storing it lets a later, better resolution overwrite a worse one
 * (see PgCrosswalkStore.record) instead of the first guess being permanent.
 */

import { normalizeKey, normalizeTitle } from "../normalize.js";
import type { MusicBrainzClient } from "../musicbrainz/client.js";
import { isUpstreamError } from "../errors.js";
import type { CrosswalkEntity, CrosswalkHit, CrosswalkStore } from "./store.js";

export interface ResolverOptions {
  readonly store: CrosswalkStore;
  /** Optional: without it the resolver is local-only, which is a valid mode. */
  readonly musicbrainz?: MusicBrainzClient | undefined;
  /**
   * Minimum trigram similarity for a fuzzy hit. 0.55 is deliberately
   * conservative: a false merge writes a wrong MBID into a UNIQUE-keyed table
   * and poisons every future lookup of that name.
   */
  readonly fuzzyThreshold?: number;
  /** MusicBrainz search scores below this are not trusted. Their scale is 0-100. */
  readonly minSearchScore?: number;
}

export interface Resolution {
  readonly mbid: string;
  readonly confidence: number;
  readonly source: string;
  readonly matchedBy: "exact" | "fuzzy" | "remote";
}

export interface ResolverStats {
  readonly exact: number;
  readonly fuzzy: number;
  readonly remote: number;
  readonly unresolved: number;
  /** Local hits over total lookups. The Gate 2 warm-hit-rate number. */
  readonly warmHitRate: number;
}

export class CrosswalkResolver {
  readonly #store: CrosswalkStore;
  readonly #mb: MusicBrainzClient | undefined;
  readonly #fuzzyThreshold: number;
  readonly #minSearchScore: number;
  #exact = 0;
  #fuzzy = 0;
  #remote = 0;
  #unresolved = 0;

  constructor(opts: ResolverOptions) {
    this.#store = opts.store;
    this.#mb = opts.musicbrainz;
    this.#fuzzyThreshold = opts.fuzzyThreshold ?? 0.55;
    this.#minSearchScore = opts.minSearchScore ?? 80;
  }

  stats(): ResolverStats {
    const total = this.#exact + this.#fuzzy + this.#remote + this.#unresolved;
    return {
      exact: this.#exact,
      fuzzy: this.#fuzzy,
      remote: this.#remote,
      unresolved: this.#unresolved,
      warmHitRate: total === 0 ? 0 : (this.#exact + this.#fuzzy) / total,
    };
  }

  /** Resolves an artist name to an MBID. */
  async resolveArtist(name: string): Promise<Resolution | null> {
    const key = normalizeKey(name);
    const local = await this.#local("artist", key);
    if (local !== null) return local;
    if (this.#mb === undefined) {
      this.#unresolved++;
      return null;
    }

    let hits: { mbid: string; score: number }[] = [];
    try {
      hits = (await this.#mb.searchArtist(name, 5)).map((h) => ({
        mbid: h.entity.mbid,
        score: h.score,
      }));
    } catch (err) {
      // An upstream failure is not a "this artist does not exist" answer, and
      // recording it as one would write a permanent negative into the crosswalk.
      if (isUpstreamError(err)) {
        this.#unresolved++;
        return null;
      }
      throw err;
    }
    return this.#recordRemote("artist", key, hits, "musicbrainz:search:artist");
  }

  /** Resolves an (artist, title) pair to a recording MBID. */
  async resolveRecording(
    artist: string,
    title: string,
  ): Promise<Resolution | null> {
    // The key includes the artist because recording titles are not unique -
    // there are hundreds of distinct recordings called "Intro".
    const key = `${normalizeKey(artist)} ${normalizeTitle(title)}`.trim();
    const local = await this.#local("recording", key);
    if (local !== null) return local;
    if (this.#mb === undefined) {
      this.#unresolved++;
      return null;
    }

    let hits: { mbid: string; score: number }[] = [];
    try {
      hits = (await this.#mb.searchRecording(artist, title, 5)).map((h) => ({
        mbid: h.entity.mbid,
        score: h.score,
      }));
    } catch (err) {
      if (isUpstreamError(err)) {
        this.#unresolved++;
        return null;
      }
      throw err;
    }
    return this.#recordRemote(
      "recording",
      key,
      hits,
      "musicbrainz:search:recording",
    );
  }

  /**
   * Records a resolution obtained elsewhere.
   *
   * ListenBrainz and Last.fm both return MBIDs alongside names, which is a free
   * resolution of much higher quality than a search. Feeding those back is the
   * cheapest way to warm the crosswalk and is why the hit rate climbs without a
   * backfill job.
   */
  async learn(
    entityType: CrosswalkEntity,
    name: string,
    mbid: string,
    source: string,
    confidence = 0.95,
  ): Promise<void> {
    const key =
      entityType === "recording" ? normalizeTitle(name) : normalizeKey(name);
    if (key === "") return;
    await this.#store.record({
      entityType,
      normalizedKey: key,
      mbid,
      confidence,
      source,
    });
  }

  async #local(
    entityType: CrosswalkEntity,
    key: string,
  ): Promise<Resolution | null> {
    if (key === "") return null;
    const exact = await this.#store.lookupExact(entityType, key);
    if (exact !== null) {
      this.#exact++;
      return toResolution(exact);
    }
    const fuzzy = await this.#store.lookupFuzzy(
      entityType,
      key,
      this.#fuzzyThreshold,
    );
    if (fuzzy !== null) {
      this.#fuzzy++;
      return toResolution(fuzzy);
    }
    return null;
  }

  async #recordRemote(
    entityType: CrosswalkEntity,
    key: string,
    hits: readonly { mbid: string; score: number }[],
    source: string,
  ): Promise<Resolution | null> {
    const best = hits[0];
    if (best === undefined || best.score < this.#minSearchScore || key === "") {
      this.#unresolved++;
      return null;
    }
    // MusicBrainz scores are 0-100 relevance, not probabilities. Mapping to
    // 0.6-0.95 keeps a search result below a name+MBID pair learned directly
    // from a provider (0.95) and below an exact crosswalk row.
    const confidence = 0.6 + Math.min(best.score, 100) * 0.0035;
    await this.#store.record({
      entityType,
      normalizedKey: key,
      mbid: best.mbid,
      confidence,
      source,
    });
    this.#remote++;
    return { mbid: best.mbid, confidence, source, matchedBy: "remote" };
  }
}

function toResolution(hit: CrosswalkHit): Resolution {
  return {
    mbid: hit.mbid,
    // A fuzzy match is worth less than the row it matched: the row may be
    // correct while this particular name is not the same entity.
    confidence:
      hit.matchedBy === "exact"
        ? hit.confidence
        : hit.confidence * hit.similarity,
    source: hit.source,
    matchedBy: hit.matchedBy,
  };
}
