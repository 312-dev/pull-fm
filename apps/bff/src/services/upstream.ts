/**
 * Construction of every upstream client, and of the cache that fronts them.
 *
 * THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL
 * -----------------------------------------------
 * Nothing outside this module may hold a raw provider client. The bundle
 * exposes `cache`, and the request path reaches a provider only through
 * `CachedUpstream`. That is not tidiness: MusicBrainz permits one request per
 * second across the entire service and iTunes about twenty calls a minute per
 * IP (docs/UPSTREAM-TERMS.md L2), so a handler that fans out to either one
 * synchronously is a remote kill switch that any user can operate.
 *
 * Which providers may be reached synchronously at all, and why, because the
 * answer differs per provider rather than being a blanket rule:
 *
 *   ListenBrainz  YES. 30 requests / 10s PER TOKEN. The budget belongs to the
 *                 user whose request is spending it, so one user cannot starve
 *                 another. Still cached, because a feed render would otherwise
 *                 spend four of a user's thirty on every scroll.
 *   Last.fm       YES, behind a long TTL. ~5/s on ONE app-wide key shared by
 *                 every user, plus a 100 MB cache cap (ToS 4.3.4) that the
 *                 CacheGovernor enforces.
 *   Deezer        YES, and only from the preview route. ~50 requests / 5s per
 *                 IP, and their preview URLs are signed and expire in minutes,
 *                 so re-resolving at the moment of playback is the only correct
 *                 way to serve one (docs/PLAN.md section 1a rule 4).
 *   MusicBrainz   NO. 1 req/s globally per IP. Reachable only from a background
 *                 warm path; the request path uses `peek`, which never calls
 *                 out.
 *   iTunes        NO. ~20 calls/min per IP. Same treatment: the request path
 *                 reads `track_previews`, and filling it is a background job.
 *
 * The MusicBrainz rate limiter is created here, once, and shared. It is a
 * per-IP ceiling, so one limiter per client instance would multiply the rate by
 * the number of instances, which is the exact failure the limiter exists to
 * prevent.
 */

import {
  CacheGovernor,
  CachedUpstream,
  CrosswalkResolver,
  DeezerClient,
  ItunesClient,
  KillSwitch,
  LastfmClient,
  ListenBrainzClient,
  MUSICBRAINZ_MIN_INTERVAL_MS,
  MusicBrainzClient,
  PgCacheStore,
  PgCrosswalkStore,
  PgPreviewStore,
  PreviewResolver,
  RateLimiter,
  SeatGeekClient,
  SeatGeekEventsProvider,
  lastfmCap,
  type CrosswalkStore,
  type EventsProvider,
  type FetchLike,
  type ProviderName,
  type ProviderStatus,
  type Queryable as UpstreamQueryable,
} from "@pull-fm/upstream";

import type { Config } from "../config.js";
import type { Queryable } from "../lib/db.js";

/** Minimal logger surface. Never receives a credential; see .semgrep/pullfm.yml. */
export interface UpstreamLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface UpstreamOptions {
  /**
   * Substituted by the test harness so no suite can reach a real provider.
   * There is no other seam: the clients take a `FetchLike` and nothing else.
   */
  readonly fetchImpl?: FetchLike | undefined;
  readonly log?: UpstreamLogger | undefined;
}

export interface UpstreamBundle {
  readonly cache: CachedUpstream;
  readonly killSwitch: KillSwitch;
  readonly listenbrainz: ListenBrainzClient;
  /** Undefined when no app-wide Last.fm key is configured. */
  readonly lastfm: LastfmClient | undefined;
  readonly musicbrainz: MusicBrainzClient;
  readonly crosswalk: CrosswalkResolver;
  readonly crosswalkStore: CrosswalkStore;
  readonly previews: PreviewResolver;
  /** Undefined when SeatGeek is unconfigured or switched off. */
  readonly events: EventsProvider | undefined;
  /** Coarse per-provider health for `GET /v1/config`. Never internal detail. */
  status(): Record<string, ProviderStatus>;
}

export function buildUpstream(
  cfg: Config,
  db: Queryable,
  opts: UpstreamOptions = {},
): UpstreamBundle {
  const fetchImpl = opts.fetchImpl;
  const withFetch = fetchImpl === undefined ? {} : { fetch: fetchImpl };

  const killSwitch = new KillSwitch();
  const queryable = asUpstreamQueryable(db);
  const cacheStore = new PgCacheStore(queryable);

  // The governor is what keeps the Last.fm layer inside its licence. It samples
  // rather than measuring every write, because `sizeOf` is an aggregate and
  // running it per write would make the cache cost more than the call it saves.
  const governor = new CacheGovernor(cacheStore, {
    caps: { lastfm: lastfmCap(cfg.LASTFM_CACHE_CAP_MB) },
    onAlert: (alert) => {
      opts.log?.warn(
        {
          provider: alert.provider,
          bytes: alert.bytes,
          softCapBytes: alert.softCapBytes,
          evicted: alert.evicted,
        },
        "upstream cache passed its soft cap and was evicted",
      );
    },
  });

  const cache = new CachedUpstream(cacheStore, { governor });

  const listenbrainz = new ListenBrainzClient({ killSwitch, ...withFetch });

  const lastfm =
    cfg.LASTFM_API_KEY === undefined
      ? undefined
      : new LastfmClient({
          apiKey: cfg.LASTFM_API_KEY,
          killSwitch,
          ...(cfg.LASTFM_SHARED_SECRET === undefined
            ? {}
            : { sharedSecret: cfg.LASTFM_SHARED_SECRET }),
          ...withFetch,
        });

  const musicbrainz = new MusicBrainzClient({
    userAgent: cfg.MUSICBRAINZ_USER_AGENT,
    // One limiter, shared. See the header.
    rateLimiter: new RateLimiter({
      minIntervalMs: MUSICBRAINZ_MIN_INTERVAL_MS,
      // A deep queue would let requests wait far past their own timeout for a
      // slot. Rejecting is the honest answer, and the caller degrades.
      maxQueueDepth: 64,
    }),
    killSwitch,
    ...withFetch,
  });

  const crosswalkStore = new PgCrosswalkStore(queryable);
  const crosswalk = new CrosswalkResolver({
    store: crosswalkStore,
    musicbrainz,
  });

  const previews = new PreviewResolver({
    store: new PgPreviewStore(queryable),
    itunes: new ItunesClient({ killSwitch, ...withFetch }),
    deezer: new DeezerClient({ killSwitch, ...withFetch }),
  });

  const events =
    cfg.SEATGEEK_CLIENT_ID === undefined || !cfg.SEATGEEK_ENABLED
      ? undefined
      : new SeatGeekEventsProvider({
          client: new SeatGeekClient({
            clientId: cfg.SEATGEEK_CLIENT_ID,
            ...(cfg.SEATGEEK_CLIENT_SECRET === undefined
              ? {}
              : { clientSecret: cfg.SEATGEEK_CLIENT_SECRET }),
            killSwitch,
            ...withFetch,
          }),
          cache,
        });

  return {
    cache,
    killSwitch,
    listenbrainz,
    lastfm,
    musicbrainz,
    crosswalk,
    crosswalkStore,
    previews,
    events,
    status() {
      // Deliberately coarse. `GET /v1/config` is a reconnaissance endpoint
      // (API9): it says whether a shelf will render, never which providers hold
      // credentials, and never a breaker's internals.
      const disabled: ProviderStatus = "disabled";
      return {
        listenbrainz: listenbrainz.status(),
        lastfm: lastfm?.status() ?? disabled,
        musicbrainz: musicbrainz.status(),
        previews: statusOfPreviews(killSwitch),
        events: events === undefined ? disabled : "ok",
      };
    },
  };
}

/**
 * Adapts the application's pool to the narrower shape the upstream stores need.
 *
 * The two `Queryable` interfaces differ in one way that matters to the
 * compiler and in no way that matters at runtime: the BFF constrains its row
 * type to `pg.QueryResultRow` so every call site gets pg's own typing, while
 * `@pull-fm/upstream` leaves it unconstrained so the package does not depend on
 * `pg` at all. A constrained method is not assignable to an unconstrained one,
 * so the boundary is crossed here, once, deliberately, rather than by loosening
 * either side. `pg` returns plain objects, so the row cast is sound.
 */
function asUpstreamQueryable(db: Queryable): UpstreamQueryable {
  const query = async (
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: never[]; rowCount: number | null }> => {
    const result = await db.query(text, values);
    return { rows: result.rows as never[], rowCount: result.rowCount };
  };
  return { query };
}

/**
 * Previews are reported as one line because that is what a client can act on:
 * the play button either works or it does not, and which of two providers
 * answered is not the client's business.
 */
function statusOfPreviews(killSwitch: KillSwitch): ProviderStatus {
  const enabled: ProviderName[] = ["itunes", "deezer"];
  const live = enabled.filter((p) => killSwitch.isEnabled(p));
  if (live.length === 0) return "disabled";
  return live.length === enabled.length ? "ok" : "degraded";
}
