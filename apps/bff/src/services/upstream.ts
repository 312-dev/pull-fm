/**
 * Construction of every upstream client, and of the cache that fronts them.
 *
 * THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL
 * -----------------------------------------------
 * Nothing outside this module may hold a raw provider client. The bundle
 * exposes `cache`, and the request path reaches a provider only through
 * `CachedUpstream`. That is not tidiness: MusicBrainz permits one request per
 * second across the entire service and iTunes about twenty calls a minute
 * (docs/UPSTREAM-TERMS.md L2), so a handler that fans out to either one
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
 *   iTunes        NO. About 20 calls/min, scope unstated. Same treatment: the request path
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
  type CacheStore,
  type CrosswalkStore,
  type EventsProvider,
  type FetchLike,
  type ProviderEvent,
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
  /**
   * Metrics sink. Called for every provider request, success, failure, retry
   * and short circuit.
   *
   * `ProviderEvent` was designed to be safe for exactly this: it carries the
   * provider, a TEMPLATE path, the attempt number, a status and an error kind,
   * and deliberately no URL, no query string and no headers. That is what makes
   * it usable as a Prometheus label source without the label cardinality
   * becoming a function of user input.
   *
   * Optional and un-awaited by the caller, because a metrics sink must never be
   * able to fail a request. `buildUpstream` wraps it so a throw here cannot
   * escape into the provider path.
   */
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined;
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
  /**
   * The same resolver WITHOUT the Deezer fallback, for the background warmer.
   *
   * `previews.resolve` falls through to Deezer when iTunes misses, which is
   * correct on the playback path and pointless on the warm path: a Deezer URL
   * is signed and expiring, so it is never persisted, so resolving one in a
   * background job spends an upstream call and warms nothing. This shares the
   * SAME `ItunesClient` instance, which is the part that matters - the 15/min
   * quota counter lives on the client, so one budget covers both resolvers
   * rather than the warmer getting a second one of its own.
   *
   * Not a raw provider client, so the rule at the top of this file holds: what
   * escapes this module is still a resolver with a store behind it.
   */
  readonly previewWarmer: PreviewResolver;
  /** Undefined when SeatGeek is unconfigured or switched off. */
  readonly events: EventsProvider | undefined;
  /**
   * The MusicBrainz pacer, exposed for `/metrics` and for nothing else.
   *
   * It was previously an anonymous argument to the client constructor, which
   * meant its `dispatched` / `rejected` / `queueDepth` counters existed and
   * were unreachable. U1 in docs/RUNBOOK-INCIDENT.md ("MusicBrainz egress over
   * 1.0 req/s") is an alert on a number this object already keeps, so the whole
   * gap between "we pace MusicBrainz" and "we can prove we pace MusicBrainz"
   * was one missing reference.
   *
   * Read-only by convention. Nothing outside the metrics collector may call
   * `acquire` or `drainAndReject` on it; the client owns the scheduling.
   */
  readonly musicbrainzLimiter: RateLimiter;
  /**
   * The cache store, exposed so `/metrics` can report per-provider cache SIZE.
   *
   * U3 is the Last.fm 100 MB licence cap and it is the one alert here whose
   * threshold is contractual rather than operational. `CacheGovernor.onAlert`
   * only fires when an eviction happens, so it can report a breach and cannot
   * report the approach to one; `sizeOf` is the only steady-state reading.
   */
  readonly cacheStore: CacheStore;
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

  /**
   * The metrics sink, wrapped so it cannot reach the request path.
   *
   * `ProviderClient` calls `onEvent` inline, on the same tick as the request it
   * describes. An observer that throws would therefore turn a successful
   * upstream call into a failed one, which is the classic way an observability
   * change becomes an outage. Swallowing here is deliberate and is the only
   * place in this file where a bare catch is the right answer: the alternative
   * to a lost metric is a lost response.
   */
  const withEvents =
    opts.onEvent === undefined
      ? {}
      : {
          onEvent: (event: ProviderEvent): void => {
            try {
              opts.onEvent?.(event);
            } catch {
              /* a metrics sink may never fail a request */
            }
          },
        };

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

  const listenbrainz = new ListenBrainzClient({
    killSwitch,
    ...withFetch,
    ...withEvents,
  });

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
          ...withEvents,
        });

  // One limiter, shared. See the header. HELD IN A LOCAL rather than passed
  // anonymously: it is the only object that knows the real MusicBrainz egress
  // rate, and U1 is an alert on that number.
  const musicbrainzLimiter = new RateLimiter({
    minIntervalMs: MUSICBRAINZ_MIN_INTERVAL_MS,
    // A deep queue would let requests wait far past their own timeout for a
    // slot. Rejecting is the honest answer, and the caller degrades.
    maxQueueDepth: 64,
  });

  const musicbrainz = new MusicBrainzClient({
    userAgent: cfg.MUSICBRAINZ_USER_AGENT,
    rateLimiter: musicbrainzLimiter,
    killSwitch,
    ...withFetch,
    ...withEvents,
  });

  const crosswalkStore = new PgCrosswalkStore(queryable);
  const crosswalk = new CrosswalkResolver({
    store: crosswalkStore,
    musicbrainz,
  });

  // One store and one iTunes client, shared by both resolvers below. The client
  // owns the local 15-calls-per-minute quota counter, so sharing the instance is
  // what keeps the warmer and the request path inside ONE Apple budget instead
  // of two. A second ItunesClient would double the spend against a provider
  // that blocks with no appeals process.
  const previewStore = new PgPreviewStore(queryable);
  const itunes = new ItunesClient({ killSwitch, ...withFetch, ...withEvents });

  const previews = new PreviewResolver({
    store: previewStore,
    itunes,
    deezer: new DeezerClient({ killSwitch, ...withFetch, ...withEvents }),
  });

  // No Deezer. See the field comment on UpstreamBundle.previewWarmer.
  const previewWarmer = new PreviewResolver({ store: previewStore, itunes });

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
            ...withEvents,
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
    previewWarmer,
    events,
    musicbrainzLimiter,
    cacheStore,
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
