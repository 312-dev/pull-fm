/**
 * Fixed-window rate limiter, one window per (provider, key).
 *
 * Fixed window rather than a token bucket because the headers we have to
 * emit are window-shaped: X-RateLimit-Reset is "when does the current window
 * end", which a token bucket does not naturally have. Matching the header
 * semantics matters more here than smoothing the boundary effect, since the
 * BFF's backoff logic is written against those headers.
 *
 * The limiter ENFORCES, it does not merely observe. A mock that logs "you
 * exceeded MusicBrainz" while still returning 200 lets a broken client pass the
 * gate. MusicBrainz would not have been so forgiving.
 */
export class RateLimiter {
  constructor() {
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.windows = new Map();
  }

  /**
   * @param {string} key composite of provider and the per-provider bucket key
   * @param {{limit:number, windowMs:number}} spec
   * @param {number} now epoch ms
   */
  check(key, spec, now) {
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + spec.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= spec.limit;
    return {
      allowed,
      limit: spec.limit,
      remaining: Math.max(0, spec.limit - w.count),
      resetAt: w.resetAt,
      resetInSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    };
  }

  /** Drop windows that ended long ago so a 4 hour soak does not grow a Map
   *  entry per ListenBrainz token forever. */
  sweep(now) {
    for (const [k, w] of this.windows) {
      if (now - w.resetAt > 60_000) this.windows.delete(k);
    }
  }

  reset() {
    this.windows.clear();
  }
}

/**
 * Which bucket a request falls into. ListenBrainz is per-token and Last.fm is
 * per-API-key, so modeling both as "global" would make a fan-out across many
 * users look like it hits one ceiling when it does not (ListenBrainz) or make
 * a shared key look like it scales when it does not (Last.fm).
 */
export function bucketKeyFor(provider, spec, req, url) {
  switch (spec.keyBy) {
    case "token": {
      const auth = req.headers["authorization"] ?? "";
      return `${provider}:token:${auth.slice(0, 64) || "anonymous"}`;
    }
    case "apiKey": {
      const k = url.searchParams.get("api_key") ?? "none";
      return `${provider}:key:${k}`;
    }
    default:
      // "global" is the honest model for a per-IP limit: every request we make
      // leaves from the same small set of egress IPs.
      return `${provider}:global`;
  }
}
