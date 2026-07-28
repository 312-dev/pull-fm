/**
 * Run phases.
 *
 * WHY A WARM-UP PHASE EXISTS AT ALL
 * ---------------------------------
 * The SLO says "cache hit (warm) > 90%". That word is doing real work. The
 * crosswalk is permanent (PLAN.md section 3: written to Postgres on first
 * resolution and served from there forever), so in steady state almost every
 * track a user meets has already been resolved by somebody. A load run that
 * starts against an empty cache is not measuring steady state, and no amount of
 * distribution tuning fixes that:
 *
 *   hit rate over N draws from a head of H items is roughly 1 - H/N
 *
 * With a 2,000 item head and a 30 minute measured window, the arithmetic gives
 * about 90% at best, so the gate would be decided by run length rather than by
 * the cache working. Running an explicit warm-up first and excluding it from
 * the measurement fixes the semantics instead of gaming the number.
 *
 * Requests tagged phase:warmup are excluded from the SLO sub-metrics and from
 * the cache metrics (see lib/http.js). They still hit the system, which is the
 * point: the warm-up is what makes the cache warm.
 */
import exec from "k6/execution";

export const elapsedSeconds = () => exec.instance.currentTestRunDuration / 1000;

/**
 * @param {number} rampUpS
 * @param {number} warmupS
 * @returns {() => 'warmup'|'measured'}
 */
export function warmupPhaser(rampUpS, warmupS) {
  const boundary = rampUpS + warmupS;
  return () => (elapsedSeconds() < boundary ? "warmup" : "measured");
}

/** Requests in this phase are excluded from SLO and cache accounting. */
export function isWarmup(phase) {
  return phase === "warmup";
}
