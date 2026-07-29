/**
 * Test doubles for the upstream HTTP layer.
 *
 * NO TEST IN THIS REPOSITORY MAY CALL A REAL PROVIDER. Beyond flakiness, the
 * providers we depend on revoke access for exactly this kind of traffic:
 * MusicBrainz blocks IPs, Apple documents ~20 calls/min with no appeals
 * process, and Last.fm treats a terms breach as grounds for immediate
 * termination. The load suite (load/mock-upstreams) exists for the same reason.
 *
 * Excluded from the published build; see tsconfig.build.json.
 */

import type { Clock, FetchLike, HttpResponse } from "../types.js";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface FakeResponseSpec {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Throws instead of responding, simulating a socket-level failure. */
  readonly networkError?: string;
  /** Never resolves until aborted, so the client's own timeout fires. */
  readonly hang?: boolean;
}

function makeResponse(spec: FakeResponseSpec): HttpResponse {
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    headers.set(k.toLowerCase(), v);
  }
  const body =
    typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {});
  return {
    status: spec.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  };
}

/** A fetch double driven by a queue of responses, with full request capture. */
export class FakeHttp {
  readonly requests: RecordedRequest[] = [];
  #queue: FakeResponseSpec[] = [];
  #default: FakeResponseSpec | null = null;

  /** Queues responses, consumed in order. */
  enqueue(...specs: FakeResponseSpec[]): this {
    this.#queue.push(...specs);
    return this;
  }

  /** Response used once the queue is empty. */
  always(spec: FakeResponseSpec): this {
    this.#default = spec;
    return this;
  }

  get callCount(): number {
    return this.requests.length;
  }

  get lastRequest(): RecordedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  reset(): void {
    this.requests.length = 0;
    this.#queue = [];
    this.#default = null;
  }

  readonly fetch: FetchLike = (url, init) => {
    this.requests.push({
      url,
      method: init.method,
      headers: { ...init.headers },
    });
    const spec = this.#queue.shift() ?? this.#default;
    if (spec === null) {
      return Promise.reject(
        new Error(`FakeHttp: no response queued for ${url}`),
      );
    }
    if (spec.networkError !== undefined) {
      return Promise.reject(new Error(spec.networkError));
    }
    if (spec.hang === true) {
      return new Promise<HttpResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return Promise.resolve(makeResponse(spec));
  };
}

/**
 * Deterministic clock.
 *
 * `sleep` advances virtual time and resolves immediately, so a test that
 * exercises three retries with backoff runs in microseconds while still
 * asserting on the delays that were requested.
 */
export class FakeClock implements Clock {
  #now: number;
  #random: number;
  readonly sleeps: number[] = [];

  constructor(start = 1_700_000_000_000, random = 0.5) {
    this.#now = start;
    this.#random = random;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  setRandom(value: number): void {
    this.#random = value;
  }

  random(): number {
    return this.#random;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
    return Promise.resolve();
  }
}
