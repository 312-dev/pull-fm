/**
 * Shared vocabulary for every upstream client.
 *
 * The HTTP types here are deliberately narrower than the DOM/undici ones. A
 * client that only ever sees `status`, `headers.get`, and `text()` can be
 * driven by a three-line fake in a test, and the load suite's mock upstreams
 * (load/mock-upstreams) exist precisely so no test ever reaches a real
 * provider. Real `fetch` is structurally assignable to `FetchLike`.
 */

/**
 * Providers that may appear in `upstream_cache.provider`.
 *
 * NOTE: the schema's `upstream_cache_provider_chk` must list every value here
 * or a cache write fails at runtime. `seatgeek` was added after 0001_initial
 * and requires migration 0003_seatgeek_cache_provider.sql, which was renumbered
 * from 0002 when it collided with 0002_api_tokens.sql.
 */
export type ProviderName =
  | "listenbrainz"
  | "lastfm"
  | "musicbrainz"
  | "itunes"
  | "deezer"
  | "reccobeats"
  | "seatgeek";

/** What `GET /v1/config` reports to the client so it can hide a shelf. */
export type ProviderStatus = "ok" | "degraded" | "disabled";

export interface HttpHeadersLike {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeadersLike;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponse>;

/**
 * Injectable time and randomness.
 *
 * Retry jitter and circuit-breaker recovery are both time- and
 * random-dependent, and a test that asserts on either while using the real
 * clock is a test that fails on a loaded CI runner.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Uniform in [0, 1). */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  random: () => Math.random(),
};

/** Adapts the global `fetch` to `FetchLike` without leaking DOM types outward. */
export const systemFetch: FetchLike = (url, init) => fetch(url, init);

/** Every client exposes this much, so the BFF can build the provider health map. */
export interface Provider {
  readonly name: ProviderName;
  status(): ProviderStatus;
}
