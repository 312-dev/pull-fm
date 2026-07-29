/**
 * Preview resolution: recording MBID -> a playable 30-second preview URL.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * iTunes preview URLs are unsigned, have no expiry, and are hotlinkable, so
 * they are persisted and reused forever. Deezer preview URLs are signed with an
 * expiry (`?hdnea=exp=...~hmac=...`) and are NEVER persisted - not to
 * `track_previews`, not to `upstream_cache`, not anywhere. A stored Deezer URL
 * 403s minutes later, which is a bug that passes every test written against a
 * warm cache and then fails for users.
 *
 * `PreviewStore.put` rejects any provider other than iTunes, which makes the
 * rule structural rather than a comment. The schema's
 * `track_previews_deezer_expiry_chk` is the third line of defence.
 *
 * ALSO NOT DONE HERE: downloading preview audio. Apple's terms permit previews
 * to be "streamed only, and not downloaded, saved, cached, or synchronized",
 * which independently forbids local audio-feature extraction over previews.
 *
 * QUOTA REALITY: iTunes allows ~20 calls/min per IP. At any meaningful traffic
 * this resolver must run as a background job over a wishlist or a feed, never
 * synchronously inside a request. `resolveCached` is the request-path entry
 * point and never calls an upstream.
 */

import { isUpstreamError } from "../errors.js";
import type { DeezerClient, DeezerPreview } from "../deezer/client.js";
import { DEEZER_ATTRIBUTION } from "../deezer/client.js";
import type { ItunesClient } from "../itunes/client.js";
import { ITUNES_ATTRIBUTION } from "../itunes/client.js";

export type PreviewProvider = "itunes" | "deezer";

export interface ResolvedPreview {
  readonly recordingMbid: string;
  readonly provider: PreviewProvider;
  readonly url: string;
  readonly durationMs: number | undefined;
  /** null for iTunes (stable). Always set for Deezer (signed and expiring). */
  readonly expiresAt: number | null;
  /** False for Deezer. The caller must not persist it. */
  readonly cacheable: boolean;
  readonly attribution: string;
}

export interface StoredPreview {
  readonly recordingMbid: string;
  readonly provider: "itunes";
  readonly url: string;
  readonly durationMs: number | undefined;
  readonly resolvedAt: number;
}

/**
 * A row offered for storage.
 *
 * `provider` is the WIDE union rather than the literal "itunes" on purpose: a
 * type that made a Deezer row unrepresentable would push the check to compile
 * time only, and the callers that matter (a background job, a future provider)
 * are exactly the ones that will pass a runtime value. The store rejects it.
 */
export interface PreviewWrite {
  readonly recordingMbid: string;
  readonly provider: PreviewProvider;
  readonly url: string;
  readonly durationMs: number | undefined;
}

export interface PreviewStore {
  get(recordingMbid: string): Promise<StoredPreview | null>;
  /** Accepts iTunes rows only. Implementations MUST reject Deezer. */
  put(row: PreviewWrite): Promise<void>;
}

export class DeezerPreviewNotCacheableError extends Error {
  public override readonly name = "DeezerPreviewNotCacheableError";
  constructor() {
    super(
      "refusing to persist a Deezer preview URL: it is signed and expires (docs/PLAN.md section 1a). Re-resolve immediately before playback.",
    );
  }
}

export class MemoryPreviewStore implements PreviewStore {
  readonly #rows = new Map<string, StoredPreview>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  get(recordingMbid: string): Promise<StoredPreview | null> {
    return Promise.resolve(this.#rows.get(recordingMbid) ?? null);
  }

  put(row: PreviewWrite): Promise<void> {
    // Rejects rather than throws: the method returns a Promise, so a caller
    // using .catch() would otherwise never see this.
    if (row.provider !== "itunes") {
      return Promise.reject(new DeezerPreviewNotCacheableError());
    }
    this.#rows.set(row.recordingMbid, {
      ...row,
      provider: "itunes",
      resolvedAt: this.now(),
    });
    return Promise.resolve();
  }

  get size(): number {
    return this.#rows.size;
  }
}

export interface PreviewResolverOptions {
  readonly store: PreviewStore;
  readonly itunes?: ItunesClient | undefined;
  readonly deezer?: DeezerClient | undefined;
  readonly now?: () => number;
}

export interface TrackIdentity {
  readonly recordingMbid: string;
  readonly artistName: string;
  readonly title: string;
}

export class PreviewResolver {
  readonly #store: PreviewStore;
  readonly #itunes: ItunesClient | undefined;
  readonly #deezer: DeezerClient | undefined;
  readonly #now: () => number;

  constructor(opts: PreviewResolverOptions) {
    this.#store = opts.store;
    this.#itunes = opts.itunes;
    this.#deezer = opts.deezer;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Request-path entry point. Never calls an upstream. */
  async resolveCached(recordingMbid: string): Promise<ResolvedPreview | null> {
    const row = await this.#store.get(recordingMbid);
    if (row === null) return null;
    return {
      recordingMbid: row.recordingMbid,
      provider: "itunes",
      url: row.url,
      durationMs: row.durationMs,
      expiresAt: null,
      cacheable: true,
      attribution: ITUNES_ATTRIBUTION,
    };
  }

  /**
   * Full resolution. iTunes first because its URL is persistable; Deezer only
   * as a live fallback whose result is deliberately thrown away after use.
   *
   * Belongs in a background job, not a request handler.
   */
  async resolve(track: TrackIdentity): Promise<ResolvedPreview | null> {
    const cached = await this.resolveCached(track.recordingMbid);
    if (cached !== null) return cached;

    if (this.#itunes !== undefined) {
      try {
        const preview = await this.#itunes.resolvePreview(
          track.artistName,
          track.title,
        );
        if (preview !== null) {
          await this.#store.put({
            recordingMbid: track.recordingMbid,
            provider: "itunes",
            url: preview.previewUrl,
            durationMs: preview.durationMs,
          });
          return {
            recordingMbid: track.recordingMbid,
            provider: "itunes",
            url: preview.previewUrl,
            durationMs: preview.durationMs,
            expiresAt: null,
            cacheable: true,
            attribution: ITUNES_ATTRIBUTION,
          };
        }
      } catch (err) {
        // iTunes exhaustion is expected at ~20 calls/min; fall through to
        // Deezer rather than failing, but never let a real bug pass silently.
        if (!isUpstreamError(err)) throw err;
      }
    }

    if (this.#deezer !== undefined) {
      try {
        const preview = await this.#deezer.resolvePreview(
          track.artistName,
          track.title,
        );
        if (preview !== null)
          return this.#fromDeezer(track.recordingMbid, preview);
      } catch (err) {
        if (!isUpstreamError(err)) throw err;
      }
    }

    return null;
  }

  /**
   * Re-resolves a Deezer preview immediately before playback.
   *
   * This is the only correct way to serve a Deezer URL: it is valid for seconds
   * to minutes, so the resolution has to happen at the moment of use.
   */
  async refreshForPlayback(
    track: TrackIdentity,
  ): Promise<ResolvedPreview | null> {
    const cached = await this.resolveCached(track.recordingMbid);
    if (cached !== null) return cached;
    if (this.#deezer === undefined) return null;
    const preview = await this.#deezer.resolvePreview(
      track.artistName,
      track.title,
    );
    return preview === null
      ? null
      : this.#fromDeezer(track.recordingMbid, preview);
  }

  #fromDeezer(
    recordingMbid: string,
    preview: DeezerPreview,
  ): ResolvedPreview | null {
    // A URL that has already expired by the time we parsed it is not a preview,
    // it is a future 403. Report nothing rather than something broken.
    if (preview.expiresAt <= this.#now()) return null;
    return {
      recordingMbid,
      provider: "deezer",
      url: preview.previewUrl,
      durationMs: preview.durationMs,
      expiresAt: preview.expiresAt,
      cacheable: false,
      attribution: DEEZER_ATTRIBUTION,
    };
  }
}
