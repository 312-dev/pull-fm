/**
 * What `/metrics` exposes, and why each series is on the list.
 *
 * ---------------------------------------------------------------------------
 * THE SELECTION RULE
 *
 * A metric earns its place here by being the evidence for a NAMED ALERT in
 * docs/RUNBOOK-INCIDENT.md section 6, or by being the evidence for a NAMED GATE
 * in docs/PLAN.md. Nothing is exported because it is interesting. The reason is
 * not tidiness: a scrape full of series nobody alerts on is a scrape nobody
 * reads, and the dashboard equivalent of a muted channel.
 *
 * The mapping, explicitly, so a future reader can delete anything that stops
 * being referenced:
 *
 *   A2  readyz dependency fail        pullfm_dependency_up{dependency}
 *   A6  p95 latency over 800ms        pullfm_http_request_duration_seconds
 *   S3  quota Redis unreachable       pullfm_fail_closed_total{store}
 *   U1  MusicBrainz egress over 1/s   pullfm_musicbrainz_pacer_*
 *   U2  iTunes over 20/min            pullfm_upstream_requests_total{provider="itunes"}
 *   U3  Last.fm cache over 80 MB      pullfm_cache_bytes{provider="lastfm"}
 *   U4  breaker open over 15 min      pullfm_upstream_provider_status + _status_age_seconds
 *   Gate 2  warm cache hit over 90%   pullfm_cache_hit_ratio, pullfm_crosswalk_warm_hit_ratio
 *   Gate 6  maintenance flips         pullfm_maintenance_mode
 *   Gate 7  no pool exhaustion        pullfm_db_pool_*
 *
 * ---------------------------------------------------------------------------
 * WHY MOST OF THIS IS A COLLECTOR RATHER THAN AN INCREMENT
 *
 * Almost every number here is already counted by the object that owns the
 * behaviour: `CachedUpstream.stats()`, `CrosswalkResolver.stats()`,
 * `RateLimiter.stats`, `pg.Pool`'s counts. Counting the same events a second
 * time in this file would produce two numbers that disagree after any restart
 * or any code path that bypasses the wrapper, and the disagreement would only
 * ever be discovered during an incident. Mirroring the owner's counter is the
 * boring correct answer.
 *
 * The exceptions - HTTP requests, HTTP duration, quota-limiter failures,
 * provider events - are counted here because nobody else counts them at all.
 */

import type { ProviderEvent } from "@pull-fm/upstream";

import type { Registry } from "./metrics.js";

/** The seven providers, fixed at compile time so the label set cannot grow. */
const PROVIDERS = [
  "listenbrainz",
  "lastfm",
  "musicbrainz",
  "itunes",
  "deezer",
  "seatgeek",
  "reccobeats",
] as const;

/**
 * Providers whose cached bytes are worth a gauge.
 *
 * Only Last.fm, and only because ToS 4.3.4 caps it at 100 MB and exceeding that
 * is a licence breach rather than a disk problem. `sizeOf` is a database
 * aggregate over every row of a provider's cache, so scraping it for all seven
 * would turn a metrics poll into the most expensive query the service runs.
 */
const SIZED_PROVIDERS = ["lastfm"] as const;

/** How often the expensive cache-size aggregate may actually run. */
const CACHE_SIZE_MIN_INTERVAL_MS = 300_000;

export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
  readonly max: number;
}

export interface CacheStatsLike {
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly poisoned: number;
  readonly coalesced: number;
  readonly hitRate: number;
}

export interface MetricsSources {
  readonly buildSha: string;
  readonly deployEnv: string;
  /** True while the service is deliberately refusing traffic. */
  readonly maintenance: () => boolean;
  readonly poolStats: () => PoolStats;
  readonly cacheStats: (provider: string) => CacheStatsLike;
  readonly cacheCoalescing: () => { started: number; joined: number };
  readonly crosswalkStats: () => {
    exact: number;
    fuzzy: number;
    remote: number;
    unresolved: number;
    warmHitRate: number;
  };
  readonly pacerStats: () => {
    dispatched: number;
    rejected: number;
    queued: number;
    queueDepth: number;
  };
  readonly providerStatus: () => Record<string, string>;
  /** Resolves per-provider cached bytes. Expensive; called on a long interval. */
  readonly cacheBytes: (provider: string) => Promise<number>;
}

const STATUS_CODE: Record<string, number> = { ok: 0, degraded: 1, disabled: 2 };

/**
 * Records one upstream provider event.
 *
 * `short_circuit` is the row that matters most and the one most likely to be
 * skimmed past. It means a request was REFUSED BEFORE IT LEFT THE PROCESS, for
 * one of three reasons that look identical from the outside and are completely
 * different operationally:
 *
 *   circuit_open      the provider is failing and we stopped asking. U4.
 *   quota_exhausted   WE ran out of budget. This is the rate-limit exhaustion
 *                     signal, and it is the difference between "the provider is
 *                     down" and "we are about to get our API access revoked".
 *   disabled          an operator pulled the kill switch. Expected, not a fault.
 *
 * Collapsing those three into one counter would make the most product-ending
 * condition in docs/RUNBOOK-INCIDENT.md (SEV-3, upstream licence) indexed under
 * the same label as a deliberate switch flip.
 */
export function recordProviderEvent(
  registry: Registry,
  event: ProviderEvent,
): void {
  const provider = event.provider;

  switch (event.kind) {
    case "request":
      registry.counter(
        "pullfm_upstream_requests_total",
        "Upstream requests that left the process, by provider.",
        { provider },
      );
      break;
    case "success":
      registry.counter(
        "pullfm_upstream_responses_total",
        "Upstream responses, by provider and outcome.",
        { provider, outcome: "success" },
      );
      if (event.durationMs !== undefined) {
        registry.observe(
          "pullfm_upstream_duration_seconds",
          "Upstream call duration in seconds, by provider.",
          { provider },
          event.durationMs / 1000,
        );
      }
      break;
    case "failure":
      registry.counter(
        "pullfm_upstream_responses_total",
        "Upstream responses, by provider and outcome.",
        { provider, outcome: "failure" },
      );
      registry.counter(
        "pullfm_upstream_failures_total",
        "Upstream failures, by provider and error kind.",
        { provider, kind: event.errorKind ?? "unknown" },
      );
      break;
    case "retry":
      registry.counter(
        "pullfm_upstream_retries_total",
        "Upstream retries, by provider.",
        { provider },
      );
      break;
    case "short_circuit":
      registry.counter(
        "pullfm_upstream_short_circuits_total",
        "Upstream calls refused before leaving the process, by reason. reason=quota_exhausted is the upstream-budget alarm (U2); reason=circuit_open is the breaker (U4).",
        { provider, reason: event.errorKind ?? "unknown" },
      );
      break;
  }
}

/**
 * Installs every collector that reads a live source at scrape time.
 *
 * Called once, at wiring. Everything it registers is a closure over the source
 * object, so a scrape reports the CURRENT value rather than the last value
 * anything happened to write. A gauge updated only on change is worse than no
 * gauge: it looks alive while reporting history.
 */
export function installCollectors(
  registry: Registry,
  sources: MetricsSources,
): void {
  const bootedAt = Date.now();

  // Per-provider status, plus how long it has been in that status. U4 is "open
  // for over 15 minutes", so the duration is the alertable half and the state
  // alone cannot answer it.
  const statusSince = new Map<string, { status: string; at: number }>();

  // The expensive one, rate limited by wall clock rather than by scrape count,
  // so a scraper configured at 5s cannot turn a licence gauge into a load test
  // against our own database.
  let cacheBytesAt = 0;
  const cacheBytes = new Map<string, number>();

  registry.addCollector(() => {
    registry.gauge(
      "pullfm_build_info",
      "Build information. Always 1; the labels are the payload.",
      { version: sources.buildSha, env: sources.deployEnv },
      1,
    );
    registry.gauge(
      "pullfm_process_uptime_seconds",
      "Seconds since this process started serving.",
      {},
      Math.floor((Date.now() - bootedAt) / 1000),
    );

    // Gate 6 is a claim about this flag, so the flag has to be externally
    // readable. Without it, "maintenance mode was on for four minutes" is a
    // statement nobody can check afterwards.
    registry.gauge(
      "pullfm_maintenance_mode",
      "1 while the service is deliberately refusing application traffic.",
      {},
      sources.maintenance() ? 1 : 0,
    );

    // Pool saturation. `waiting` is the number that matters and the one people
    // forget: total and idle can both look healthy while every checkout is
    // queueing. Neon's transaction pooler sits in front of this, so a saturated
    // LOCAL pool is our own concurrency limit rather than the database's.
    const pool = sources.poolStats();
    registry.gauge(
      "pullfm_db_pool_connections",
      "Postgres pool connections held by this process, by state.",
      { state: "total" },
      pool.total,
    );
    registry.gauge(
      "pullfm_db_pool_connections",
      "Postgres pool connections held by this process, by state.",
      { state: "idle" },
      pool.idle,
    );
    registry.gauge(
      "pullfm_db_pool_waiting",
      "Callers queued for a Postgres connection. Sustained non-zero is saturation.",
      {},
      pool.waiting,
    );
    registry.gauge(
      "pullfm_db_pool_max",
      "Configured DATABASE_POOL_MAX, so saturation is computable from the scrape alone.",
      {},
      pool.max,
    );

    for (const provider of PROVIDERS) {
      const s = sources.cacheStats(provider);
      registry.counterAbsolute(
        "pullfm_cache_hits_total",
        "Cache hits, mirrored from CachedUpstream.",
        { provider },
        s.hits,
      );
      registry.counterAbsolute(
        "pullfm_cache_misses_total",
        "Cache misses, mirrored from CachedUpstream.",
        { provider },
        s.misses,
      );
      registry.counterAbsolute(
        "pullfm_cache_stale_total",
        "Stale reads served because the provider failed.",
        { provider },
        s.stale,
      );
      registry.counterAbsolute(
        "pullfm_cache_poisoned_total",
        "Cached payloads that no longer parse. A schema drift signal.",
        { provider },
        s.poisoned,
      );
      // Gate 2's warm-cache requirement is >=90%, so this is the series the
      // gate is measured on. Reported as -1 rather than 0 when nothing has been
      // looked up, because a 0% hit rate and no traffic must not be the same
      // reading on a dashboard whose whole job is to distinguish them.
      registry.gauge(
        "pullfm_cache_hit_ratio",
        "Cache hit ratio in [0,1], or -1 when nothing has been looked up yet.",
        { provider },
        s.hits + s.misses === 0 ? -1 : s.hitRate,
      );
    }

    const coalescing = sources.cacheCoalescing();
    registry.counterAbsolute(
      "pullfm_cache_fills_started_total",
      "Cache fills that actually called a provider.",
      {},
      coalescing.started,
    );
    registry.counterAbsolute(
      "pullfm_cache_fills_joined_total",
      "Callers that joined an in-flight fill instead of making a second call.",
      {},
      coalescing.joined,
    );

    const xw = sources.crosswalkStats();
    for (const [kind, value] of [
      ["exact", xw.exact],
      ["fuzzy", xw.fuzzy],
      ["remote", xw.remote],
      ["unresolved", xw.unresolved],
    ] as const) {
      registry.counterAbsolute(
        "pullfm_crosswalk_resolutions_total",
        "Crosswalk resolutions by how they were resolved.",
        { kind },
        value,
      );
    }
    registry.gauge(
      "pullfm_crosswalk_warm_hit_ratio",
      "Share of crosswalk resolutions served without a remote call. Gate 2.",
      {},
      xw.warmHitRate,
    );

    // U1. MusicBrainz permits one request per second across the whole service,
    // and it is the provider with no second supplier: losing it ends the
    // product. `queued` and `rejected` are the pressure signals; `dispatched`
    // is what a rate is computed from.
    const pacer = sources.pacerStats();
    registry.counterAbsolute(
      "pullfm_musicbrainz_pacer_dispatched_total",
      "Requests released by the MusicBrainz pacer. rate() of this is our egress.",
      {},
      pacer.dispatched,
    );
    registry.counterAbsolute(
      "pullfm_musicbrainz_pacer_rejected_total",
      "Requests refused because the pacer queue was full.",
      {},
      pacer.rejected,
    );
    registry.gauge(
      "pullfm_musicbrainz_pacer_queue_depth",
      "Requests waiting for a MusicBrainz slot right now.",
      {},
      pacer.queueDepth,
    );

    const now = Date.now();
    const statuses = sources.providerStatus();
    for (const [provider, status] of Object.entries(statuses)) {
      registry.gauge(
        "pullfm_upstream_provider_status",
        "0 ok, 1 degraded (breaker not closed), 2 disabled.",
        { provider },
        STATUS_CODE[status] ?? 1,
      );
      if (statusSince.get(provider)?.status !== status) {
        statusSince.set(provider, { status, at: now });
      }
      registry.gauge(
        "pullfm_upstream_provider_status_age_seconds",
        "Seconds the provider has held its current status. U4 alerts on degraded for over 900.",
        { provider },
        Math.floor((now - (statusSince.get(provider)?.at ?? now)) / 1000),
      );
    }
  });

  // Cache bytes is deliberately a SEPARATE collector and deliberately async.
  // It kicks off a refresh and returns the last known value, so a slow database
  // delays the number rather than the scrape. A metrics endpoint that can block
  // is a metrics endpoint that stops answering during exactly the incident it
  // was added for.
  registry.addCollector(() => {
    const now = Date.now();
    for (const provider of SIZED_PROVIDERS) {
      registry.gauge(
        "pullfm_cache_bytes",
        "Cached bytes per provider. Last.fm is capped at 100 MB by ToS 4.3.4 (U3).",
        { provider },
        cacheBytes.get(provider) ?? -1,
      );
    }
    if (now - cacheBytesAt < CACHE_SIZE_MIN_INTERVAL_MS) return;
    cacheBytesAt = now;
    for (const provider of SIZED_PROVIDERS) {
      void sources
        .cacheBytes(provider)
        .then((bytes) => {
          cacheBytes.set(provider, bytes);
        })
        .catch(() => {
          /* a failed size read leaves the previous value, which is honest */
        });
    }
  });
}
