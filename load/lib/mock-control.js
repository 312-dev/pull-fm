/**
 * Client for the mock upstream control plane.
 *
 * The mock is the only component that sees our egress. That makes it the only
 * place that can answer the questions PLAN.md gate 1 and section 3 actually
 * ask: did we stay under 1 req/s to MusicBrainz, did we stay under 20/min to
 * iTunes, and did the cache absorb what it was supposed to absorb.
 */
import http from "k6/http";

import { CONFIG } from "./config.js";
import { upstreamQuotaViolations } from "./metrics.js";

const admin = (path) => `${CONFIG.mockUrl}/__admin${path}`;
const JSON_HEADERS = { "content-type": "application/json" };
const TAGS = { endpoint: "mock_admin", slo: "no" };

export function mockAvailable() {
  const res = http.get(admin("/health"), { timeout: "3s", tags: TAGS });
  return res.status === 200;
}

/**
 * @param {string} provider one of the six, or 'all'
 * @param {null|'429'|'500'|'timeout'|'down'} fault
 * @param {string} label free text recorded on the mock so its log lines up
 */
export function setFault(provider, fault, label) {
  const body = { [provider]: { faults: { force: fault } } };
  if (label !== undefined) body._label = label;
  const res = http.post(admin("/config"), JSON.stringify(body), {
    headers: JSON_HEADERS,
    timeout: "5s",
    tags: TAGS,
  });
  if (res.status !== 200) {
    console.error(
      `mock control: failed to set ${provider}=${fault} (status ${res.status})`,
    );
  }
  return res.status === 200;
}

export function clearFaults(label = "idle") {
  return setFault("all", null, label);
}

export function resetMock(what = "all") {
  return (
    http.post(admin(`/reset?what=${what}`), null, { timeout: "5s", tags: TAGS })
      .status === 200
  );
}

export function getStats() {
  const res = http.get(admin("/stats"), { timeout: "5s", tags: TAGS });
  if (res.status !== 200) return null;
  try {
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Compare observed egress against each provider's published ceiling and record
 * a metric sample per violation. Called from teardown, where k6 does accept
 * metric samples (verified against k6 v2.1.0).
 *
 * Skip this when faults were injected on purpose: a forced 429 is not evidence
 * that we exceeded anything.
 *
 * @returns {{violations:number, report:string[]}}
 */
export function assertUpstreamQuota({ tolerance = 0 } = {}) {
  const stats = getStats();
  const report = [];
  if (!stats) {
    report.push("mock stats unavailable, upstream quota was NOT verified");
    return { violations: 0, report };
  }

  let violations = 0;
  for (const [name, s] of Object.entries(stats.providers)) {
    if (s.total === 0) {
      report.push(`${pad(name)} no traffic`);
      continue;
    }
    // Stated in the provider's own unit: "1/1s" for MusicBrainz, "20/60s" for
    // iTunes. Normalising everything to req/s turns 20 calls per minute into
    // 0.333/s, which is arithmetically correct and useless to read.
    const ceiling = `${s.quota.limit}/${Math.round(s.quota.windowMs / 1000)}s`;
    const line =
      `${pad(name)} ${String(s.total).padStart(7)} attempted  ` +
      `peak ${String(s.maxRps1s).padStart(4)}/s, ${String(s.maxPerMinute).padStart(5)}/min ` +
      `(ceiling ${ceiling})  ` +
      `refused ${s.rateLimited}  5xx ${s.serverErrors}  timeouts ${s.timeouts}`;
    report.push(line);

    // The refusal count is the authoritative signal: the mock enforces the
    // limit, so any refusal means the real provider would have refused us too.
    if (s.rateLimited > tolerance) {
      violations += 1;
      upstreamQuotaViolations.add(1, { provider: name });
      report.push(
        `${pad("")} QUOTA EXCEEDED: ${s.rateLimited} request(s) were refused by ${name}. ` +
          `In production this is a throttle, and for MusicBrainz or Last.fm it is a ban.`,
      );
    }
    const extras = Object.entries(s.extra ?? {});
    if (extras.length > 0) {
      report.push(
        `${pad("")} ${extras.map(([k, v]) => `${k}=${v}`).join(" ")}`,
      );
    }
  }
  return { violations, report };
}

/** Log the full egress picture. Printed rather than exported to the summary
 *  because k6 cannot make HTTP calls from handleSummary; capture the mock's own
 *  view alongside the run with:
 *    curl -s $MOCK_URL/__admin/stats > k6-results/<scenario>-upstream.json  */
export function logUpstreamReport(lines) {
  console.log("");
  console.log("  UPSTREAM EGRESS (as seen by the mock, not by k6)");
  for (const l of lines) console.log(`    ${l}`);
  console.log("");
}

function pad(s) {
  return String(s).padEnd(14);
}
