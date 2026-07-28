/**
 * cold-cache: maximum upstream resolution pressure, against MOCKS ONLY.
 *
 * READ THIS BEFORE RUNNING
 * ------------------------
 * This is the scenario PLAN.md section 8 singles out as the one that would have
 * ended the project: v1 specified it at 50k-equivalent load against real
 * providers. MusicBrainz allows 1 req/s globally and Last.fm revokes without
 * appeal. lib/config.js refuses to run against a real upstream host, and that
 * check has no override.
 *
 * WHAT IT MEASURES
 *   PLAN.md gate 2: cold-cache p95 < 2s over a replay.
 *   PLAN.md gate 1 / section 3: that our egress stays inside every provider's
 *   ceiling even when nothing is cached. This is where the plan's arithmetic
 *   ("cold-cache resolution against iTunes is arithmetically impossible" at
 *   2,000 DAU x 15 resolves) becomes a measurement instead of a claim.
 *
 * HOW THE CACHE IS MADE COLD
 *   Preferred: flush the crosswalk and Redis before the run, so the run is
 *   genuinely cold end to end.
 *
 *     docker compose -f docker-compose.dev.yml exec redis redis-cli FLUSHALL
 *     (plus whatever truncates the crosswalk tables, once they exist)
 *
 *   Secondary: COLD_OFFSET shifts the catalog window into MBIDs nothing has
 *   ever resolved. It defaults to a value derived from today's date, so two
 *   runs on the same day reuse the same window. Pass COLD_OFFSET explicitly for
 *   a reproducible run, or a random value for a guaranteed-cold one.
 *
 * The cache_hit_rate threshold is INVERTED here (rate<0.50). A cold run that
 * reports a high hit rate was not cold, and would otherwise be scored as an
 * excellent result.
 *
 *   node load/mock-upstreams/server.js
 *   COLD_OFFSET=$RANDOM k6 run load/scenarios/cold-cache.js
 */
import http from "k6/http";

import {
  CONFIG,
  assertSafeTarget,
  preflight,
  SUMMARY_TREND_STATS,
} from "../lib/config.js";
import { CATALOG_SIZE } from "../lib/catalog.js";
import { runSession } from "../lib/journey.js";
import { sloThresholds } from "../lib/thresholds.js";
import { buildSummary } from "../lib/summary.js";
import {
  assertUpstreamQuota,
  logUpstreamReport,
  resetMock,
} from "../lib/mock-control.js";

assertSafeTarget();

// A cold run draws from the entire catalog, not the bounded warm tail: the
// whole point is that nothing has been resolved before.
CONFIG.tailSetSize = CATALOG_SIZE;
// Some repetition survives even in a cold system (several users reach the same
// trending track), but nothing like the warm 95%. Keeping it low also protects
// the inverted cache threshold below from being tripped by a head that warms up
// during the run rather than by the run not being cold.
CONFIG.hotSetShare = Number(__ENV.HOT_SET_SHARE ?? 0.2);

if (CONFIG.coldOffset === 0) {
  // Day-derived rather than time-derived: every VU initialises at a different
  // instant during the ramp, and a per-VU offset would leave each VU browsing
  // its own private catalog window. Stable within a calendar day, fresh the
  // next.
  CONFIG.coldOffset =
    (Math.floor(Date.now() / 86_400_000) * 104_729) % CATALOG_SIZE;
}

// Cold resolution costs an upstream round trip per request, so the same arrival
// rate as steady-10k would be measuring the mock's queue rather than ours.
// A quarter of the steady rate keeps the run honest and still saturates the
// 1 req/s MusicBrainz ceiling many times over, which is the finding.
const RATE_PER_10S = Math.max(1, Math.round(CONFIG.arrivalRate * 10 * 0.25));

export const options = {
  scenarios: {
    cold: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "10s",
      preAllocatedVUs: Math.min(CONFIG.preAllocatedVUs, 150),
      maxVUs: CONFIG.maxVUs,
      stages: [
        { target: RATE_PER_10S, duration: CONFIG.rampUp },
        { target: RATE_PER_10S, duration: CONFIG.duration },
        { target: 0, duration: CONFIG.rampDown },
      ],
      gracefulStop: "60s",
    },
  },
  thresholds: sloThresholds("cold", { smoke: CONFIG.smoke }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  discardResponseBodies: false,
};

export function setup() {
  const state = preflight(http);
  // Zero the mock's counters so the egress report covers this run only.
  resetMock("stats");
  return state;
}

export default function () {
  runSession();
}

export function teardown(data) {
  if (!data || !data.mockAvailable) {
    console.warn(
      "mock control plane unavailable: upstream quota was not verified",
    );
    return;
  }
  const { report, violations } = assertUpstreamQuota();
  logUpstreamReport(report);
  if (violations > 0) {
    console.log(
      "    A cold-cache run that exceeds an upstream ceiling is the expected",
    );
    console.log(
      "    result until the MB queue, crosswalk and preview worker exist. It is",
    );
    console.log("    a finding, not a flake: see PLAN.md section 3.");
  }
}

export function handleSummary(data) {
  return buildSummary("cold-cache", data, {
    profile: "cold",
    notes: [
      `COLD_OFFSET=${CONFIG.coldOffset} (catalog window shifted so nothing is pre-resolved)`,
      "gate 2 budget: cold p95 < 2000ms",
      "cache_hit_rate threshold is INVERTED (rate<0.50): a high hit rate means the run was not cold",
      "upstream quota violations here are a capacity finding, not a harness bug",
    ],
  });
}
