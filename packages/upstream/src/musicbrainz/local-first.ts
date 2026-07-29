/**
 * A MusicBrainz client that answers searches from the local canonical dump
 * first, and reaches the network only for what the dump cannot answer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ACTUALLY FIXES
 *
 * `CrosswalkResolver` calls `searchArtist` / `searchRecording` whenever a name
 * is not already in `mbid_crosswalk`. MusicBrainz permits ONE REQUEST PER SECOND
 * for the entire service, per IP, as a licence condition, so those calls happen
 * only in the background warmer's process - no HTTP route can reach MusicBrainz
 * at all, because every request-path read goes through `CachedUpstream.peek`,
 * which is database-only.
 *
 * This is therefore NOT a denial-of-service fix, and describing it as one would
 * be wrong: there is no request-path call to exhaust a budget with. What it
 * fixes is throughput. At one request per second the resolver can perform at
 * most ~86,400 lookups a day for the entire service, shared with every other
 * MusicBrainz call the warmer makes, and every name it cannot resolve is a name
 * whose rows stay uncached and therefore invisible to `peek`. A local answer
 * costs an index probe instead of a slot in that budget, so the names that do
 * need the network are the residue rather than the whole workload.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT INTERCEPTED
 *
 * Intercepted: `searchArtist` and `searchRecording`. Their argument is a NAME,
 * and the space of names is unbounded, so no cache can ever cover it. That is
 * exactly the workload a pre-normalised local key column was built for: the
 * dump's `combined_lookup` IS this query, computed once, upstream.
 *
 * NOT intercepted: `lookupArtist`, `lookupRecording`, `lookupRelease`. Their
 * argument is an MBID, so the reachable set is bounded by MusicBrainz's own
 * catalogue and, in practice, by what is already in our wishlist and crosswalk
 * tables. More importantly the canonical dump does not carry the fields those
 * methods return - no `length`, no release `date`, no `country`, no track count.
 * Serving a lookup from here would answer with a recording that has no duration
 * and a release that has no date, and the background warmer would then write
 * that impoverished row into `upstream_cache` where the request path reads it.
 * A partial answer that displaces a complete one is worse than a slow one, so
 * these deliberately fall through untouched.
 *
 * ---------------------------------------------------------------------------
 * THE RATE LIMITER, SINGLE FLIGHT AND CIRCUIT BREAKER ARE UNCHANGED
 *
 * This class extends `MusicBrainzClient` and calls `super` for everything it
 * cannot answer, so every request that does reach the network goes through
 * exactly the same `ProviderClient`, the same shared `RateLimiter`, the same
 * single-flight and the same circuit breaker as before. Nothing here paces,
 * coalesces, retries or short-circuits anything, and nothing here is on a
 * request path those components were guarding. They simply see less traffic,
 * which is the entire intended effect - and it means switching this off returns
 * the system precisely to its previous behaviour rather than to some other
 * configuration of it.
 *
 * It extends rather than wraps because `MusicBrainzClient` has private fields,
 * which makes it a nominal type: a structurally identical object is not
 * assignable to it, so `CrosswalkResolver` and `UpstreamBundle` would both have
 * to change their types to accept a wrapper. Subclassing keeps this feature out
 * of files it has no business editing.
 *
 * ---------------------------------------------------------------------------
 * IT DEFAULTS TO OFF, IN THIS CONSTRUCTOR, AND NOT ONLY IN CONFIG
 *
 * `enabled` defaults to `false`. That is a deliberate response to the
 * `SEATGEEK_ENABLED` lesson: that flag was documented as a kill switch, was
 * declared with `.default("true")` in config.ts, AND was force-written `true` by
 * infra/lib/secrets.sh, so the documented lever had already been bypassed by
 * every deployment that had credentials. A flag is only a kill switch if the
 * failure mode of forgetting it is OFF, at every layer that can decide.
 *
 * The layers this file controls: this constructor, which needs an explicit
 * `enabled: true`; and the store, which answers "miss" rather than throwing when
 * the table is missing, so even an enabled resolver degrades to the old path.
 *
 * The layers it does NOT control, named so nobody assumes otherwise:
 * `MB_LOCAL_ENABLED` in apps/bff/src/config.ts (declared with
 * `.default("false")`), whatever infra/lib/secrets.sh writes into the deployed
 * environment, and the scheduler that decides whether the loader ever runs. If
 * any of those starts asserting `true`, this constructor's default stops being
 * the last line of defence - which is exactly what happened to SeatGeek.
 */

import {
  canonicalCoverage,
  canonicalFold,
  canonicalKeyVariants,
} from "./canonical-key.js";
import {
  prefixUpperBound,
  type CanonicalRow,
  type CanonicalStore,
} from "./canonical-store.js";
import {
  MusicBrainzClient,
  type MusicBrainzArtist,
  type MusicBrainzClientOptions,
  type MusicBrainzRecording,
  type MusicBrainzSearchHit,
} from "./client.js";

export interface LocalFirstMusicBrainzOptions extends MusicBrainzClientOptions {
  /** The local dump reader. Absent means this behaves as the plain client. */
  readonly canonical?: CanonicalStore | undefined;
  /**
   * Master switch. FALSE UNLESS EXPLICITLY TRUE. See the header.
   *
   * When false, not one query is issued against `mb.canonical` and every method
   * is the inherited one, so the switch removes the feature rather than
   * disabling part of it.
   */
  readonly enabled?: boolean | undefined;
  /**
   * Rows to pull for a prefix scan before de-duplicating by artist.
   *
   * A prefix range for a prolific artist can cover tens of thousands of rows,
   * and the query sorts them by score. This bounds that sort. It is a ceiling on
   * database work rather than on answer quality: the rows come back in the
   * dump's own canonical-release order, so the wanted artist is near the top or
   * is not in the dump at all.
   */
  readonly prefixScanLimit?: number;
}

/**
 * Counters for `/metrics`, and the number that says whether this works.
 *
 * `localHits / (localHits + remoteFallbacks)` is the fraction of the global
 * MusicBrainz budget this feature stopped spending. `unmatchable` is the
 * fraction it can never spend, because the key contains a script this
 * implementation cannot transliterate the way the dump did (see
 * canonical-key.ts); that is a permanent gap in coverage rather than a cache
 * that needs warming, and reporting it separately is what keeps the two from
 * being confused.
 */
export interface LocalFirstStats {
  readonly localHits: number;
  readonly remoteFallbacks: number;
  readonly unmatchable: number;
  readonly enabled: boolean;
}

/**
 * The score reported for a locally answered search.
 *
 * 100, the top of MusicBrainz's own 0-100 relevance scale, and it is honest
 * rather than optimistic. A hit here is an exact match on the dump's own
 * pre-computed lookup key, and the artist credit is then RE-FOLDED and compared
 * before the row is returned, so it is a stronger claim than anything the search
 * endpoint's fuzzy ranking produces. `CrosswalkResolver` maps 100 to a
 * confidence of 0.95, which is the same weight it gives an MBID learned directly
 * from a provider's own payload. That is the right tier.
 *
 * NOTE that this is the SEARCH ENDPOINT's 0-100 scale and has nothing to do with
 * `mb.canonical.score`, which is a rank over releases where lower is better. The
 * two never meet: the dump's score orders candidates inside the store, and this
 * constant is what the resolver above sees.
 */
const LOCAL_SCORE = 100;

export class LocalFirstMusicBrainzClient extends MusicBrainzClient {
  readonly #canonical: CanonicalStore | undefined;
  readonly #enabled: boolean;
  readonly #prefixScanLimit: number;
  #localHits = 0;
  #remoteFallbacks = 0;
  #unmatchable = 0;

  constructor(opts: LocalFirstMusicBrainzOptions) {
    const { canonical, enabled, prefixScanLimit, ...rest } = opts;
    super(rest);
    this.#canonical = canonical;
    // Fail closed. `enabled === true` and nothing else, so an undefined, a null
    // coerced through JSON, or the string "false" all leave this off.
    this.#enabled = enabled === true && canonical !== undefined;
    this.#prefixScanLimit = prefixScanLimit ?? 200;
  }

  get localStats(): LocalFirstStats {
    return {
      localHits: this.#localHits,
      remoteFallbacks: this.#remoteFallbacks,
      unmatchable: this.#unmatchable,
      enabled: this.#enabled,
    };
  }

  /**
   * Artist search, from the local dump when it can answer.
   *
   * The dump has no artist table: `combined_lookup` is the artist credit and the
   * recording name folded together. What makes this work is that the fold is per
   * character, so it distributes over the concatenation and the folded artist
   * name is exactly a prefix of every one of that artist's rows.
   *
   * A prefix is not an equality, so "beatles" also matches "beatlesque". Every
   * candidate row is therefore RE-VERIFIED by folding its own
   * `artist_credit_name` and comparing: a prefix scan finds candidates, an exact
   * comparison decides. Without that check this would resolve one artist to
   * another with a longer name, permanently, in a UNIQUE-keyed crosswalk.
   */
  override async searchArtist(
    name: string,
    limit = 5,
  ): Promise<MusicBrainzSearchHit<MusicBrainzArtist>[]> {
    const rows = await this.#artistCandidates(name);
    if (rows === null) return await this.#remoteArtist(name, limit);

    const key = canonicalFold(name);
    const seen = new Set<string>();
    const out: MusicBrainzSearchHit<MusicBrainzArtist>[] = [];
    for (const row of rows) {
      if (canonicalFold(row.artistCreditName) !== key) continue;
      if (seen.has(row.artistMbid)) continue;
      seen.add(row.artistMbid);
      out.push({
        entity: {
          mbid: row.artistMbid,
          name: row.artistCreditName,
          // The dump carries none of these. Reported as absent rather than
          // guessed: an empty sort name would be written into a cache as
          // though MusicBrainz had said so.
          sortName: undefined,
          country: undefined,
          beganYear: undefined,
        },
        score: LOCAL_SCORE,
      });
      if (out.length >= limit) break;
    }

    if (out.length === 0) return await this.#remoteArtist(name, limit);
    this.#localHits += 1;
    return out;
  }

  /**
   * Recording search, from the local dump when it can answer.
   *
   * `combined_lookup` is exactly this query's key, which is what makes the local
   * path an equality probe rather than a search. Two keys are tried - the
   * caller's title folded verbatim, then the same title with store decorations
   * like "- 2011 Remaster" removed - because the caller's title comes from a
   * scrobble and the dump's comes from the recording. Both are indexed local
   * probes; see `canonicalKeyVariants`.
   *
   * The artist credit is re-verified for the same reason as in `searchArtist`:
   * the fold concatenates, so artist "ab" + title "c" and artist "a" + title
   * "bc" produce the same key, and only comparing the artist halves separates
   * them.
   */
  override async searchRecording(
    artist: string,
    title: string,
    limit = 5,
  ): Promise<MusicBrainzSearchHit<MusicBrainzRecording>[]> {
    if (!this.#enabled || this.#canonical === undefined) {
      return await this.#remoteRecording(artist, title, limit);
    }

    const artistKey = canonicalFold(artist);
    const keys = canonicalKeyVariants(artist, title);
    if (keys.length === 0 || !keys.every(canonicalCoverage)) {
      // A key we could not fully transliterate cannot equal any row, so the
      // query is decidably pointless. Counted, because the rate at which this
      // happens is the honest measure of the local table's coverage.
      if (keys.length > 0) this.#unmatchable += 1;
      return await this.#remoteRecording(artist, title, limit);
    }

    for (const key of keys) {
      const rows = await this.#canonical.lookupExact(key, limit * 4);
      const out = this.#toRecordingHits(rows, artistKey, limit);
      if (out.length > 0) {
        this.#localHits += 1;
        return out;
      }
    }
    return await this.#remoteRecording(artist, title, limit);
  }

  /** Prefix candidates for an artist, or null when the local path cannot run. */
  async #artistCandidates(name: string): Promise<CanonicalRow[] | null> {
    if (!this.#enabled || this.#canonical === undefined) return null;
    const key = canonicalFold(name);
    if (!canonicalCoverage(key)) {
      if (key !== "") this.#unmatchable += 1;
      return null;
    }
    const upper = prefixUpperBound(key);
    /* c8 ignore next -- canonicalCoverage already guarantees a bound exists */
    if (upper === null) return null;
    return await this.#canonical.lookupArtistPrefix(
      key,
      upper,
      this.#prefixScanLimit,
    );
  }

  #toRecordingHits(
    rows: readonly CanonicalRow[],
    artistKey: string,
    limit: number,
  ): MusicBrainzSearchHit<MusicBrainzRecording>[] {
    const seen = new Set<string>();
    const out: MusicBrainzSearchHit<MusicBrainzRecording>[] = [];
    for (const row of rows) {
      if (canonicalFold(row.artistCreditName) !== artistKey) continue;
      if (seen.has(row.recordingMbid)) continue;
      seen.add(row.recordingMbid);
      out.push({
        entity: {
          mbid: row.recordingMbid,
          title: row.recordingName,
          // Absent in the dump. See the class header for why a partial answer
          // is not served in place of a complete one anywhere it would be
          // persisted; here it is a search hit, and `CrosswalkResolver` reads
          // only `mbid` and `score` from it.
          lengthMs: undefined,
          artistMbid: row.artistMbid,
          artistName: row.artistCreditName,
        },
        score: LOCAL_SCORE,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async #remoteArtist(
    name: string,
    limit: number,
  ): Promise<MusicBrainzSearchHit<MusicBrainzArtist>[]> {
    this.#remoteFallbacks += 1;
    return await super.searchArtist(name, limit);
  }

  async #remoteRecording(
    artist: string,
    title: string,
    limit: number,
  ): Promise<MusicBrainzSearchHit<MusicBrainzRecording>[]> {
    this.#remoteFallbacks += 1;
    return await super.searchRecording(artist, title, limit);
  }
}
