/**
 * Should we spend a shared upstream call on this artist MBID at all?
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM, MEASURED
 *
 * `GET /v1/artists/{mbid}/similar` calls labs.api.listenbrainz.org for ANY
 * well-formed UUID. A random UUID is a guaranteed cache miss, so an attacker
 * gets a 1:1 request-to-upstream ratio with no cache to absorb it, against the
 * tightest shared allowance in the system: about 30 requests per 10 seconds
 * APP-WIDE with no token. `security/zap/upstream-scope.tsv` calls this route
 * "THE DANGEROUS ONE" for exactly this reason, and it is the reason the route is
 * removed from the DAST scan rather than merely rate limited.
 *
 * The per-subject upstream budget (lib/upstream-budget.ts) already bounds the
 * damage. Bounding is not the same as declining: an impossible lookup should
 * not consume a slot that a real one could have used.
 *
 * ---------------------------------------------------------------------------
 * THE CAVEAT THAT SHAPES THE WHOLE DESIGN
 *
 * `PgCanonicalStore.exists("artist", mbid)` is a local index probe, measured at
 * 0.09 ms. Its author states the asymmetry plainly and it is not negotiable:
 *
 *     TRUE IS AUTHORITATIVE AND FALSE IS NOT.
 *
 * The canonical dump is a SUBSET of MusicBrainz - one release per recording,
 * nothing that is not a recording - so a real MBID can be absent from it.
 * `false` means "not known here", never "does not exist". A naive reject on
 * `false` would 404 real artists, which is a worse outcome than the upstream
 * call it saves: it breaks users to protect a budget.
 *
 * So this gate never asks "does this artist exist". It asks a question the
 * local data CAN answer: IS THERE ANY REASON TO BELIEVE THIS IDENTIFIER IS
 * REAL? Four independent sources can say yes, and only the unanimous silence of
 * all four declines the call:
 *
 *   1. The canonical dump contains the artist         (authoritative yes)
 *   2. The MusicBrainz cache holds the artist         (we resolved it before)
 *   3. The crosswalk has learned it from a provider   (ListenBrainz named it)
 *   4. -- and if none of those, the gate stays OPEN unless the dump is
 *      demonstrably loaded, so a deployment without the data declines nothing.
 *
 * WHY THAT IS SAFE FOR REAL USERS, stated as a falsifiable claim rather than a
 * hope. The artist a real user reaches came from somewhere in this product: a
 * feed shelf, a station, a search result, an artist page. Every one of those
 * paths goes through the crosswalk or the MusicBrainz cache, so source 2 or 3
 * answers yes before source 1 is even consulted. The user who is declined is
 * the one who typed a UUID that appears in none of our data and in no canonical
 * recording credit - and for such an artist, labs similarity data is derived
 * from listens against recordings that also do not exist there, so the call it
 * saves would have returned an empty list.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DEGRADES, WHICH IS THE PART THAT MUST NOT BE GOT WRONG
 *
 * Every one of these makes the gate a no-op, and each is the DEFAULT rather
 * than an edge case:
 *
 *   - `MB_LOCAL_ENABLED` is false (the shipped default), so no canonical store
 *     is wired at all. Nothing is declined, ever.
 *   - The store is wired but `mb.load_state` reports no successful load, which
 *     is what an empty or absent table looks like.
 *   - The `mb` schema does not exist, which is normal after a restore from a
 *     logical backup that excluded it. `PgCanonicalStore` turns that into a
 *     miss and a backoff, so `loadState()` answers null and the gate opens.
 *   - Any probe throws. The gate opens.
 *
 * The failure direction is always "spend the call", which is the behaviour
 * before this file existed. There is no state in which a fault here can 404 a
 * legitimate lookup.
 */

import type { CanonicalStore } from "@pull-fm/upstream";

export interface ArtistLookupGateDeps {
  /**
   * The canonical dump reader, or undefined when the local MusicBrainz data is
   * switched off. Undefined is a first-class case, not a defect.
   */
  readonly canonical?: CanonicalStore | undefined;
  /**
   * Whether this application already holds a record naming this MBID: a warm
   * MusicBrainz cache row or a crosswalk entry learned from a provider.
   *
   * Injected rather than reached for, because the two stores it consults live
   * behind `UpstreamBundle` and this gate must stay testable without one.
   */
  readonly knownLocally: (mbid: string) => Promise<boolean>;
  /**
   * How long a `mb.load_state` reading may be reused.
   *
   * The gate is on a request path and the answer changes at most once per dump
   * load, so re-reading it per request would be a query per request for a value
   * that moves weekly.
   */
  readonly loadStateTtlMs?: number;
  /** Test seam. */
  readonly now?: () => number;
}

export interface ArtistLookupGate {
  /**
   * True when a similarity lookup for this MBID may spend an upstream call.
   *
   * Opens on every uncertainty. See the header: false is only ever returned
   * when a loaded canonical dump and every local record are silent together.
   */
  worthAsking(mbid: string): Promise<boolean>;
  /** How many lookups this gate has declined. For `/metrics` and for arguing. */
  readonly declined: number;
}

export class CanonicalArtistLookupGate implements ArtistLookupGate {
  readonly #deps: ArtistLookupGateDeps;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #declined = 0;
  /** Memoised `loadState()` answer and the epoch millis it expires at. */
  #dumpLoaded = false;
  #dumpCheckedUntil = -Infinity;

  constructor(deps: ArtistLookupGateDeps) {
    this.#deps = deps;
    this.#ttlMs = deps.loadStateTtlMs ?? 60_000;
    this.#now = deps.now ?? Date.now;
  }

  get declined(): number {
    return this.#declined;
  }

  async worthAsking(mbid: string): Promise<boolean> {
    const canonical = this.#deps.canonical;
    // No local data wired: this deployment declines nothing. The shipped
    // default (`MB_LOCAL_ENABLED=false`) lands here.
    if (canonical === undefined) return true;

    try {
      // A dump that is not demonstrably loaded cannot support a decision. An
      // empty table would otherwise answer "absent" for the entire catalogue
      // and decline every lookup in the product.
      if (!(await this.#loaded(canonical))) return true;

      // Authoritative yes, and the cheapest of the three probes (0.09 ms index
      // hit), so it runs first.
      if (await canonical.exists("artist", mbid)) return true;

      // Absent from the dump is NOT absent from MusicBrainz. Anything this
      // product has already resolved or learned counts as a reason to ask.
      if (await this.#deps.knownLocally(mbid)) return true;
    } catch {
      // A probe that throws must not be able to decline a lookup. The gate is
      // an optimisation in front of a working path, exactly like the store it
      // reads.
      return true;
    }

    this.#declined += 1;
    return false;
  }

  async #loaded(canonical: CanonicalStore): Promise<boolean> {
    const t = this.#now();
    if (t < this.#dumpCheckedUntil) return this.#dumpLoaded;
    const state = await canonical.loadState();
    this.#dumpLoaded = state !== null && state.rowsLoaded > 0;
    this.#dumpCheckedUntil = t + this.#ttlMs;
    return this.#dumpLoaded;
  }
}

/** The gate for a deployment with no local canonical data. Declines nothing. */
export class OpenArtistLookupGate implements ArtistLookupGate {
  readonly declined = 0;
  worthAsking(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
