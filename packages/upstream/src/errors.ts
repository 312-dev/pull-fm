/**
 * One error type for every upstream failure, because callers make exactly two
 * decisions about an upstream failure and both need structure:
 *
 *   1. Should this be retried? (`retryable`, `retryAfterMs`)
 *   2. Should the feed degrade, or is this a bug on our side? (`kind`)
 *
 * A section that fails with `circuit_open` should quietly disappear from the
 * feed and add its provider to `unavailableProviders`. A section that fails
 * with `malformed` is our parser being wrong about a contract and should be
 * loud. Collapsing both into `Error` loses that distinction at the exact
 * moment it matters.
 */

import type { ProviderName } from "./types.js";

export type UpstreamErrorKind =
  /** The request exceeded our own deadline. */
  | "timeout"
  /** Connection-level failure: DNS, TCP, TLS, socket reset. */
  | "network"
  /** A non-retryable HTTP status (4xx other than 408/429). */
  | "http"
  /** 429, or a provider-specific in-band rate-limit signal (Last.fm error 29). */
  | "rate_limited"
  /** A retryable HTTP status (5xx). */
  | "server_error"
  /** Parsed fine at the transport level, but did not match the contract. */
  | "malformed"
  /** The circuit breaker is open; no request was made. */
  | "circuit_open"
  /** The local quota counter is spent; no request was made. */
  | "quota_exhausted"
  /** The runtime kill switch is off for this provider; no request was made. */
  | "disabled"
  /** The shared rate-limiter queue is full; no request was made. */
  | "queue_overflow";

export interface UpstreamErrorInit {
  readonly provider: ProviderName;
  readonly kind: UpstreamErrorKind;
  readonly message: string;
  readonly status?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown;
}

/** Kinds that represent "the provider is unwell", i.e. worth retrying. */
const RETRYABLE_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  "timeout",
  "network",
  "rate_limited",
  "server_error",
]);

export class UpstreamError extends Error {
  public override readonly name = "UpstreamError";
  readonly provider: ProviderName;
  readonly kind: UpstreamErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: UpstreamErrorInit) {
    super(`[${init.provider}] ${init.kind}: ${init.message}`, {
      cause: init.cause,
    });
    this.provider = init.provider;
    this.kind = init.kind;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }

  /**
   * Whether this failure is evidence about the *provider's* health.
   *
   * A 404 means we asked for something that does not exist, which is our bug
   * or the data's, not an outage. Counting it toward the breaker would trip the
   * circuit on a catalogue gap and take down a healthy provider.
   */
  get countsAgainstProvider(): boolean {
    return this.retryable;
  }

  /** True when the feed should degrade rather than surface an error. */
  get isDegradation(): boolean {
    return (
      this.kind === "circuit_open" ||
      this.kind === "disabled" ||
      this.kind === "quota_exhausted" ||
      this.kind === "queue_overflow"
    );
  }
}

export function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError;
}
