/**
 * Cache-first read-through.
 *
 * Two behaviours here are not obvious and both are deliberate:
 *
 * 1. STALE-ON-ERROR. When a cached entry has expired but the upstream refresh
 *    fails, the stale payload is served rather than the error. An expired
 *    similar-artist list is a far better answer than an empty shelf, and it is
 *    what keeps a provider outage from emptying the feed. The result carries
 *    `stale: true` so the caller can still mark the response degraded.
 *
 * 2. POISON EVICTION. If a cached payload no longer parses, the row is deleted
 *    and the upstream is re-fetched once. Otherwise a provider's schema change
 *    would keep serving the same unparseable row from cache until its TTL,
 *    turning a transient incompatibility into a persistent outage.
 *
 * 3. SINGLE-FLIGHT FILL. Concurrent misses on the SAME key share one upstream
 *    call. A read-through cache only suppresses the second call once the first
 *    has returned, so on a cold key it suppresses nothing at all: a hundred
 *    requests arriving in the same second all miss, all call out, and none of
 *    them has written the row the others would have hit. Against MusicBrainz's
 *    1 req/s global ceiling that is a terms violation rather than a slow page.
 *    See ../single-flight.ts for what this does and does not guarantee.
 *
 * The hit-rate counters exist because Gate 2 requires a warm hit rate above
 * 90%, and a number nobody records is a gate nobody can pass.
 */

import { UpstreamError, isUpstreamError } from "../errors.js";
import { MalformedPayloadError } from "../json.js";
import { SingleFlight } from "../single-flight.js";
import type { ProviderName } from "../types.js";
import type { CacheGovernor } from "./governor.js";
import type { CacheStore } from "./store.js";

export interface CacheFirstSpec<T> {
  readonly provider: ProviderName;
  readonly key: string;
  /** null caches permanently: ReccoBeats features, resolved MBIDs. */
  readonly ttlSeconds: number | null;
  /** Fetches the raw payload from the provider. Only called on a miss. */
  readonly load: () => Promise<unknown>;
  /** Maps a raw payload (fresh or cached) to the typed value. Must be pure. */
  readonly parse: (payload: unknown) => T;
  /** Skips the cache read but still writes. For a forced refresh. */
  readonly refresh?: boolean;
}

export interface CacheFirstResult<T> {
  readonly value: T;
  readonly hit: boolean;
  /** True when the entry was past its TTL and the refresh failed. */
  readonly stale: boolean;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly poisoned: number;
  /**
   * Misses that joined an upstream call already in flight for the same key.
   *
   * Counted separately from `hits` on purpose. A coalesced caller did not find
   * a cached row, so calling it a hit would inflate the Gate 2 warm-hit-rate
   * number with requests that were only saved by the stampede control. The two
   * are different properties and a graph that conflates them cannot show a cold
   * start going wrong.
   */
  readonly coalesced: number;
  /** Hits over total lookups. The Gate 2 number. */
  readonly hitRate: number;
}

interface Counters {
  hits: number;
  misses: number;
  stale: number;
  poisoned: number;
  coalesced: number;
}

/**
 * Marks a failure as coming from the PROVIDER rather than from us.
 *
 * Internal and never rethrown as itself: `fetch` unwraps it and throws the
 * original, so a caller still sees the `UpstreamError` it would have seen
 * before coalescing existed. It exists only so the stale-on-error fallback can
 * be applied to a provider outage and withheld from a parse or store failure,
 * which is a distinction the single shared flight would otherwise erase.
 */
class FillLoadError extends Error {
  public override readonly name = "FillLoadError";
  /** Named `reason` rather than `cause` so it does not shadow `Error.cause`. */
  constructor(public readonly reason: unknown) {
    super("upstream load failed");
  }
}

const zeroCounters = (): Counters => ({
  hits: 0,
  misses: 0,
  stale: 0,
  poisoned: 0,
  coalesced: 0,
});

export class CachedUpstream {
  readonly #store: CacheStore;
  readonly #governor: CacheGovernor | undefined;
  readonly #now: () => number;
  readonly #counters = new Map<ProviderName, Counters>();
  /**
   * One map for every provider and key, because the key already carries the
   * provider. A per-provider map would only add a lookup.
   */
  readonly #fills = new SingleFlight();

  constructor(
    store: CacheStore,
    opts: { governor?: CacheGovernor; now?: () => number } = {},
  ) {
    this.#store = store;
    this.#governor = opts.governor;
    this.#now = opts.now ?? (() => Date.now());
  }

  stats(provider: ProviderName): CacheStats {
    const c = this.#counters.get(provider) ?? zeroCounters();
    const total = c.hits + c.misses;
    return { ...c, hitRate: total === 0 ? 0 : c.hits / total };
  }

  /** Upstream fills started versus callers that joined one. See single-flight.ts. */
  get coalescing(): { started: number; joined: number } {
    return this.#fills.stats;
  }

  #bump(provider: ProviderName, field: keyof Counters): void {
    const c = this.#counters.get(provider) ?? zeroCounters();
    c[field]++;
    this.#counters.set(provider, c);
  }

  async fetch<T>(spec: CacheFirstSpec<T>): Promise<CacheFirstResult<T>> {
    let expiredPayload: unknown;
    let hasExpiredPayload = false;

    if (spec.refresh !== true) {
      const entry = await this.#store.get(spec.provider, spec.key);
      if (entry !== null) {
        const expired =
          entry.expiresAt !== null && entry.expiresAt <= this.#now();
        if (!expired) {
          try {
            const value = spec.parse(entry.payload);
            this.#bump(spec.provider, "hits");
            return { value, hit: true, stale: false };
          } catch (err) {
            if (!(err instanceof MalformedPayloadError)) throw err;
            this.#bump(spec.provider, "poisoned");
            await this.#store.delete(spec.provider, spec.key);
          }
        } else {
          expiredPayload = entry.payload;
          hasExpiredPayload = true;
        }
      }
    }

    this.#bump(spec.provider, "misses");

    // Provider and key are joined with a NUL so no provider name can collide
    // with the start of a key. Separators that can appear in a key are how two
    // unrelated fills quietly become one.
    const fillKey = `${spec.provider}\u0000${spec.key}`;
    if (this.#fills.has(fillKey)) this.#bump(spec.provider, "coalesced");

    let payload: unknown;
    try {
      // ONE upstream call per key, however many callers missed at once. Only
      // the FILL is shared: each caller still parses for itself and still runs
      // its own stale fallback below, so joining a flight never changes what an
      // individual caller would have concluded on its own.
      payload = await this.#fills.run(fillKey, () => this.#fill(spec));
    } catch (err) {
      // Only a LOAD failure may fall back to a stale entry. A parse or store
      // failure is our own bug or a poisoned write, and serving a stale row to
      // paper over it would hide the defect behind plausible data.
      if (err instanceof FillLoadError) {
        if (hasExpiredPayload) {
          try {
            const value = spec.parse(expiredPayload);
            this.#bump(spec.provider, "stale");
            return { value, hit: true, stale: true };
          } catch {
            // Stale entry is unusable too; the original failure is the real news.
          }
        }
        throw err.reason;
      }
      throw err;
    }

    return { value: spec.parse(payload), hit: false, stale: false };
  }

  /**
   * The shared half of a miss: call the provider, validate, write the row.
   *
   * Parsing here as well as in the caller is deliberate rather than redundant.
   * It is the WRITE GATE: an unparseable payload must not reach the cache,
   * because caching one converts a single bad response into a TTL-long outage
   * that the poison-eviction path then has to clean up on the next read.
   */
  async #fill<T>(spec: CacheFirstSpec<T>): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await spec.load();
    } catch (err) {
      // Wrapped so the caller can tell "the provider failed" from "we could not
      // make sense of what it said", which take different recovery paths.
      throw new FillLoadError(err);
    }
    spec.parse(payload);
    await this.#store.set(spec.provider, spec.key, payload, spec.ttlSeconds);
    if (this.#governor !== undefined) {
      await this.#governor.afterWrite(spec.provider);
    }
    return payload;
  }

  /**
   * Cache-only read. Used by anything that must not touch an upstream, such as
   * feed assembly under a tight deadline or a provider whose kill switch is off.
   */
  async peek<T>(
    provider: ProviderName,
    key: string,
    parse: (payload: unknown) => T,
  ): Promise<T | null> {
    const entry = await this.#store.get(provider, key);
    if (entry === null) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) return null;
    try {
      return parse(entry.payload);
    } catch (err) {
      if (err instanceof MalformedPayloadError) return null;
      throw err;
    }
  }
}

/** True when a failure should degrade the feed rather than fail the request. */
export function isDegradation(err: unknown): err is UpstreamError {
  return isUpstreamError(err) && err.isDegradation;
}
