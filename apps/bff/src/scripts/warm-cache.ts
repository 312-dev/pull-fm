/**
 * Warms the MusicBrainz cache and the iTunes preview store.
 *
 *   pnpm --filter @pull-fm/bff warm:cache
 *
 * SCHEDULE: EVERY 30 MINUTES.
 *
 * The cadence is derived from the budget rather than chosen. At the default
 * pacing a run spends at most 300 MusicBrainz calls at one every two seconds
 * (600 seconds) and 60 iTunes calls at one every six (360 seconds), so a full
 * run is about sixteen minutes and the whole-run deadline is twenty. Half-hourly
 * therefore leaves a comfortable gap between runs, which matters because the
 * budget being spent is PER IP AND GLOBAL: two overlapping runs on one egress
 * address would double the observed rate against a limit that does not care
 * that we thought of them as separate jobs. The advisory lock makes an overlap
 * safe; the schedule makes it unlikely, and both are wanted.
 *
 * Running it more often does not warm more, because each run is bounded by its
 * own call ceilings, and would only shorten the gap that keeps two runs apart.
 * Running it much less often lets the working set go cold: the request path
 * uses `peek` and DROPS what it cannot name, so an unwarmed MBID is a missing
 * shelf item rather than a slow one.
 *
 * Why a scheduled command and not an in-process timer. Every other job in this
 * directory has the horizontal-scaling argument; this one has it twice over.
 * An interval inside the BFF would fire once per node, and each node would pace
 * itself correctly against a limiter it does not share with the others, so the
 * service would exceed a per-IP limit by exactly the node count while every
 * individual node's metrics showed perfect compliance. That is not a race, it
 * is a terms violation that no single process can observe.
 *
 * EXIT CODES:
 *
 *   0  the run completed, or declined because another run held the lock. A run
 *      that warmed nothing because there was nothing cold is also 0.
 *   1  the run could not start, or the candidate list could not be read. A
 *      working set we cannot enumerate is one we must not guess at, so nothing
 *      was called. Worth alerting on if it repeats: the cache decays and the
 *      product degrades silently, one dropped shelf item at a time.
 *   2  the run completed but backed off. Either it YIELDED the provider budget,
 *      which is the system working as designed but worth knowing about if it
 *      happens every run, or a provider failed repeatedly, or the run hit its
 *      deadline or a call ceiling with candidates still waiting.
 */

import { loadConfig } from "../config.js";
import { buildServices, closeServices } from "../wiring.js";
import {
  CacheWarmer,
  CACHE_WARMER_DEFAULTS,
  type PhaseOutcome,
} from "../services/cache-warmer.js";
import { intFromEnv, jobLogger, runJob } from "./job-env.js";

/** True when a phase stopped short of finishing its candidate list. */
function backedOff(phase: PhaseOutcome): boolean {
  return (
    phase.yieldedOn !== null ||
    phase.deadlineHit ||
    phase.capped ||
    phase.failed > 0
  );
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const log = jobLogger();
  const d = CACHE_WARMER_DEFAULTS;

  const services = buildServices(cfg, log);
  try {
    const job = new CacheWarmer(
      services.db,
      services.discovery,
      services.upstream.previewWarmer,
      {
        musicbrainzIntervalMs: intFromEnv(
          "WARM_MUSICBRAINZ_INTERVAL_MS",
          d.musicbrainzIntervalMs,
        ),
        musicbrainzMaxCalls: intFromEnv(
          "WARM_MUSICBRAINZ_MAX_CALLS",
          d.musicbrainzMaxCalls,
        ),
        itunesIntervalMs: intFromEnv(
          "WARM_ITUNES_INTERVAL_MS",
          d.itunesIntervalMs,
        ),
        itunesMaxCalls: intFromEnv("WARM_ITUNES_MAX_CALLS", d.itunesMaxCalls),
        runDeadlineMs: intFromEnv("WARM_RUN_DEADLINE_MS", d.runDeadlineMs),
        maxConsecutiveFailures: intFromEnv(
          "WARM_MAX_CONSECUTIVE_FAILURES",
          d.maxConsecutiveFailures,
        ),
      },
    );

    const outcome = await job.run();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);

    if (!outcome.ran) return 0;

    for (const [name, phase] of [
      ["musicbrainz", outcome.musicbrainz],
      ["itunes", outcome.itunes],
    ] as const) {
      if (phase.yieldedOn !== null) {
        // Not a failure. The warmer is background work and is supposed to be
        // the first thing to stop when a shared budget tightens. It is surfaced
        // because a yield on EVERY run means the budget is permanently spent
        // and the cache will not converge.
        process.stderr.write(
          `note: the ${name} phase yielded the provider budget (${phase.yieldedOn}) ` +
            `after ${String(phase.called)} call(s) and stopped for this run. ` +
            "That is the intended behaviour; if it happens every run, the cache " +
            "is not converging and the pacing or the schedule needs revisiting.\n",
        );
      }
      if (phase.deadlineHit) {
        process.stderr.write(
          `note: the ${name} phase hit the run deadline with candidates still ` +
            "waiting. Runs must finish well inside their scheduling interval so " +
            "two of them cannot overlap on one egress IP.\n",
        );
      }
    }

    return backedOff(outcome.musicbrainz) || backedOff(outcome.itunes) ? 2 : 0;
  } finally {
    await closeServices(services);
  }
}

runJob("the upstream cache warm", main);
