/**
 * Request coalescing: N concurrent callers asking for the same uncached thing
 * produce ONE upstream call.
 *
 * WHY THIS IS A CORRECTNESS CONTROL AND NOT A PERFORMANCE ONE
 * -----------------------------------------------------------
 * The rest of this package is built on the premise that a cache miss is rare.
 * That premise is false for exactly one shape of traffic, and it is the shape a
 * launch produces: a cold key that many users want at the same instant. The
 * artist radio for a popular artist, a Last.fm similar-artist list, a preview
 * for the track at the top of everyone's feed - each is ONE cache key that a
 * hundred requests can miss inside the same second, because none of them has
 * returned yet to write the row the others would have hit.
 *
 * Without coalescing that is a hundred upstream calls for one answer. Against
 * MusicBrainz's 1 req/s global ceiling or iTunes' ~20 calls/minute that is not
 * a slow response, it is a terms violation and an IP block with no appeals
 * process (docs/PLAN.md section 3, docs/UPSTREAM-TERMS.md). The cache cannot
 * prevent it on its own: a read-through cache only suppresses the SECOND call
 * once the first has finished, and the whole problem here is the window before
 * it finishes.
 *
 * WHAT THIS DOES NOT DO, STATED RATHER THAN IMPLIED
 * ------------------------------------------------
 * The map is per PROCESS. Two BFF nodes holding the same cold key produce two
 * upstream calls, not one. That is the honest bound and it is deliberately not
 * papered over with a distributed lock: a lock in Redis would add a network
 * round trip and a new failure mode to every cache miss in order to turn 2 into
 * 1, while the number that actually threatened the licence was 100. The
 * cross-process backstop is the shared `RateLimiter` for the paced providers and
 * the per-provider `Quota` counter, both of which fail closed.
 *
 * FAILURE IS SHARED, AND THAT IS THE POINT.
 * -----------------------------------------
 * When the leader's call fails, every follower receives the same rejection
 * rather than each retrying. A hundred callers converting one upstream failure
 * into a hundred retries is the stampede again, wearing the costume of
 * resilience. Callers that can degrade (the blend) already do so per section,
 * and callers that hold a stale cache entry still fall back to it individually,
 * because only the FILL is shared here and never the caller's own recovery.
 */

/**
 * Deduplicates concurrent work by key.
 *
 * Keys are namespaced by the caller, so one instance can serve several kinds of
 * work without collision. Nothing is retained after settlement: this is a map of
 * work IN FLIGHT, never a cache. Confusing the two would produce a cache with no
 * TTL, no size bound, and no eviction, which is the standard way an in-process
 * memo becomes a memory leak.
 */
export class SingleFlight {
  readonly #inFlight = new Map<string, Promise<unknown>>();
  #joined = 0;
  #started = 0;

  /**
   * Runs `work` for `key`, or joins the call already running for it.
   *
   * The check and the registration happen in one synchronous block with no
   * `await` between them. That is what makes this safe on a single-threaded
   * event loop: any number of callers can arrive between two ticks and exactly
   * one of them will find the map empty.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      this.#joined++;
      return existing as Promise<T>;
    }

    this.#started++;
    // `work()` is invoked inside the same tick as the `set`, so a synchronous
    // throw from it still leaves the map consistent: the promise is registered
    // and the `finally` below removes it.
    const flight = (async () => work())().finally(() => {
      // Guarded so a slow flight that has already been superseded cannot delete
      // its successor's entry. `run` never overwrites a live key, so this can
      // only differ under a future change, and a future change is exactly when
      // an unguarded delete would silently start re-admitting stampedes.
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
    });

    this.#inFlight.set(key, flight);
    return flight;
  }

  /**
   * Whether a call is already running for `key`.
   *
   * Only meaningful in the same synchronous block as the `run` that follows it,
   * which is exactly how the cache uses it: to label a caller as coalesced
   * rather than to decide anything. A caller that awaited between the two would
   * be reading a stale answer.
   */
  has(key: string): boolean {
    return this.#inFlight.has(key);
  }

  /** Work currently in flight. Zero at rest; a non-zero value at rest is a leak. */
  get size(): number {
    return this.#inFlight.size;
  }

  /**
   * How many callers were saved an upstream call, and how many calls were made.
   *
   * Recorded because "the cache is warm" and "the stampede control is working"
   * look identical from a hit-rate graph, and only one of them is what keeps us
   * inside a provider's published limit during a cold start.
   */
  get stats(): { started: number; joined: number } {
    return { started: this.#started, joined: this.#joined };
  }
}
