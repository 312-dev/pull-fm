#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - publication gate for legal/
//
// legal/README.md states the rule this script enforces: a `[CONFIRM]` "must not
// survive into a published version", and an `[OPEN]` marks a claim the system
// does not actually support. Both were, until now, enforced by whoever
// remembered. This makes them fail a command instead.
//
// The specific thing being prevented: `terms-of-service.md` section 16 reads
// "These Terms are governed by the laws of [CONFIRM: state]". Published as
// written, the governing-law and venue clauses select no law and no forum, so
// the dispute framework the rest of the document depends on is void. That is
// not a typo class of defect, and a reader skimming a 20KB document to publish
// it will not necessarily hit line 384.
//
// Exit codes:
//   0  no markers remain: legal/ is publishable as far as a machine can tell
//   1  at least one marker remains  <- the normal state today, deliberately
//   2  usage or IO error
//
// Zero dependencies, like the other checks in this repository: Node 22 and a
// checkout, nothing else.
//
// Usage:
//   node legal/check-publication-blockers.mjs [--json] [--quiet]
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Anything matching this is unresolved and blocks publication. */
const MARKER = /\[(CONFIRM|OPEN)\b[^\]]*\]/g;

/**
 * Markers whose effect, if published unresolved, is worse than "incomplete".
 *
 * Keyed by a stable substring of the marker text. A marker that matches nothing
 * here is reported as UNCLASSIFIED rather than as low severity, so that adding a
 * marker cannot quietly create a severity-zero blocker, and so that this table
 * going stale is visible instead of silent.
 *
 * `void` means the surrounding clause has no legal effect as written.
 * `misleading` means it reads as a statement of fact that is not one, or omits
 * something a reader needs in order to act on a right.
 */
const CLASSIFIED = [
  {
    match: "CONFIRM: state]",
    kind: "void",
    why: "Governing law selects no law. With no chosen law the clause does nothing, and the rest of the dispute framework rests on it.",
  },
  {
    match: "CONFIRM: county/state courts]",
    kind: "void",
    why: "Venue and consent to personal jurisdiction select no forum. Unenforceable as written.",
  },
  {
    match: "CONFIRM: state of organisation]",
    kind: "misleading",
    why: "The contracting entity is not fully identified, in a document that is a binding agreement with it. Also decides which state's law is the natural choice in section 16.",
  },
  {
    match: "CONFIRM: a postal address is required",
    kind: "misleading",
    why: "Several consumer-facing regimes require a postal address on a published legal document.",
  },
  {
    match: "CONFIRM - required for a published policy",
    kind: "misleading",
    why: "Same requirement, privacy-policy side.",
  },
  {
    match: "CONFIRM: the lead",
    kind: "misleading",
    why: "A data subject cannot exercise the right to complain if the policy does not name the authority.",
  },
  {
    match: "CONFIRM: whether the compiled client binaries",
    kind: "decision",
    why: "Licence terms for distributed binaries. Needs an answer, does not void a clause.",
  },
  {
    match: "CONFIRM with counsel: that this clause is drafted",
    kind: "decision",
    why: "Enforceability review of an existing clause, not a hole in it.",
  },
  {
    match: "CONFIRM with counsel: whether to include an arbitration clause",
    kind: "decision",
    why: "Deliberately omitted. A decision to confirm, not a gap.",
  },
  {
    match: "CONFIRM with counsel: the appropriate mechanism",
    kind: "decision",
    why: "Controller-side US access mechanism. Open question, disclosed as one.",
  },
  {
    match: "CONFIRM]",
    kind: "decision",
    why: "Bare marker: read it in place.",
  },
  {
    match: "OPEN]",
    kind: "open",
    why: "A gap in the system, disclosed. Narrow the wording or close it in code; do not delete it.",
  },
];

const RANK = {
  void: 0,
  misleading: 1,
  open: 2,
  decision: 3,
  unclassified: 4,
  legend: 5,
};

const LABEL = {
  void: "VOID IF PUBLISHED",
  misleading: "MISLEADING IF PUBLISHED",
  open: "OPEN GAP (disclosed)",
  decision: "DECISION NEEDED",
  unclassified: "UNCLASSIFIED - classify it in this script",
  legend: "legend, not a blocker",
};

/** Everything except `legend` blocks publication. */
const BLOCKING = (f) => f.kind !== "legend";

/**
 * Two places mention the markers rather than containing unresolved ones: the
 * directory README, which defines what they mean, and the DRAFT banner at the
 * top of each document, which is itself deleted at publication.
 *
 * These are reported as `legend` rather than filtered out. A gate that can never
 * reach zero is a gate people learn to ignore, so the count has to be able to
 * hit zero; but a silent exemption list is where a real blocker would go to
 * hide, so nothing is silent. Every marker found is still printed.
 */
function isLegend(file, line) {
  return file.endsWith("README.md") || line.trimStart().startsWith(">");
}

function classify(markerText) {
  const hit = CLASSIFIED.find((c) => markerText.includes(c.match));
  return (
    hit ?? { kind: "unclassified", why: "Not in the table in this script." }
  );
}

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(dir, e.name))
    .sort();
}

function scan(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MARKER)) {
      const legend = isLegend(file, line);
      const { kind, why } = legend
        ? { kind: "legend", why: "Explains the markers; not one." }
        : classify(m[0]);
      out.push({
        file: relative(ROOT, file),
        line: i + 1,
        marker: m[0],
        kind,
        why,
        text: line.trim().slice(0, 160),
      });
    }
  });
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  for (const a of argv) {
    if (!["--json", "--quiet"].includes(a)) {
      process.stderr.write(
        `unknown option: ${a}\nUsage: node legal/check-publication-blockers.mjs [--json] [--quiet]\n`,
      );
      process.exit(2);
    }
  }

  let findings;
  try {
    findings = markdownFiles(HERE).flatMap(scan);
  } catch (err) {
    process.stderr.write(`cannot scan legal/: ${err.message}\n`);
    process.exit(2);
  }

  findings.sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const blockers = findings.filter(BLOCKING);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: blockers.length === 0, blockers: blockers.length, findings }, null, 2)}\n`,
    );
    process.exit(blockers.length === 0 ? 0 : 1);
  }

  if (blockers.length === 0) {
    if (!quiet) {
      process.stdout.write(
        `OK      no unresolved markers in legal/ (${findings.length} legend mention(s) ignored).\n` +
          "        A lawyer still has to read it. This checks for holes, not for correctness.\n",
      );
    }
    process.exit(0);
  }

  const counts = findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});

  const voids = findings.filter((f) => f.kind === "void");

  process.stderr.write(
    `\nlegal/ IS NOT PUBLISHABLE: ${blockers.length} unresolved marker(s).\n`,
  );
  if (voids.length > 0) {
    process.stderr.write(
      `\n  ${voids.length} of them make a clause VOID as written. Publishing the document\n` +
        "  in this state would ship a dispute framework that selects no law and no\n" +
        "  forum. Do not guess: the controller's state of organisation is a fact\n" +
        "  about 312.dev LLC, not a drafting preference.\n",
    );
  }
  process.stderr.write("\n");

  let lastKind = null;
  for (const f of findings) {
    if (f.kind !== lastKind) {
      process.stderr.write(`  ${LABEL[f.kind]}  (${counts[f.kind]})\n`);
      lastKind = f.kind;
    }
    process.stderr.write(`    ${f.file}:${f.line}  ${f.marker}\n`);
    if (f.kind === "void" || f.kind === "unclassified") {
      process.stderr.write(`      ${f.why}\n`);
    }
  }

  process.stderr.write(
    "\n  Read this the right way round: OPEN markers are the document being\n" +
      "  honest about a real gap. Narrow the wording or close the gap in code.\n" +
      "  Deleting one to make this command pass turns a disclosed weakness into\n" +
      "  a false statement, which is the failure mode legal/README.md exists to\n" +
      "  prevent.\n\n",
  );

  process.exit(1);
}

main();
