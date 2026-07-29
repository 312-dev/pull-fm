/**
 * Per-provider cache size enforcement.
 *
 * Last.fm's ToS 4.3.4 imposes a 100 MB "Reasonable Usage Cap" on cached Last.fm
 * data without written consent, and docs/PLAN.md section 1a makes staying under
 * it a hard design rule now that Pull.fm is locked non-commercial. A similarity
 * graph over a real catalogue passes 100 MB quickly, so this is not a
 * theoretical limit that we will never reach; it is the binding constraint on
 * the Last.fm layer.
 *
 * Three numbers, and the gap between them is the point:
 *
 *   softCap  (LASTFM_CACHE_CAP_MB, default 80 MB) - alert, and start evicting
 *   lowWater (default 90% of softCap)             - evict down to here
 *   hardCap  (100 MB, the licence)                - must never be reached
 *
 * Evicting to the soft cap exactly would make every subsequent write trigger
 * another eviction pass. Evicting to a low-water mark amortises it.
 *
 * Checks are sampled rather than run on every write: `sizeOf` is an aggregate
 * over the provider's rows, and running it per write would make the cache more
 * expensive than the upstream call it replaces.
 */

import type { ProviderName } from "../types.js";
import type { CacheStore, EvictionReport } from "./store.js";

const MB = 1024 * 1024;

/** The licence ceiling. Not configurable: it is a term, not a tuning knob. */
export const LASTFM_HARD_CAP_BYTES = 100 * MB;

export interface ProviderCap {
  /** Alert and begin eviction at this size. */
  readonly softCapBytes: number;
  /** Absolute ceiling. Eviction targets `lowWaterBytes`, well under this. */
  readonly hardCapBytes: number;
  readonly lowWaterBytes: number;
}

export interface CapAlert {
  readonly provider: ProviderName;
  readonly bytes: number;
  readonly softCapBytes: number;
  readonly hardCapBytes: number;
  readonly evicted: number;
  readonly bytesFreed: number;
}

export interface CacheGovernorOptions {
  readonly caps?: Partial<Record<ProviderName, ProviderCap>>;
  /** Run a size check every N writes for a provider. Default 20. */
  readonly checkEveryWrites?: number;
  readonly onAlert?: (alert: CapAlert) => void;
}

export function lastfmCap(softCapMb: number): ProviderCap {
  const softCapBytes = Math.min(
    Math.round(softCapMb * MB),
    // A soft cap above the licence ceiling would be a configuration error that
    // silently disables the protection, so it is clamped rather than trusted.
    LASTFM_HARD_CAP_BYTES - 5 * MB,
  );
  return {
    softCapBytes,
    hardCapBytes: LASTFM_HARD_CAP_BYTES,
    lowWaterBytes: Math.round(softCapBytes * 0.9),
  };
}

export class CacheGovernor {
  readonly #store: CacheStore;
  readonly #caps: Partial<Record<ProviderName, ProviderCap>>;
  readonly #checkEveryWrites: number;
  readonly #onAlert: ((alert: CapAlert) => void) | undefined;
  readonly #writesSinceCheck = new Map<ProviderName, number>();

  constructor(store: CacheStore, opts: CacheGovernorOptions = {}) {
    this.#store = store;
    this.#caps = opts.caps ?? { lastfm: lastfmCap(80) };
    this.#checkEveryWrites = opts.checkEveryWrites ?? 20;
    this.#onAlert = opts.onAlert;
  }

  capFor(provider: ProviderName): ProviderCap | undefined {
    return this.#caps[provider];
  }

  /**
   * Called after every cache write. Cheap on all but every Nth call.
   *
   * Returns the eviction report when a pass ran, so a caller can assert on it.
   */
  async afterWrite(provider: ProviderName): Promise<EvictionReport | null> {
    if (this.#caps[provider] === undefined) return null;
    const n = (this.#writesSinceCheck.get(provider) ?? 0) + 1;
    if (n < this.#checkEveryWrites) {
      this.#writesSinceCheck.set(provider, n);
      return null;
    }
    this.#writesSinceCheck.set(provider, 0);
    return this.enforce(provider);
  }

  /** Forces a size check now. Also the entry point for a scheduled sweep. */
  async enforce(provider: ProviderName): Promise<EvictionReport | null> {
    const cap = this.#caps[provider];
    if (cap === undefined) return null;

    const size = await this.#store.sizeOf(provider);
    if (size.bytes <= cap.softCapBytes) return null;

    const bytesToFree = size.bytes - cap.lowWaterBytes;
    const report = await this.#store.evictLru(provider, bytesToFree);

    this.#onAlert?.({
      provider,
      bytes: size.bytes,
      softCapBytes: cap.softCapBytes,
      hardCapBytes: cap.hardCapBytes,
      evicted: report.evicted,
      bytesFreed: report.bytesFreed,
    });

    return report;
  }
}
