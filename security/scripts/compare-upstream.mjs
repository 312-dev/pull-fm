#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - did the scan touch an upstream provider?
//
// The whole DAST configuration rests on one claim: the scanner cannot reach
// MusicBrainz, Last.fm, ListenBrainz, Deezer, iTunes or SeatGeek. That claim is
// argued from code (security/zap/upstream-scope.tsv) and enforced by removing
// the operations from the imported spec. This script is the third control: it
// checks the claim against observed counters instead of trusting the argument.
//
// MusicBrainz permits 1 request per second GLOBALLY per IP and revokes without
// appeal, so "the scan probably did not egress" is not a standard this project
// can run on.
//
// TWO SOURCES, DELIBERATELY DIFFERENT IN STRENGTH
//
//   /v1/config     Always available. Coarse: a provider flipping to a
//                  non-ok status after a scan is a loud signal, but a
//                  provider staying "ok" proves only that nothing broke.
//
//   /metrics       Definitive. pullfm_musicbrainz_pacer_dispatched_total and
//                  pullfm_upstream_requests_total{provider} count requests
//                  that actually left the process. Not reachable from the
//                  public edge by design (loopback or METRICS_TOKEN, plus a
//                  deny at nginx), so this is opportunistic.
//
// The distinction is stated in the output rather than smoothed over, because
// the failure this project keeps rediscovering is a check that reports success
// while not checking. "Not observed" and "observed flat" are different answers
// and this prints whichever one is true.
//
// Usage:
//   node security/scripts/compare-upstream.mjs <providers-before.json> <providers-after.json>
//        [--metrics-before <file>] [--metrics-after <file>]
// Exit: 0 nothing moved, 1 something moved, 2 usage or IO error.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

/** Counters whose rise means the scan reached a provider. */
export const EGRESS_COUNTERS = [
  "pullfm_musicbrainz_pacer_dispatched_total",
  "pullfm_musicbrainz_pacer_rejected_total",
  "pullfm_upstream_requests_total",
];

/**
 * Parse a Prometheus exposition body into { "name{labels}": value }.
 *
 * Deliberately literal. A tolerant parser that skipped a line it could not
 * understand would report "flat" for a counter it never read, which is the
 * exact failure mode this file exists to avoid, so an unparseable sample line
 * is surfaced rather than dropped.
 */
export function parsePrometheus(text) {
  const series = new Map();
  const unparsed = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m =
      /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+(-?[\d.eE+]+|NaN|\+Inf|-Inf)$/.exec(
        line,
      );
    if (!m) {
      unparsed.push(line);
      continue;
    }
    series.set(m[1], Number(m[2]));
  }
  return { series, unparsed };
}

/** Every series whose metric name is one of the egress counters. */
export function egressSeries(series) {
  const out = new Map();
  for (const [key, value] of series) {
    const name = key.replace(/\{.*$/, "");
    if (EGRESS_COUNTERS.includes(name)) out.set(key, value);
  }
  return out;
}

export function diffCounters(before, after) {
  const risen = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const b = before.get(key) ?? 0;
    const a = after.get(key) ?? 0;
    if (a > b) risen.push({ key, before: b, after: a, delta: a - b });
  }
  return risen.sort((x, y) => y.delta - x.delta);
}

export function diffProviders(before, after) {
  const changed = [];
  const b = before?.providers ?? {};
  const a = after?.providers ?? {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (b[key] !== a[key])
      changed.push({ provider: key, before: b[key], after: a[key] });
  }
  return changed;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      i++;
      continue;
    }
    positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    process.stderr.write(
      "Usage: node security/scripts/compare-upstream.mjs <providers-before.json> " +
        "<providers-after.json> [--metrics-before f] [--metrics-after f]\n",
    );
    process.exit(2);
  }

  let failed = false;

  // --- provider status ------------------------------------------------------
  try {
    const changed = diffProviders(
      readJson(positional[0]),
      readJson(positional[1]),
    );
    if (changed.length === 0) {
      process.stdout.write(
        "OK      provider status unchanged across the scan\n",
      );
    } else {
      for (const c of changed) {
        process.stdout.write(
          `CHANGED provider ${c.provider}: ${c.before} -> ${c.after}\n`,
        );
      }
      failed = true;
    }
  } catch (err) {
    process.stderr.write(
      `WARN    could not compare provider status: ${err.message}\n`,
    );
  }

  // --- pacer and egress counters -------------------------------------------
  const mb = flag("--metrics-before");
  const ma = flag("--metrics-after");
  if (!mb || !ma) {
    process.stdout.write(
      "UNKNOWN MusicBrainz pacer counters were NOT observed. /metrics is gated to\n" +
        "        loopback or METRICS_TOKEN and denied at nginx, so it is unreachable\n" +
        "        from the public edge by design. The scan is MusicBrainz-safe by\n" +
        "        construction (no HTTP route reaches the MusicBrainz client; every\n" +
        "        request-path read is CachedUpstream.peek, which is database-only),\n" +
        "        but that is an argument, not a measurement. Do not record this run\n" +
        "        as 'pacer stayed flat'.\n",
    );
    process.exit(failed ? 1 : 0);
  }

  const before = parsePrometheus(readFileSync(mb, "utf8"));
  const after = parsePrometheus(readFileSync(ma, "utf8"));
  for (const line of [...before.unparsed, ...after.unparsed].slice(0, 5)) {
    process.stderr.write(`WARN    unparsed metric line: ${line}\n`);
  }

  const b = egressSeries(before.series);
  const a = egressSeries(after.series);
  if (b.size === 0 && a.size === 0) {
    process.stderr.write(
      "FAIL    none of the egress counters were present in either scrape. That is\n" +
        "        not 'flat', it is 'not measured', and treating the two as the same\n" +
        "        answer is the defect this whole tree keeps rediscovering.\n" +
        `        Expected one of: ${EGRESS_COUNTERS.join(", ")}\n`,
    );
    process.exit(1);
  }

  const risen = diffCounters(b, a);
  if (risen.length === 0) {
    process.stdout.write(
      `OK      ${b.size} upstream egress counter(s) observed, none rose during the scan\n`,
    );
  } else {
    for (const r of risen) {
      process.stdout.write(
        `ROSE    ${r.key}: ${r.before} -> ${r.after} (+${r.delta})\n`,
      );
    }
    process.stderr.write(
      "FAIL    the scan produced upstream egress. security/zap/upstream-scope.tsv is\n" +
        "        supposed to make that impossible, so the register is wrong or a new\n" +
        "        route was added. Note that the background cache-warmer also moves\n" +
        "        the MusicBrainz pacer, so confirm attribution before panicking, and\n" +
        "        confirm it QUICKLY: the ceiling is 1 request per second for the\n" +
        "        whole service.\n",
    );
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("compare-upstream.mjs")) main();
