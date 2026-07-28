/**
 * Result export and the human-readable summary.
 *
 * Defining handleSummary replaces k6's built-in end-of-test output entirely, so
 * this module has to render its own. That is a feature here: a gate record
 * needs the run's parameters and the pass/fail of every threshold in one
 * artifact, and k6's default summary carries neither.
 *
 * Two files are written per run:
 *   <results>/<scenario>-<timestamp>.json   the record, keep this one
 *   <results>/<scenario>-latest.json        stable path for CI to read
 *
 * The k6-results/ directory and *.k6.json are already in .gitignore, so results
 * never land in the public repo.
 */
import { CONFIG } from "./config.js";
import { TRAFFIC_MODEL } from "./journey.js";

/**
 * @param {string} scenario
 * @param {object} data k6 summary data
 * @param {{profile:string, notes?:string[]}} meta
 */
export function buildSummary(scenario, data, meta) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const thresholds = collectThresholds(data);
  const failed = thresholds.filter((t) => !t.ok);

  const invalidations = [];
  if (CONFIG.smoke)
    invalidations.push(
      "SMOKE=1: thresholds were relaxed, this is a shakeout run",
    );
  if (CONFIG.allowUnreachable)
    invalidations.push("ALLOW_UNREACHABLE=1: the target may not have been up");
  if (count(data, "stub_responses") > 0) {
    invalidations.push("responses came from the fake BFF stub, not a real BFF");
  }
  if (data.setup_data && data.setup_data.stubbed) {
    invalidations.push("preflight saw x-pullfm-stub on /healthz");
  }
  if (data.setup_data && data.setup_data.mockAvailable === false) {
    // Without the mock's egress accounting there is no evidence that upstream
    // quotas were respected, and upstream_quota_violations would sit at zero
    // samples and pass by default.
    invalidations.push(
      "mock control plane was unreachable: upstream quota was NOT verified",
    );
  }
  if (CONFIG.thinkScale === 0) {
    invalidations.push(
      "THINK_SCALE=0: no think time, this is a max-pressure run and not the traffic model",
    );
  }

  const record = {
    scenario,
    profile: meta.profile,
    startedAt: data.setup_data ? data.setup_data.startedAt : null,
    finishedAt: new Date().toISOString(),
    durationMs: data.state ? data.state.testRunDurationMs : null,
    // The single field CI should branch on. A run can pass every threshold and
    // still be worthless as evidence.
    gate_valid: invalidations.length === 0,
    gate_invalidations: invalidations,
    passed: failed.length === 0,
    failedThresholds: failed.map((t) => `${t.metric}: ${t.expression}`),
    thresholds,
    notes: meta.notes ?? [],
    run: {
      baseUrl: CONFIG.baseUrl,
      mockUrl: CONFIG.mockUrl,
      duration: CONFIG.duration,
      rampUp: CONFIG.rampUp,
      rampDown: CONFIG.rampDown,
      arrivalRate: CONFIG.arrivalRate,
      maxVUs: CONFIG.maxVUs,
      userPool: CONFIG.userPool,
      thinkScale: CONFIG.thinkScale,
      hotSetSize: CONFIG.hotSetSize,
      hotSetShare: CONFIG.hotSetShare,
      previewSource: CONFIG.previewSource,
      verifyPreviewUrl: CONFIG.verifyPreviewUrl,
      coldOffset: CONFIG.coldOffset,
    },
    trafficModel: TRAFFIC_MODEL,
    headline: headline(data),
    metrics: data.metrics,
  };

  const json = JSON.stringify(record, null, 2);
  return {
    stdout: renderText(scenario, record, data),
    [`${CONFIG.resultsDir}/${scenario}-${stamp}.json`]: json,
    [`${CONFIG.resultsDir}/${scenario}-latest.json`]: json,
  };
}

function collectThresholds(data) {
  const out = [];
  for (const [metric, m] of Object.entries(data.metrics ?? {})) {
    for (const [expression, result] of Object.entries(m.thresholds ?? {})) {
      out.push({ metric, expression, ok: Boolean(result.ok) });
    }
  }
  return out;
}

function value(data, metric, key) {
  const m = data.metrics ? data.metrics[metric] : null;
  if (!m || !m.values) return null;
  const v = m.values[key];
  return typeof v === "number" ? v : null;
}

function count(data, metric) {
  return value(data, metric, "count") ?? 0;
}

function headline(data) {
  return {
    requests: count(data, "http_reqs"),
    sessions: count(data, "sessions_completed"),
    p95Ms: value(data, "http_req_duration", "p(95)"),
    p99Ms: value(data, "http_req_duration", "p(99)"),
    errorRate: value(data, "api_error_rate", "rate"),
    httpFailedRate: value(data, "http_req_failed", "rate"),
    cacheHitRate: value(data, "cache_hit_rate", "rate"),
    cacheHeaderPresentRate: value(data, "cache_header_present", "rate"),
    feedDegradedRate: value(data, "feed_degraded_rate", "rate"),
    upstreamQuotaViolations: count(data, "upstream_quota_violations"),
    expiredPreviewUrls: count(data, "expired_preview_urls"),
    problemJsonViolations: count(data, "problem_json_violations"),
  };
}

// ---------------------------------------------------------------------------
// Text rendering. Hand-rolled rather than pulled from jslib.k6.io, because a
// remote import would make the suite require network access to start, and the
// whole point of the mock layer is that a load run touches nothing external.
// ---------------------------------------------------------------------------

function renderText(scenario, record, data) {
  const L = [];
  const rule = "-".repeat(74);

  L.push("");
  L.push(rule);
  L.push(`  pull.fm load: ${scenario}   profile=${record.profile}`);
  L.push(
    `  target ${record.run.baseUrl}   duration ${fmtMs(record.durationMs)}`,
  );
  L.push(rule);

  const h = record.headline;
  L.push("");
  L.push("  TRAFFIC");
  L.push(`    requests            ${fmtNum(h.requests)}`);
  L.push(`    sessions completed  ${fmtNum(h.sessions)}`);
  L.push(
    `    arrival rate        ${record.run.arrivalRate} sessions/s (configured)`,
  );

  L.push("");
  L.push("  LATENCY (all SLO-tagged requests)");
  L.push(
    `    p95                 ${fmtMs2(value(data, "http_req_duration{slo:yes}", "p(95)") ?? h.p95Ms)}`,
  );
  L.push(
    `    p99                 ${fmtMs2(value(data, "http_req_duration{slo:yes}", "p(99)") ?? h.p99Ms)}`,
  );
  for (const ep of ["feed", "track_preview", "search", "artist", "config"]) {
    const p95 = value(data, `http_req_duration{endpoint:${ep}}`, "p(95)");
    if (p95 !== null) L.push(`    ${ep.padEnd(20)}p95 ${fmtMs2(p95)}`);
  }

  L.push("");
  L.push("  CORRECTNESS");
  L.push(`    api error rate      ${fmtPct(h.errorRate)}`);
  L.push(`    http failed rate    ${fmtPct(h.httpFailedRate)}`);
  L.push(
    `    cache hit rate      ${fmtPct(h.cacheHitRate)}  (header present ${fmtPct(h.cacheHeaderPresentRate)})`,
  );
  L.push(`    feed degraded rate  ${fmtPct(h.feedDegradedRate)}`);
  L.push(`    problem+json misses ${fmtNum(h.problemJsonViolations)}`);
  L.push(`    expired preview URL ${fmtNum(h.expiredPreviewUrls)}`);
  L.push(`    upstream quota hits ${fmtNum(h.upstreamQuotaViolations)}`);

  const recovery = value(data, "chaos_recovery_seconds", "p(95)");
  if (recovery !== null) {
    L.push(
      `    recovery p95        ${recovery.toFixed(1)}s (max ${(value(data, "chaos_recovery_seconds", "max") ?? 0).toFixed(1)}s)`,
    );
  }

  L.push("");
  L.push("  THRESHOLDS");
  if (record.thresholds.length === 0) {
    L.push("    (none configured)");
  }
  for (const t of record.thresholds) {
    L.push(`    ${t.ok ? "PASS" : "FAIL"}  ${t.metric} ${t.expression}`);
  }

  if (record.notes.length > 0) {
    L.push("");
    L.push("  NOTES");
    for (const n of record.notes) L.push(`    ${n}`);
  }

  L.push("");
  if (!record.gate_valid) {
    L.push(
      "  ####################################################################",
    );
    L.push(
      "  #  NOT VALID AS GATE EVIDENCE                                      #",
    );
    for (const r of record.gate_invalidations)
      L.push(`  #  - ${r.slice(0, 62).padEnd(62)}#`);
    L.push(
      "  ####################################################################",
    );
  } else if (record.passed) {
    L.push("  RESULT: PASS. Usable as gate evidence.");
  } else {
    L.push(
      `  RESULT: FAIL. ${record.failedThresholds.length} threshold(s) crossed.`,
    );
  }
  L.push(`  record: ${CONFIG.resultsDir}/${scenario}-latest.json`);
  L.push(rule);
  L.push("");
  return L.join("\n");
}

function fmtNum(n) {
  return n === null || n === undefined ? "n/a" : String(Math.round(n));
}
function fmtMs(ms) {
  if (!ms) return "n/a";
  const s = Math.round(ms / 1000);
  return s >= 60
    ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
    : `${s}s`;
}
function fmtMs2(ms) {
  return ms === null || ms === undefined ? "n/a" : `${ms.toFixed(1)} ms`;
}
function fmtPct(r) {
  return r === null || r === undefined ? "n/a" : `${(r * 100).toFixed(3)}%`;
}
