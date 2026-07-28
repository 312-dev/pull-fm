#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - ZAP shared-fragment drift check
//
// The ZAP plans under security/zap/plans/ are deliberately SELF-CONTAINED: an
// operator can hand any one of them straight to `zap.sh -autorun` with no build
// step, which is what you want at 2am when a scan is misbehaving. The cost of
// that choice is duplication, because every plan repeats the same context
// definition and the same alert filters.
//
// This script pays that cost back. Each duplicated block is delimited by
//
//   # region:shared <path-to-canonical-file>
//   ...
//   # endregion:shared
//
// and the canonical file marks its own authoritative copy with a bare
//
//   # region:shared
//   ...
//   # endregion:shared
//
// The check asserts the two are identical after normalising the base
// indentation, so a filter tuned in one plan and forgotten in the other fails
// CI instead of quietly producing two different definitions of "in scope".
//
// Zero dependencies: no YAML parser is involved, and none is wanted. The
// comparison is textual on purpose, because a semantic comparison would treat
// a dropped comment as equivalent, and in these files the comments carry the
// justification for every filter.
//
// Usage:  node security/scripts/check-zap-fragments.mjs [--json]
// Exit:   0 in sync, 1 drift detected, 2 usage or IO error.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PLANS_DIR = resolve(HERE, "..", "zap", "plans");

const BEGIN = /^#\s*region:shared(?:\s+(\S+))?\s*$/;
const END = /^#\s*endregion:shared\s*$/;

/**
 * Pull every shared region out of a file.
 * Returns [{ source, lines, startLine }]; `source` is the canonical path a
 * consumer declares, or null for the canonical file's own region.
 */
function regions(text) {
  const found = [];
  const lines = text.split("\n");
  let open = null;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const b = BEGIN.exec(trimmed);
    if (b) {
      if (open) throw new Error(`nested region at line ${idx + 1}`);
      open = { source: b[1] ?? null, lines: [], startLine: idx + 1 };
      return;
    }
    if (END.test(trimmed)) {
      if (!open) throw new Error(`unmatched endregion at line ${idx + 1}`);
      found.push(open);
      open = null;
      return;
    }
    if (open) open.lines.push(line);
  });
  if (open)
    throw new Error(`region opened at line ${open.startLine} is never closed`);
  return found;
}

/**
 * Strip the common leading indentation so a fragment embedded under `jobs:`
 * (indent 2) compares equal to the canonical file's top-level copy (indent 0).
 * Prettier formats YAML files in this repo and will happily dedent a top-level
 * sequence, so indentation is not a stable property to compare on.
 */
function dedent(lines) {
  const widths = lines
    .filter((l) => l.trim() !== "")
    .map((l) => l.length - l.trimStart().length);
  const base = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(base)));
}

function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return {
        index: i,
        expected: a[i] ?? "<end of file>",
        actual: b[i] ?? "<end of file>",
      };
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length) {
    process.stderr.write(`unknown option(s): ${unknown.join(", ")}\n`);
    process.exit(2);
  }

  const findings = [];
  const canonicalCache = new Map();

  const canonical = (relPath) => {
    if (!canonicalCache.has(relPath)) {
      const abs = resolve(REPO_ROOT, relPath);
      const own = regions(readFileSync(abs, "utf8")).filter(
        (r) => r.source === null,
      );
      if (own.length !== 1) {
        throw new Error(
          `${relPath} must contain exactly one bare "# region:shared" block, found ${own.length}`,
        );
      }
      canonicalCache.set(relPath, dedent(own[0].lines));
    }
    return canonicalCache.get(relPath);
  };

  let plans;
  try {
    plans = readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => join(PLANS_DIR, f));
  } catch (err) {
    process.stderr.write(`cannot read ${PLANS_DIR}: ${err.message}\n`);
    process.exit(2);
  }

  if (plans.length === 0) {
    process.stderr.write(`no plans found in ${PLANS_DIR}\n`);
    process.exit(2);
  }

  for (const plan of plans) {
    const rel = relative(REPO_ROOT, plan);
    let planRegions;
    try {
      planRegions = regions(readFileSync(plan, "utf8"));
    } catch (err) {
      findings.push({ plan: rel, source: null, message: err.message });
      continue;
    }

    if (planRegions.length === 0) {
      findings.push({
        plan: rel,
        source: null,
        message:
          "plan declares no shared regions. Every plan must embed the canonical " +
          "context and alert filters so the two cannot diverge.",
      });
      continue;
    }

    for (const region of planRegions) {
      if (!region.source) {
        findings.push({
          plan: rel,
          source: null,
          message: `region at line ${region.startLine} does not name its canonical source file`,
        });
        continue;
      }
      let want;
      try {
        want = canonical(region.source);
      } catch (err) {
        findings.push({
          plan: rel,
          source: region.source,
          message: err.message,
        });
        continue;
      }
      const got = dedent(region.lines);
      const diff = firstDifference(want, got);
      if (diff) {
        findings.push({
          plan: rel,
          source: region.source,
          message:
            `drifted from the canonical copy at region line ${diff.index + 1}\n` +
            `    canonical: ${diff.expected}\n` +
            `    in plan:   ${diff.actual}`,
        });
      }
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`,
    );
    process.exit(findings.length === 0 ? 0 : 1);
  }

  for (const f of findings) {
    process.stderr.write(
      `DRIFT   ${f.plan}${f.source ? ` [${f.source}]` : ""}: ${f.message}\n`,
    );
  }
  if (findings.length === 0) {
    process.stdout.write(
      `OK      ${plans.length} ZAP plan(s) in sync with their canonical fragments\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    "\nFAIL    Re-copy the canonical region into the plan, or update the canonical file " +
      "if the change belongs everywhere.\n",
  );
  process.exit(1);
}

main();
