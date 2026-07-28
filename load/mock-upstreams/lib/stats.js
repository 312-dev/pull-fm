/**
 * Per-provider request accounting.
 *
 * This is the half of the harness that answers a question k6 cannot: "did our
 * BFF respect the upstream's quota?" k6 only sees the BFF's front door. The
 * mock sees every egress call, so it is the only place that can prove the
 * Gate 1 assertion (MusicBrainz egress <= 1.0 req/s) and the section 3 claim
 * that resolution is cache-first.
 *
 * Two derived numbers matter for gates:
 *   maxRps1s     highest request count observed in any one second window
 *   rateLimited  count of requests the mock refused. Nonzero means our client
 *                exceeded the real provider's ceiling and would have been
 *                throttled or banned for real.
 */
export class ProviderStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.total = 0;
    this.byStatus = {};
    this.rateLimited = 0;
    this.serverErrors = 0;
    this.timeouts = 0;
    this.clientAborts = 0;
    this.latency = { count: 0, sumMs: 0, maxMs: 0, samples: [] };
    /** Free-form provider-specific counters, e.g. Deezer preview URL outcomes.
     *  Kept open-ended so a provider quirk can be counted without a schema
     *  change on both sides of the harness. */
    this.extra = {};
    /** epoch second -> count. Bounded by sweep(). */
    this.perSecond = new Map();
    this.firstSeenAt = null;
    this.lastSeenAt = null;
  }

  recordRequest(now) {
    this.total += 1;
    this.firstSeenAt ??= now;
    this.lastSeenAt = now;
    const sec = Math.floor(now / 1000);
    this.perSecond.set(sec, (this.perSecond.get(sec) ?? 0) + 1);
  }

  /** @param {boolean} isRefusal true when the status came from the quota
   *  limiter. MusicBrainz refuses with 503, so counting refusals as server
   *  errors would make every quota breach look like an upstream outage. */
  recordResponse(status, latencyMs, isRefusal = false) {
    this.byStatus[status] = (this.byStatus[status] ?? 0) + 1;
    if (status >= 500 && !isRefusal) this.serverErrors += 1;
    const l = this.latency;
    l.count += 1;
    l.sumMs += latencyMs;
    if (latencyMs > l.maxMs) l.maxMs = latencyMs;
    // Reservoir capped so a 4 hour soak cannot grow this without bound. The
    // first 5,000 samples are enough to sanity check the configured profile.
    if (l.samples.length < 5000) l.samples.push(latencyMs);
  }

  bump(name, by = 1) {
    this.extra[name] = (this.extra[name] ?? 0) + by;
  }

  /** Highest count in any single one second bucket. */
  maxRps1s() {
    let max = 0;
    for (const c of this.perSecond.values()) if (c > max) max = c;
    return max;
  }

  /** Highest count in any rolling 60 second window, for the iTunes 20/min
   *  ceiling which a per-second view cannot see. */
  maxPerMinute() {
    const secs = [...this.perSecond.keys()].sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i < secs.length; i++) {
      let sum = 0;
      for (let j = i; j < secs.length && secs[j] < secs[i] + 60; j++) {
        sum += this.perSecond.get(secs[j]);
      }
      if (sum > max) max = sum;
    }
    return max;
  }

  meanRps() {
    if (!this.firstSeenAt || this.lastSeenAt === this.firstSeenAt) return 0;
    return this.total / ((this.lastSeenAt - this.firstSeenAt) / 1000);
  }

  percentile(p) {
    const s = this.latency.samples;
    if (s.length === 0) return 0;
    const sorted = [...s].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((p / 100) * sorted.length),
    );
    return sorted[idx];
  }

  /** Keep at most one hour of per-second buckets. A 4 hour soak otherwise
   *  accumulates 14,400 Map entries per provider for no analytical gain. */
  sweep(now) {
    const cutoff = Math.floor(now / 1000) - 3600;
    for (const sec of this.perSecond.keys()) {
      if (sec < cutoff) this.perSecond.delete(sec);
    }
  }

  toJSON() {
    return {
      total: this.total,
      byStatus: this.byStatus,
      rateLimited: this.rateLimited,
      serverErrors: this.serverErrors,
      timeouts: this.timeouts,
      clientAborts: this.clientAborts,
      meanRps: round(this.meanRps(), 3),
      maxRps1s: this.maxRps1s(),
      maxPerMinute: this.maxPerMinute(),
      latencyMs: {
        mean: this.latency.count
          ? round(this.latency.sumMs / this.latency.count, 1)
          : 0,
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
        max: this.latency.maxMs,
      },
      extra: this.extra,
    };
  }
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
