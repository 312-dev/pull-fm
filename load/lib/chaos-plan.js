/**
 * The failure-injection matrix for Gate 7.
 *
 * Gate 7: "Under a failure-injection matrix (each upstream forced to
 * 429/500/timeout in turn) /feed returns 200 with degraded sections, p95
 * <800ms, errors <1%, no pool exhaustion, recovery <60s."
 *
 * WHY THE SCHEDULE IS COMPUTED, NOT COMMUNICATED
 * ----------------------------------------------
 * Two k6 scenarios run at once: a conductor that injects faults and a traffic
 * generator that has to tag its requests with the fault in effect. k6 gives
 * VUs no shared mutable state, so the usual answers are a coordination channel
 * (an extra request per iteration, which distorts the load) or a shared file
 * (which k6 cannot write mid-run).
 *
 * Instead both sides derive the phase from elapsed run time. The schedule is a
 * pure function of the configuration, so the conductor and every traffic VU
 * independently agree on which phase is active without exchanging a byte.
 */
const PROVIDERS = (
  __ENV.CHAOS_PROVIDERS ??
  "musicbrainz,listenbrainz,lastfm,itunes,deezer,reccobeats"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FAULTS = (__ENV.CHAOS_FAULTS ?? "429,500,timeout")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** How long each fault is held. Long enough for a circuit breaker to open and
 *  for the p95 window to actually contain degraded traffic. */
const HOLD_S = Number(__ENV.CHAOS_HOLD_SECONDS ?? 45);

/** Quiet period after each fault, during which recovery is measured. Must
 *  exceed the 60s recovery budget the gate allows, or a slow recovery would be
 *  cut off by the next fault and scored as a pass. */
const RECOVER_S = Number(__ENV.CHAOS_RECOVER_SECONDS ?? 30);

/** Warm-up before the first fault, so the baseline is a warm cache rather than
 *  a cold start being blamed on chaos. */
const WARMUP_S = Number(__ENV.CHAOS_WARMUP_SECONDS ?? 60);

export function buildPlan() {
  const phases = [];
  let t = WARMUP_S;
  for (const provider of PROVIDERS) {
    for (const fault of FAULTS) {
      phases.push({
        provider,
        fault,
        label: `${provider}:${fault}`,
        startS: t,
        faultEndS: t + HOLD_S,
        endS: t + HOLD_S + RECOVER_S,
      });
      t += HOLD_S + RECOVER_S;
    }
  }
  return {
    warmupSeconds: WARMUP_S,
    holdSeconds: HOLD_S,
    recoverSeconds: RECOVER_S,
    totalSeconds: t,
    phases,
  };
}

/** Phase label for a point in the run, used to tag traffic. */
export function phaseAt(plan, elapsedSeconds) {
  if (elapsedSeconds < plan.warmupSeconds) return "warmup";
  for (const p of plan.phases) {
    if (elapsedSeconds >= p.startS && elapsedSeconds < p.faultEndS)
      return p.label;
    if (elapsedSeconds >= p.faultEndS && elapsedSeconds < p.endS)
      return `${p.label}:recovering`;
  }
  return "cooldown";
}

/** k6 duration string for the whole matrix, plus a tail so the traffic
 *  scenario outlives the last recovery window. */
export function planDuration(plan, tailSeconds = 30) {
  return `${plan.totalSeconds + tailSeconds}s`;
}
