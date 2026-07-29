/**
 * Client for the egress guard's control plane (`load/safety/upstream-guard.mjs`).
 *
 * The guard is loaded into the BFF process, so it sees something k6 cannot see
 * from outside and the BFF does not report: every outbound provider call, with
 * the URL it was made for. Two gates depend on that vantage point.
 *
 * SINGLE-FLIGHT. `packages/upstream/src/single-flight.ts` coalesces concurrent
 * misses for one key into one upstream call, and its own header says the map is
 * PER PROCESS. Nothing in `apps/bff` exposes `SingleFlight.stats` or
 * `CachedUpstream.coalescing`; `GET /metrics` is a stub that emits only
 * `pullfm_build_info`. So there is no in-band signal, and a unit test with a
 * fake clock cannot demonstrate the property under real event-loop concurrency
 * anyway. Counting at the fetch boundary is the only honest measurement
 * available, and it is the measurement that matters: what reached the network.
 *
 * UPSTREAM CEILINGS. Gate 1 wants egress measured "at the network layer". The
 * mock's `/__admin/stats` counts what ARRIVED, which is the same number when
 * everything works and a different number when a request is dropped, retried,
 * or sent somewhere unexpected. Both are recorded; a divergence is itself a
 * finding.
 */
import http from "k6/http";

import { CONFIG } from "./config.js";

function get(path) {
  const res = http.get(`${CONFIG.guardUrl}${path}`, {
    timeout: "5s",
    tags: { endpoint: "guard_admin", slo: "no" },
  });
  if (res.status !== 200) return null;
  try {
    return res.json();
  } catch {
    return null;
  }
}

export function guardHealth() {
  return get("/__guard/health");
}

export function guardStats() {
  return get("/__guard/stats");
}

export function guardReset() {
  const res = http.post(`${CONFIG.guardUrl}/__guard/reset`, null, {
    timeout: "5s",
    tags: { endpoint: "guard_admin", slo: "no" },
  });
  return res.status === 200;
}

/**
 * Total provider calls the BFF process attempted, across every provider.
 * Returns null when the guard is unreachable, which callers must treat as
 * "unknown" rather than "zero": scoring an unmeasured run as a perfect one is
 * how a safety property quietly stops being checked.
 */
export function totalUpstreamCalls(stats) {
  if (!stats || !stats.byProvider) return null;
  let total = 0;
  for (const k of Object.keys(stats.byProvider)) total += stats.byProvider[k];
  return total;
}

/**
 * Reads the guard and folds its counters into k6 metrics, so the shared
 * thresholds have samples to evaluate.
 *
 * Called from a scenario's `teardown`, which is the last point k6 allows an
 * HTTP call: `handleSummary` runs in its own context and cannot make one. A
 * scenario that skips this leaves `upstream_calls_per_key` with no samples,
 * and k6 scores a threshold over an empty metric as PASSING, so the omission is
 * silent. `upstream_calls: count>0` is the paired presence assertion that makes
 * it loud instead.
 *
 * @returns {boolean} whether the guard could be read at all
 */
export function recordGuardMetrics({
  upstreamCalls,
  upstreamCallsPerKey,
  upstreamRefused,
}) {
  const stats = guardStats();
  if (stats === null) {
    console.warn(
      "GUARD UNREACHABLE IN TEARDOWN: upstream fan-out was not measured. " +
        "upstream_calls_per_key has no samples and its threshold cannot fail.",
    );
    return false;
  }

  upstreamCalls.add(totalUpstreamCalls(stats) ?? 0);
  upstreamRefused.add(stats.refused ?? 0);
  for (const provider of Object.keys(stats.hottest ?? {})) {
    const h = stats.hottest[provider];
    if (h && typeof h.hottestCount === "number") {
      upstreamCallsPerKey.add(h.hottestCount, { provider });
    }
  }

  const total = totalUpstreamCalls(stats) ?? 0;
  const worst = maxCallsForAnyKey(stats);
  console.error(
    `  upstream egress (measured inside the BFF process):\n` +
      `    total calls            ${total}\n` +
      `    worst single cache key ${worst}\n` +
      `    per provider           ${JSON.stringify(stats.byProvider)}\n` +
      `    refused (unknown host) ${stats.refused ?? 0}`,
  );
  return true;
}

/**
 * The largest number of calls any single cache key produced.
 *
 * This is the single-flight gate expressed as one number. For a key that was
 * requested N times concurrently while cold, a working coalescer plus a working
 * cache yields 1. Anything above 1 within a run whose keys are stable is the
 * stampede the coalescer exists to prevent, and 100 is a terms violation.
 */
export function maxCallsForAnyKey(stats) {
  if (!stats || !stats.hottest) return null;
  let worst = 0;
  for (const provider of Object.keys(stats.hottest)) {
    const h = stats.hottest[provider];
    if (h && typeof h.hottestCount === "number" && h.hottestCount > worst) {
      worst = h.hottestCount;
    }
  }
  return worst;
}
