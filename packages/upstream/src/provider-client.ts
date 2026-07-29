/**
 * The one HTTP path every upstream client uses.
 *
 * Five protections compose here, in this order, and the order is the design:
 *
 *   1. kill switch    - a disabled provider costs nothing, not even a counter
 *   2. circuit breaker - a sick provider fails instantly instead of holding
 *                        connections for the full timeout on every request
 *   3. quota counter   - a spent budget is refused locally, so we do not spend
 *                        an upstream call to be told we are out of calls
 *   4. rate limiter    - process-wide pacing (MusicBrainz 1 req/s is per IP)
 *   5. timeout + retry - bounded attempts with full jitter
 *
 * Checking the switch first and the limiter last means a request that will be
 * refused never occupies a rate-limit slot that a viable request could have had.
 *
 * CREDENTIALS AND LOGS
 * --------------------
 * Nothing in this file logs a URL. Several providers (SeatGeek, Last.fm) carry
 * credentials in the query string, so a single `logger.error({ url })` would
 * leak a key into the log aggregator forever. Events carry `path` only, which
 * `redactUrl` produces, and errors are built from method + path + status.
 */

import { CircuitBreaker } from "./circuit-breaker.js";
import type { BreakerPolicy } from "./circuit-breaker.js";
import { UpstreamError } from "./errors.js";
import { parseJson } from "./json.js";
import { KillSwitch } from "./kill-switch.js";
import { QuotaCounter } from "./quota.js";
import type { QuotaPolicy } from "./quota.js";
import { QueueOverflowError, RateLimiter } from "./rate-limiter.js";
import type {
  Clock,
  FetchLike,
  HttpHeadersLike,
  HttpResponse,
  ProviderName,
  ProviderStatus,
} from "./types.js";
import { systemClock, systemFetch } from "./types.js";
import { statusOf } from "./kill-switch.js";

export interface RetryPolicy {
  /** Total attempts including the first. 3 means one call plus two retries. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * Longest `Retry-After` we will actually wait out. A provider asking for 300
   * seconds is telling us to go away; honouring it inside a request would hold
   * the caller far past its own deadline, so we fail fast and pass the hint up.
   */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  maxRetryAfterMs: 5_000,
};

/**
 * `resetTimeoutMs` is the probe interval AND therefore the worst-case recovery
 * latency: a provider that comes back one millisecond after a re-open is not
 * noticed for another 30 seconds. That is deliberate and it is what Gate 7's
 * "recovery <60s" is spent on, with the remainder left as margin for the
 * `successThreshold` trials and for whoever is watching to notice.
 *
 * `maxResetTimeoutMs` is intentionally not set, so the window does not widen.
 * The reasoning is on `BreakerPolicy.maxResetTimeoutMs` in circuit-breaker.ts.
 */
export const DEFAULT_BREAKER: BreakerPolicy = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 2,
};

export type ProviderEventKind =
  "request" | "success" | "failure" | "retry" | "short_circuit";

/**
 * Telemetry payload. Deliberately contains no URL, no query string, and no
 * headers, so that wiring it straight into a logger cannot leak a credential.
 */
export interface ProviderEvent {
  readonly provider: ProviderName;
  readonly kind: ProviderEventKind;
  readonly method: string;
  /** Path only. Query strings are stripped upstream of this. */
  readonly path: string;
  readonly attempt: number;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly waitMs?: number | undefined;
}

export interface ProviderClientOptions {
  readonly name: ProviderName;
  /** Origin plus any fixed path prefix, e.g. "https://api.seatgeek.com/2". */
  readonly baseUrl: string;
  /** Sent on every request. The place for User-Agent and Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly breaker?: BreakerPolicy;
  readonly quota?: QuotaPolicy;
  /**
   * Shared pacing. MusicBrainz MUST pass one; it is a global per-IP limit and a
   * limiter per client instance would multiply the rate by the instance count.
   */
  readonly rateLimiter?: RateLimiter;
  readonly killSwitch?: KillSwitch;
  /**
   * Re-tune the local quota from `X-RateLimit-*` on every response.
   *
   * For providers that publish no numeric limit and instead document that the
   * client MUST read the headers - ListenBrainz is the one we depend on. A
   * hard-coded constant for such a provider is a guess that fails silently the
   * day they lower the real limit: we keep spending against a budget that no
   * longer exists and learn about it through 429s.
   *
   * `quota` remains the fallback, used until the first response arrives and
   * whenever a response omits the headers.
   */
  readonly adaptiveQuota?: boolean;
  readonly clock?: Clock;
  readonly onEvent?: (event: ProviderEvent) => void;
}

export interface RequestSpec {
  readonly method?: string;
  /** Appended to `baseUrl`. Must begin with "/". */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Quota units this call spends. Defaults to 1. */
  readonly cost?: number;
  /**
   * Statuses that mean "no data": the body is discarded and `null` is
   * returned. A MusicBrainz 404 or a ListenBrainz 204 is a normal answer about
   * the catalogue, not a failure.
   */
  readonly emptyStatuses?: readonly number[];
  /**
   * Statuses whose BODY the caller needs to read.
   *
   * Last.fm answers 403 with `{ "error": 10 }` and SeatGeek answers 403 with a
   * code that distinguishes "no credential" from "credential rejected".
   * Throwing on the status would discard exactly the information that makes
   * the failure actionable.
   */
  readonly acceptStatuses?: readonly number[];
}

/** Strips the query string. The only URL form permitted anywhere near a log. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

/** Parses `Retry-After` in either of its two legal forms. Returns ms. */
export function parseRetryAfter(
  raw: string | null,
  now: number,
): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

export class ProviderClient {
  readonly name: ProviderName;
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #breaker: CircuitBreaker;
  readonly #quota: QuotaCounter | null;
  readonly #rateLimiter: RateLimiter | null;
  readonly #killSwitch: KillSwitch;
  readonly #adaptiveQuota: boolean;
  readonly #clock: Clock;
  readonly #onEvent: ((event: ProviderEvent) => void) | undefined;

  constructor(opts: ProviderClientOptions) {
    this.name = opts.name;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#headers = { ...opts.headers };
    this.#fetch = opts.fetch ?? systemFetch;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.#clock = opts.clock ?? systemClock;
    this.#breaker = new CircuitBreaker(
      opts.breaker ?? DEFAULT_BREAKER,
      this.#clock,
    );
    this.#quota =
      opts.quota === undefined
        ? null
        : new QuotaCounter(opts.quota, this.#clock);
    this.#rateLimiter = opts.rateLimiter ?? null;
    this.#killSwitch = opts.killSwitch ?? new KillSwitch();
    this.#adaptiveQuota = opts.adaptiveQuota === true;
    this.#onEvent = opts.onEvent;
  }

  status(): ProviderStatus {
    return statusOf(
      this.#killSwitch.isEnabled(this.name),
      this.#breaker.snapshot().state,
    );
  }

  get breaker(): CircuitBreaker {
    return this.#breaker;
  }

  get quota(): QuotaCounter | null {
    return this.#quota;
  }

  /** Performs the request and parses JSON. Returns `null` for accepted misses. */
  async requestJson(spec: RequestSpec): Promise<unknown> {
    const res = await this.#execute(spec);
    if (res === null) return null;
    if (res.body.trim() === "") return null;
    try {
      return parseJson(res.body, `${this.name}${spec.path}`);
    } catch (err) {
      throw new UpstreamError({
        provider: this.name,
        kind: "malformed",
        message: err instanceof Error ? err.message : "unparseable body",
        status: res.status,
        cause: err,
      });
    }
  }

  async requestText(spec: RequestSpec): Promise<string | null> {
    const res = await this.#execute(spec);
    return res === null ? null : res.body;
  }

  #url(spec: RequestSpec): string {
    const url = `${this.#baseUrl}${spec.path}`;
    if (spec.query === undefined) return url;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query)) {
      if (v === undefined) continue;
      params.set(k, typeof v === "number" ? String(v) : v);
    }
    const qs = params.toString();
    return qs === "" ? url : `${url}?${qs}`;
  }

  #emit(event: ProviderEvent): void {
    this.#onEvent?.(event);
  }

  async #execute(
    spec: RequestSpec,
  ): Promise<{ status: number; body: string } | null> {
    const method = spec.method ?? "GET";
    const url = this.#url(spec);
    const cost = spec.cost ?? 1;

    if (!this.#killSwitch.isEnabled(this.name)) {
      this.#emit({
        provider: this.name,
        kind: "short_circuit",
        method,
        path: spec.path,
        attempt: 0,
        errorKind: "disabled",
      });
      throw new UpstreamError({
        provider: this.name,
        kind: "disabled",
        message:
          this.#killSwitch.reasonFor(this.name) ??
          "provider is disabled at runtime",
      });
    }

    if (!this.#breaker.tryAcquire()) {
      const snap = this.#breaker.snapshot();
      this.#emit({
        provider: this.name,
        kind: "short_circuit",
        method,
        path: spec.path,
        attempt: 0,
        errorKind: "circuit_open",
      });
      throw new UpstreamError({
        provider: this.name,
        kind: "circuit_open",
        message: `circuit open after ${String(snap.opens)} open(s); next attempt at ${String(snap.nextAttemptAt ?? 0)}`,
      });
    }

    let lastError: UpstreamError | null = null;

    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt++) {
      if (this.#quota !== null && !this.#quota.tryConsume(cost)) {
        const snap = this.#quota.snapshot();
        const err = new UpstreamError({
          provider: this.name,
          kind: "quota_exhausted",
          message: `local quota spent (${String(snap.used)}/${String(snap.limit)} per ${String(snap.windowMs)}ms)`,
          retryAfterMs: this.#quota.msUntilAvailable(),
        });
        this.#emit({
          provider: this.name,
          kind: "short_circuit",
          method,
          path: spec.path,
          attempt,
          errorKind: "quota_exhausted",
        });
        // Not the provider's fault, so it must not count toward the breaker.
        this.#breaker.recordSuccess();
        throw err;
      }

      if (this.#rateLimiter !== null) {
        try {
          await this.#rateLimiter.acquire();
        } catch (err) {
          this.#breaker.recordSuccess();
          throw new UpstreamError({
            provider: this.name,
            kind: "queue_overflow",
            message:
              err instanceof QueueOverflowError
                ? err.message
                : "rate limiter refused the request",
            cause: err,
          });
        }
      }

      const started = this.#clock.now();
      this.#emit({
        provider: this.name,
        kind: "request",
        method,
        path: spec.path,
        attempt,
      });

      let outcome: { status: number; body: string } | UpstreamError;
      try {
        outcome = await this.#attempt(url, method, spec);
      } catch (err) {
        outcome =
          err instanceof UpstreamError
            ? err
            : new UpstreamError({
                provider: this.name,
                kind: "network",
                message: err instanceof Error ? err.message : "network failure",
                cause: err,
              });
      }
      const durationMs = this.#clock.now() - started;

      if (!(outcome instanceof UpstreamError)) {
        this.#breaker.recordSuccess();
        this.#emit({
          provider: this.name,
          kind: "success",
          method,
          path: spec.path,
          attempt,
          status: outcome.status,
          durationMs,
        });
        if (spec.emptyStatuses?.includes(outcome.status) === true) return null;
        return outcome;
      }

      lastError = outcome;
      if (outcome.countsAgainstProvider) {
        this.#breaker.recordFailure();
      } else {
        // A 404 or a 400 says nothing about provider health; recording it as a
        // success keeps a catalogue gap from tripping the circuit.
        this.#breaker.recordSuccess();
      }

      this.#emit({
        provider: this.name,
        kind: "failure",
        method,
        path: spec.path,
        attempt,
        status: outcome.status,
        durationMs,
        errorKind: outcome.kind,
      });

      if (!outcome.retryable || attempt === this.#retry.maxAttempts) break;

      const waitMs = this.#backoffMs(attempt, outcome.retryAfterMs);
      if (waitMs === null) break; // Retry-After longer than we are willing to wait.

      this.#emit({
        provider: this.name,
        kind: "retry",
        method,
        path: spec.path,
        attempt,
        errorKind: outcome.kind,
        waitMs,
      });
      await this.#clock.sleep(waitMs);
    }

    throw (
      lastError ??
      new UpstreamError({
        provider: this.name,
        kind: "network",
        message: "request failed with no recorded cause",
      })
    );
  }

  /**
   * Full jitter, per AWS's "Exponential Backoff and Jitter". Equal jitter and
   * decorrelated jitter both leave a synchronised floor; under a burst of feed
   * requests that floor is what re-creates the thundering herd we are backing
   * off to avoid.
   */
  #backoffMs(attempt: number, retryAfterMs: number | undefined): number | null {
    if (retryAfterMs !== undefined) {
      if (retryAfterMs > this.#retry.maxRetryAfterMs) return null;
      // A little jitter even on an explicit hint, so N callers told "1 second"
      // do not all return in the same millisecond.
      return retryAfterMs + Math.floor(this.#clock.random() * 100);
    }
    const ceiling = Math.min(
      this.#retry.maxDelayMs,
      this.#retry.baseDelayMs * 2 ** (attempt - 1),
    );
    return Math.floor(this.#clock.random() * ceiling);
  }

  /**
   * Adopts the budget the provider just declared.
   *
   * `X-RateLimit-Limit` is the units per window and `X-RateLimit-Reset-In` is
   * the seconds remaining in it, which is the window length only when the
   * window has just started. Using it as the window is therefore slightly
   * conservative and never optimistic, which is the correct direction of error
   * for a limit whose breach has no appeals process.
   *
   * Any missing or unparseable header leaves the configured fallback in place.
   */
  #adaptQuota(headers: HttpHeadersLike): void {
    if (!this.#adaptiveQuota || this.#quota === null) return;
    const limit = Number(headers.get("x-ratelimit-limit"));
    const resetIn = Number(headers.get("x-ratelimit-reset-in"));
    if (!Number.isFinite(limit) || limit < 1) return;
    if (!Number.isFinite(resetIn) || resetIn < 1) return;
    this.#quota.retune({ limit, windowMs: resetIn * 1000 });
  }

  async #attempt(
    url: string,
    method: string,
    spec: RequestSpec,
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timeoutMs = spec.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let res: HttpResponse;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { ...this.#headers, ...spec.headers },
        signal: controller.signal,
      });
      this.#adaptQuota(res.headers);
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError"));
      throw new UpstreamError({
        provider: this.name,
        kind: aborted ? "timeout" : "network",
        message: aborted
          ? `${method} ${redactUrl(url)} exceeded ${String(timeoutMs)}ms`
          : err instanceof Error
            ? err.message
            : "network failure",
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await res.text();

    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, body };
    }

    if (
      spec.acceptStatuses?.includes(res.status) === true ||
      spec.emptyStatuses?.includes(res.status) === true
    ) {
      return { status: res.status, body };
    }

    const retryAfterMs = parseRetryAfter(
      res.headers.get("retry-after"),
      this.#clock.now(),
    );

    if (res.status === 429) {
      throw new UpstreamError({
        provider: this.name,
        kind: "rate_limited",
        message: `429 from ${method} ${spec.path}`,
        status: 429,
        retryAfterMs,
      });
    }
    if (res.status === 408 || res.status >= 500) {
      throw new UpstreamError({
        provider: this.name,
        kind: "server_error",
        message: `HTTP ${String(res.status)} from ${method} ${spec.path}`,
        status: res.status,
        retryAfterMs,
      });
    }
    throw new UpstreamError({
      provider: this.name,
      kind: "http",
      message: `HTTP ${String(res.status)} from ${method} ${spec.path}`,
      status: res.status,
      retryAfterMs,
    });
  }
}
