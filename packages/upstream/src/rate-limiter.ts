/**
 * Process-wide request pacing for upstream providers.
 *
 * MusicBrainz permits 1 request per second *per IP, globally* - not per user,
 * not per connection. That is roughly 86,400 lookups per day for the entire
 * service, which is why the architecture is cache-first and why every call must
 * funnel through a single queue. A per-request limiter, or one instantiated per
 * handler, would multiply the rate by the number of concurrent requests and get
 * our IP blocked with no appeals process.
 *
 * Design notes:
 *
 *   - Requests queue in FIFO order rather than being rejected. A discovery feed
 *     assembling ten artists should be slow, not partially broken.
 *   - The queue is bounded. Unbounded queuing under load converts a rate-limit
 *     problem into an out-of-memory problem and a pile of requests whose callers
 *     have long since timed out.
 *   - Pacing is measured from the last *dispatch*, not from completion, so a
 *     slow upstream response cannot silently reduce throughput below the limit.
 */

export interface RateLimiterOptions {
  /** Minimum milliseconds between two dispatches. MusicBrainz requires 1000. */
  readonly minIntervalMs: number;
  /**
   * Maximum queued tasks before new ones are rejected. Rejecting is the honest
   * behaviour: the caller learns immediately instead of waiting past its own
   * timeout for a slot that will never arrive in time.
   */
  readonly maxQueueDepth: number;
  /** Injectable for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class QueueOverflowError extends Error {
  public override readonly name = "QueueOverflowError";
  constructor(depth: number) {
    super(
      `upstream request queue is full (${String(depth)} waiting); refusing to queue further`,
    );
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export class RateLimiter {
  readonly #minIntervalMs: number;
  readonly #maxQueueDepth: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  #queue: Waiter[] = [];
  #draining = false;
  /** Timestamp of the last dispatch. -Infinity so the first call is immediate. */
  #lastDispatchAt = Number.NEGATIVE_INFINITY;
  #dispatched = 0;
  #rejected = 0;
  /**
   * Dispatch timestamps, newest last, bounded.
   *
   * Recorded by the limiter rather than by callers because a caller's
   * continuation runs as a microtask, by which time the loop may have paced
   * several more dispatches. This is also the evidence that proves compliance
   * with a provider's published limit, so it belongs here.
   */
  #dispatchTimes: number[] = [];
  #maxDispatchHistory = 20_000;

  constructor(opts: RateLimiterOptions) {
    if (opts.minIntervalMs < 0) {
      throw new Error("minIntervalMs must be >= 0");
    }
    if (opts.maxQueueDepth < 1) {
      throw new Error("maxQueueDepth must be >= 1");
    }
    this.#minIntervalMs = opts.minIntervalMs;
    this.#maxQueueDepth = opts.maxQueueDepth;
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  get stats(): { dispatched: number; rejected: number; queued: number } {
    return {
      dispatched: this.#dispatched,
      rejected: this.#rejected,
      queued: this.#queue.length,
    };
  }

  /** Dispatch timestamps in order. Used to prove the observed rate. */
  get dispatchTimes(): readonly number[] {
    return this.#dispatchTimes;
  }

  /**
   * Highest number of dispatches observed in any window of `windowMs`.
   *
   * This is the number a provider actually enforces against. A mean rate can
   * sit under the limit while a burst inside it still triggers a block.
   */
  peakInWindow(windowMs: number): number {
    const times = this.#dispatchTimes;
    let peak = 0;
    for (let i = 0; i < times.length; i++) {
      const start = times[i];
      if (start === undefined) continue;
      let count = 0;
      for (let j = i; j < times.length; j++) {
        const t = times[j];
        if (t === undefined || t >= start + windowMs) break;
        count++;
      }
      if (count > peak) peak = count;
    }
    return peak;
  }

  /**
   * Resolves when the caller is permitted to dispatch.
   *
   * Callers must dispatch promptly after this resolves; the slot is consumed
   * whether or not the request is actually made.
   */
  acquire(): Promise<void> {
    if (this.#queue.length >= this.#maxQueueDepth) {
      this.#rejected++;
      return Promise.reject(new QueueOverflowError(this.#queue.length));
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.#queue.push({ resolve, reject });
    });

    // Fire-and-forget: the drain loop owns error delivery via each waiter's
    // reject, so there is nothing meaningful to await or catch here.
    void this.#drain();
    return promise;
  }

  /** Convenience wrapper: acquire a slot, then run `fn`. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const waitMs =
          this.#minIntervalMs - (this.#now() - this.#lastDispatchAt);
        if (waitMs > 0) {
          await this.#sleep(waitMs);
          // Re-check: the queue may have been drained or rejected while asleep.
          continue;
        }
        const next = this.#queue.shift();
        if (next === undefined) break;
        const at = this.#now();
        this.#lastDispatchAt = at;
        this.#dispatched++;
        if (this.#dispatchTimes.length < this.#maxDispatchHistory) {
          this.#dispatchTimes.push(at);
        }
        next.resolve();
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Rejects everything queued. Used on shutdown so in-flight callers fail fast
   * instead of hanging until their own timeouts fire.
   */
  drainAndReject(reason: string): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const w of queued) {
      w.reject(new Error(reason));
    }
  }
}
