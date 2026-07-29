/**
 * Preview resolution: recording MBID -> a playable 30-second preview URL.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 * -------------------------------------
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
 * THE SECOND RULE: NO STORE LINK, NO iTUNES PREVIEW.
 * --------------------------------------------------
 * Apple's grant is one paragraph with SIX CONJUNCTIVE conditions
 * (docs/compliance/apple-itunes-terms-review.md). Condition (ii), verbatim,
 * requires the preview to be "proximate to a 'Download on iTunes' or 'Download
 * on App Store' badge (as approved by Apple) that acts as a link directly to
 * pages within iTunes where consumers can purchase the promoted content."
 *
 * The link is per TRACK. A badge pointing at Apple's homepage does not satisfy
 * "directly to pages where consumers can purchase the promoted content", so a
 * provider-level attribution string cannot express this obligation and a
 * `{ source, text }` pair certainly cannot. `PreviewAttribution` therefore
 * carries a `badge` with the item's own `linkUrl`, and an iTunes preview
 * WITHOUT one is not returned at all. Partial compliance with a conjunctive
 * licence is non-compliance, and a client that receives a preview it cannot
 * legally render is a client that will render it anyway.
 *
 * ALSO NOT DONE HERE: downloading preview audio. Condition (iv) permits
 * previews to be "streamed only, and not downloaded, saved, cached, or
 * synchronized", which independently forbids local audio-feature extraction
 * over previews.
 *
 * RETENTION IS BOUNDED. Apple may "remove any Promo Content immediately upon
 * request", so a resolved URL kept forever with no revalidation would serve a
 * withdrawn track indefinitely from our own table. Rows carry a
 * `revalidateAfter` and a stale one is treated as absent.
 *
 * QUOTA REALITY: Apple documents "approximately 20 calls per minute" and states
 * NO SCOPE for it - not per key, not per IP, not per application. This
 * repository used to assert "per IP" as though it were Apple's word; it is not.
 * Blocks are in practice keyed to egress IP reputation and a service on shared
 * cloud egress has been blocked at roughly nine calls a minute, well under the
 * stated figure, so the 15/min budget is necessary and not sufficient. At any
 * meaningful traffic this resolver must run as a background job over a wishlist
 * or a feed, never synchronously inside a request. `resolveCached` is the
 * request-path entry point and never calls an upstream.
 */

import { isUpstreamError } from "../errors.js";
import type { DeezerClient, DeezerPreview } from "../deezer/client.js";
import { DEEZER_ATTRIBUTION } from "../deezer/client.js";
import type { ItunesClient } from "../itunes/client.js";
import { ITUNES_ATTRIBUTION } from "../itunes/client.js";

export type PreviewProvider = "itunes" | "deezer";

/**
 * The store badge a licence conditions playback on.
 *
 * NOT the same obligation as SeatGeek's logo, which is why this is a separate
 * type rather than a reuse of `ProviderAttribution`. SeatGeek require their
 * logo linked to their HOMEPAGE, anywhere their material appears. Apple require
 * an approved store badge linked to the page where THIS TRACK can be purchased,
 * positioned next to the preview control. A shape that expressed one would
 * silently under-describe the other.
 */
export interface StoreBadge {
  /**
   * True when the licence conditions playback on rendering the badge. A client
   * that plays the preview without it is outside the grant, not merely
   * impolite.
   */
  readonly required: boolean;
  /**
   * The badge variants Apple actually ships.
   *
   * The clause names a "Download on iTunes" badge. That artwork no longer
   * exists: the shipped variants are "Buy on", "Get it on" and "Pre-order on"
   * (docs/compliance/apple-itunes-terms-review.md A8). Listing what exists is
   * more useful to a renderer than quoting a clause that names artwork nobody
   * can obtain.
   */
  readonly variants: readonly string[];
  /** Where the approved artwork and the guidelines governing it live. */
  readonly assetPage: string;
  /**
   * The PER-ITEM link. Condition (ii) requires the badge to act as "a link
   * directly to pages within iTunes where consumers can purchase the promoted
   * content", so a provider homepage does not satisfy it.
   */
  readonly linkUrl: string;
  /** Condition (ii) again: "proximate to". Next to the play control. */
  readonly placement: "proximate-to-preview";
  /**
   * Apple's marketing guidelines require their badge FIRST where several
   * services' badges appear in one layout. That also happens to be our best
   * answer on condition (vi), which forbids using Promo Content to promote
   * other goods or services: our Qobuz and Bandcamp links sit after Apple's.
   */
  readonly ordering: "first";
}

/**
 * Attribution travelling with one preview.
 *
 * A string was enough while the only obligation was condition (iii)'s exact
 * phrase. It is not enough for condition (ii), which needs a link the client
 * has to render, so this is a structure and the badge is optional per provider:
 * Deezer impose no such requirement and forcing one on them would be inventing
 * an obligation.
 */
export interface PreviewAttribution {
  readonly source: PreviewProvider;
  /** Condition (iii): the exact phrase "provided courtesy of iTunes". */
  readonly text: string;
  /** Present only where a licence conditions playback on a store badge. */
  readonly badge?: StoreBadge;
}

export interface ResolvedPreview {
  readonly recordingMbid: string;
  readonly provider: PreviewProvider;
  readonly url: string;
  readonly durationMs: number | undefined;
  /** null for iTunes (stable). Always set for Deezer (signed and expiring). */
  readonly expiresAt: number | null;
  /** False for Deezer. The caller must not persist it. */
  readonly cacheable: boolean;
  readonly attribution: PreviewAttribution;
}

export interface StoredPreview {
  readonly recordingMbid: string;
  readonly provider: "itunes";
  readonly url: string;
  readonly durationMs: number | undefined;
  /**
   * `trackViewUrl`. Nullable only because rows written before the store URL
   * existed have none; such a row is not served, it is re-resolved.
   */
  readonly storeUrl: string | null;
  readonly resolvedAt: number;
  /** Epoch ms after which the row must be re-resolved rather than served. */
  readonly revalidateAfter: number;
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
  /** Apple's `trackViewUrl`. Required for a row to be servable; see above. */
  readonly storeUrl: string | null;
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

/** Thirty days. Bounds Apple's recall right; see the header. */
export const PREVIEW_REVALIDATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

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
      revalidateAfter: this.now() + PREVIEW_REVALIDATE_AFTER_MS,
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

  /**
   * Request-path entry point. Never calls an upstream.
   *
   * Returns null in three cases, and only one of them is "we have nothing":
   *
   *   no row              never resolved.
   *   no store URL        resolved before condition (ii) was implemented, or by
   *                       a response Apple returned without a `trackViewUrl`.
   *                       Serving it would hand a client a preview it cannot
   *                       legally render, so it is treated as absent and the
   *                       background resolver refreshes it.
   *   past revalidation   Apple may withdraw content at any time and we would
   *                       otherwise serve it forever from our own table.
   *
   * All three are indistinguishable to the caller ON PURPOSE: every one of them
   * means "ask the resolver", and a caller that could tell them apart would
   * eventually special-case one of them into serving the row anyway.
   */
  async resolveCached(recordingMbid: string): Promise<ResolvedPreview | null> {
    const row = await this.#store.get(recordingMbid);
    if (row === null) return null;
    if (row.storeUrl === null) return null;
    if (row.revalidateAfter <= this.#now()) return null;
    return {
      recordingMbid: row.recordingMbid,
      provider: "itunes",
      url: row.url,
      durationMs: row.durationMs,
      expiresAt: null,
      cacheable: true,
      attribution: itunesAttribution(row.storeUrl),
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
        // A preview with no store link cannot satisfy condition (ii), so it is
        // not persisted and not returned. Falling through to Deezer is the
        // right outcome: a playable preview under a licence we do satisfy beats
        // an unplayable one under a licence we do not.
        const storeUrl =
          preview === null ? null : appleStoreUrl(preview.trackViewUrl);
        if (preview !== null && storeUrl !== null) {
          await this.#store.put({
            recordingMbid: track.recordingMbid,
            provider: "itunes",
            url: preview.previewUrl,
            durationMs: preview.durationMs,
            storeUrl,
          });
          return {
            recordingMbid: track.recordingMbid,
            provider: "itunes",
            url: preview.previewUrl,
            durationMs: preview.durationMs,
            expiresAt: null,
            cacheable: true,
            attribution: itunesAttribution(storeUrl),
          };
        }
      } catch (err) {
        // iTunes exhaustion is expected at about 20 calls/min; fall through to
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
      // No badge: Deezer impose no such requirement, and inventing one would
      // be as wrong as omitting Apple's.
      attribution: { source: "deezer", text: DEEZER_ATTRIBUTION },
    };
  }
}

/**
 * Apple's badge, filled in with one track's own store link.
 *
 * `required: true` is not a suggestion the client may weigh. Apple's grant is
 * conjunctive: a preview rendered without the badge is outside the licence
 * entirely, whatever else the client got right.
 */
export function itunesAttribution(storeUrl: string): PreviewAttribution {
  return {
    source: "itunes",
    text: ITUNES_ATTRIBUTION,
    badge: {
      required: true,
      // The clause names a "Download on iTunes" badge and Apple no longer ship
      // that artwork. These are the variants that exist.
      variants: ["Buy on", "Get it on", "Pre-order on"],
      assetPage:
        "https://www.apple.com/itunes/marketing-on-music/identity-guidelines.html",
      linkUrl: storeUrl,
      placement: "proximate-to-preview",
      ordering: "first",
    },
  };
}

/**
 * Validates a store link before it can become a badge target.
 *
 * Any Apple host, not a pinned one: `trackViewUrl` now answers with
 * music.apple.com rather than an itunes.apple.com host
 * (docs/compliance/apple-itunes-terms-review.md A9), and a check that pinned
 * the old domain would reject every real response. A badge pointing somewhere
 * that is not Apple's store is worse than no badge - it is a licence breach
 * dressed as compliance - so anything else returns null and the preview is
 * dropped.
 */
export function appleStoreUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "apple.com" && !host.endsWith(".apple.com")) return null;
  return url.toString();
}
