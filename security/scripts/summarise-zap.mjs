#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - read a ZAP SARIF report and say what is in it
//
// The HTML report is what you read when triaging one finding. This is what you
// read to answer "did the gate pass, and if not, on what". It exists because
// the ZAP exit code alone cannot distinguish the two outcomes that matter most:
//
//   exit 0, 40 alerts, all Informational   -> the scan worked, nothing blocking
//   exit 0, 0 alerts, 0 requests sent      -> the scan did not happen
//
// AUDIT-2026-07-29 F16 is the second case happening on purpose. So this refuses
// to print a clean summary for a report with no results at all, and says so
// rather than printing a reassuring zero.
//
// Usage: node security/scripts/summarise-zap.mjs <report.sarif> [--json]
// Exit:  0 no High findings, 1 High findings present, 2 the report is unusable.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

/** SARIF level -> the ZAP risk it came from, for a report a human recognises. */
const LEVEL_TO_RISK = {
  error: "High",
  warning: "Medium",
  note: "Low",
  none: "Informational",
};

export function summarise(sarif) {
  const runs = sarif?.runs ?? [];
  const rules = new Map();
  for (const run of runs) {
    for (const rule of run.tool?.driver?.rules ?? []) {
      rules.set(rule.id, rule);
    }
  }

  const byRisk = { High: [], Medium: [], Low: [], Informational: [] };
  let total = 0;
  for (const run of runs) {
    for (const result of run.results ?? []) {
      total++;
      const rule = rules.get(result.ruleId);
      const risk =
        LEVEL_TO_RISK[
          result.level ?? rule?.defaultConfiguration?.level ?? "none"
        ] ?? "Informational";
      const locations = (result.locations ?? [])
        .map((l) => l.physicalLocation?.artifactLocation?.uri)
        .filter(Boolean);
      byRisk[risk].push({
        ruleId: result.ruleId,
        name: rule?.name ?? rule?.shortDescription?.text ?? result.ruleId,
        message: result.message?.text ?? "",
        locations,
      });
    }
  }
  return { total, byRisk, ruleCount: rules.size };
}

/** Collapse duplicates so a header missing on 12 routes reads as one finding. */
function group(findings) {
  const out = new Map();
  for (const f of findings) {
    const existing = out.get(f.ruleId);
    if (existing) {
      existing.count++;
      for (const l of f.locations)
        if (existing.locations.length < 6 && !existing.locations.includes(l))
          existing.locations.push(l);
    } else {
      out.set(f.ruleId, {
        ...f,
        count: 1,
        locations: [...f.locations].slice(0, 6),
      });
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    process.stderr.write(
      "Usage: node security/scripts/summarise-zap.mjs <report.sarif>\n",
    );
    process.exit(2);
  }

  let sarif;
  try {
    sarif = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(
      `FAIL    cannot read ${path}: ${err.message}\n` +
        "        No report means the plan did not reach its report job. That is a\n" +
        "        scan failure, not a clean scan.\n",
    );
    process.exit(2);
  }

  const s = summarise(sarif);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    process.exit(s.byRisk.High.length > 0 ? 1 : 0);
  }

  if (s.total === 0) {
    process.stderr.write(
      "SUSPECT the report contains zero results of any severity, including\n" +
        "        Informational. A real passive scan of this API always raises at\n" +
        "        least timestamp and cacheability informationals, so zero almost\n" +
        "        certainly means no requests were scanned rather than that nothing\n" +
        "        was found. Check the openapi import job and the auth sanity check\n" +
        "        before recording this as a pass.\n",
    );
    process.exit(2);
  }

  for (const risk of ["High", "Medium", "Low", "Informational"]) {
    const grouped = group(s.byRisk[risk]);
    if (grouped.length === 0) continue;
    process.stdout.write(
      `\n${risk} (${s.byRisk[risk].length} alert(s), ${grouped.length} distinct rule(s))\n`,
    );
    for (const f of grouped) {
      process.stdout.write(`  [${f.ruleId}] ${f.name}  x${f.count}\n`);
      for (const l of f.locations) process.stdout.write(`      ${l}\n`);
    }
  }

  process.stdout.write(
    `\n${s.total} alert(s) across ${s.ruleCount} rule(s). ` +
      `High=${s.byRisk.High.length} Medium=${s.byRisk.Medium.length} ` +
      `Low=${s.byRisk.Low.length} Info=${s.byRisk.Informational.length}\n`,
  );
  process.exit(s.byRisk.High.length > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("summarise-zap.mjs")) main();
