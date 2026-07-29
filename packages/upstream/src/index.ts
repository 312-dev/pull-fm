/**
 * @pull-fm/upstream - every third-party provider, behind one set of guarantees.
 *
 * Each client composes timeout, retry with jitter, a circuit breaker, a local
 * quota counter, and a runtime kill switch. Cache-first is the architecture
 * (docs/PLAN.md section 3), not an optimisation: MusicBrainz permits 1 req/s
 * globally and iTunes about 20 calls/min, so nothing here is safe to call
 * synchronously on a request path without a cache in front of it.
 *
 * The licence constraints in docs/UPSTREAM-TERMS.md are enforced in code, not
 * by convention: the Last.fm 100 MB cache cap (CacheGovernor), the ban on
 * persisting Deezer preview URLs (PreviewStore), the MusicBrainz User-Agent and
 * pacing (MusicBrainzClient), and no affiliate parameters on any outbound link
 * (sanitizeOutboundUrl).
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./json.js";
export * from "./normalize.js";
export * from "./rate-limiter.js";
export * from "./circuit-breaker.js";
export * from "./quota.js";
export * from "./kill-switch.js";
export * from "./single-flight.js";
export * from "./provider-client.js";

export * from "./cache/store.js";
export * from "./cache/memory-store.js";
export * from "./cache/pg-store.js";
export * from "./cache/governor.js";
export * from "./cache/cache-first.js";

export * from "./musicbrainz/client.js";
export * from "./listenbrainz/client.js";
export * from "./lastfm/client.js";
export * from "./itunes/client.js";
export * from "./deezer/client.js";
export * from "./reccobeats/client.js";
export * from "./seatgeek/client.js";

export * from "./events/types.js";
export * from "./events/seatgeek-provider.js";

export * from "./crosswalk/store.js";
export * from "./crosswalk/pg-store.js";
export * from "./crosswalk/resolver.js";

export * from "./preview/resolver.js";
export * from "./preview/pg-store.js";
