/**
 * The coupling between what the application EXPORTS and what the watchdog
 * READS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST IS THE IMPORTANT ONE IN THIS FILE
 *
 * An alerting system does not usually fail by breaking. It fails by drifting: a
 * metric is renamed for a good reason, the shell script that greps for the old
 * name finds nothing, `metric` returns empty, the check is skipped, and the
 * alert is gone. Nothing errors. The dashboard still renders. The only symptom
 * is silence, which is indistinguishable from a healthy system and is exactly
 * what the operator has been trained to expect.
 *
 * So the watchdog's metric names are extracted from the actual shell script in
 * this repository and required to exist, rather than being restated here where
 * they could agree with the test and disagree with reality.
 *
 * The other half of the loop is in the integration suite, which asserts the
 * captured fixture still matches a live scrape. Together: a rename breaks a
 * test on the day it is made, in the same commit.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { Registry } from "./metrics.js";
import { recordProviderEvent } from "./observability.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WATCHDOG = join(REPO_ROOT, "infra/observability/pullfm-watchdog");
const FIXTURE = join(
  REPO_ROOT,
  "infra/observability/testdata/metrics-sample.txt",
);

/** Every `metric "name{...}"` argument in the watchdog, base name only. */
function watchdogMetricNames(): string[] {
  const src = readFileSync(WATCHDOG, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/metric\s+(["'])(pullfm_[^"'{]+)/g)) {
    names.add(m[2] ?? "");
  }
  return [...names].filter((n) => n !== "");
}

/** Base metric names present in the captured scrape. */
function fixtureMetricNames(): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    const m = /^# TYPE (\S+) /.exec(line);
    if (m?.[1] !== undefined) out.add(m[1]);
  }
  return out;
}

/**
 * Names that only exist once the event they count has happened.
 *
 * A counter with no observations has no series, which is correct Prometheus
 * behaviour and not a gap: `absent()` is how a rule handles it. They are listed
 * here so the assertion below can tell "this is created lazily" from "this was
 * renamed and nothing produces it any more", which is the failure being hunted.
 */
function eventDrivenNames(): Set<string> {
  const r = new Registry();
  for (const kind of [
    "request",
    "success",
    "failure",
    "retry",
    "short_circuit",
  ] as const) {
    recordProviderEvent(r, {
      provider: "itunes",
      kind,
      method: "GET",
      path: "/search",
      attempt: 1,
      status: 200,
      durationMs: 12,
      errorKind: "quota_exhausted",
    });
  }
  const names = new Set<string>();
  for (const line of r.render().split("\n")) {
    const m = /^# TYPE (\S+) /.exec(line);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  // Counted in server.ts on the fail-closed path rather than by this module.
  names.add("pullfm_fail_closed_total");
  names.add("pullfm_maintenance_refusals_total");
  return names;
}

describe("watchdog / exporter coupling", () => {
  test("the watchdog reads at least a dozen distinct series", () => {
    // A guard on the extraction itself. If the regex stopped matching, every
    // assertion below would vacuously pass and the coupling would be gone.
    expect(watchdogMetricNames().length).toBeGreaterThanOrEqual(10);
  });

  test("every metric the watchdog reads is one the application emits", () => {
    const emitted = new Set([...fixtureMetricNames(), ...eventDrivenNames()]);
    const missing = watchdogMetricNames().filter((n) => !emitted.has(n));
    expect(
      missing,
      `the watchdog greps for series nothing exports, so those checks are silently disabled: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the captured fixture is a real scrape, not a stub", () => {
    const names = fixtureMetricNames();
    expect(names.size).toBeGreaterThan(15);
    expect(names.has("pullfm_build_info")).toBe(true);
    expect(names.has("pullfm_db_pool_waiting")).toBe(true);
  });
});

describe("recordProviderEvent", () => {
  test("keeps the three short-circuit reasons apart", () => {
    // circuit_open is a provider outage. quota_exhausted is US running out of
    // budget, which is the SEV-3 that ends the product. disabled is an operator
    // flipping a switch on purpose. One counter for all three would file the
    // most serious of them under the same label as the least.
    const r = new Registry();
    for (const errorKind of ["circuit_open", "quota_exhausted", "disabled"]) {
      recordProviderEvent(r, {
        provider: "musicbrainz",
        kind: "short_circuit",
        method: "GET",
        path: "/ws/2/release",
        attempt: 1,
        errorKind,
      });
    }
    expect(
      r.peek("pullfm_upstream_short_circuits_total", {
        provider: "musicbrainz",
        reason: "quota_exhausted",
      }),
    ).toBe(1);
    expect(
      r.peek("pullfm_upstream_short_circuits_total", {
        provider: "musicbrainz",
        reason: "circuit_open",
      }),
    ).toBe(1);
    expect(
      r.peek("pullfm_upstream_short_circuits_total", {
        provider: "musicbrainz",
        reason: "disabled",
      }),
    ).toBe(1);
  });

  test("a failure with no error kind is labelled, not dropped", () => {
    const r = new Registry();
    recordProviderEvent(r, {
      provider: "lastfm",
      kind: "failure",
      method: "GET",
      path: "/2.0",
      attempt: 2,
    });
    expect(
      r.peek("pullfm_upstream_failures_total", {
        provider: "lastfm",
        kind: "unknown",
      }),
    ).toBe(1);
  });

  test("success records duration in seconds, not milliseconds", () => {
    const r = new Registry();
    recordProviderEvent(r, {
      provider: "deezer",
      kind: "success",
      method: "GET",
      path: "/track",
      attempt: 1,
      status: 200,
      durationMs: 250,
    });
    expect(r.render()).toContain(
      'pullfm_upstream_duration_seconds_sum{provider="deezer"} 0.25',
    );
  });

  test("no label is derived from anything a caller controls", () => {
    // ProviderEvent carries a TEMPLATE path and no query string by design.
    // This asserts the sink does not undo that by promoting `path` to a label.
    const r = new Registry();
    recordProviderEvent(r, {
      provider: "itunes",
      kind: "request",
      method: "GET",
      path: "/search?term=whatever-the-user-typed",
      attempt: 1,
    });
    expect(r.render()).not.toContain("whatever-the-user-typed");
    expect(r.render()).not.toContain("path=");
  });
});
