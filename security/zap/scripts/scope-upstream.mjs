#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - remove provider-reaching operations from the spec ZAP will scan
//
// WHY THIS EXISTS, ALONGSIDE prune-openapi.mjs
//
// prune-openapi.mjs answers "would the scanner destroy the subject it is
// testing?" via `x-pullfm-dast`. This script answers a different question that
// the same annotation was silently being trusted for: "can the scanner reach a
// third-party provider?"
//
// They are not the same question, and the difference is not academic.
// MusicBrainz permits 1 request per second GLOBALLY per IP and revokes without
// appeal; docs/PLAN.md section 8 calls exceeding it product-ending. A DAST
// crawler sends garbage identifiers by construction, and under a cache-first
// design every garbage identifier is a guaranteed cache MISS. Three operations
// carrying `x-pullfm-dast: "include"` egress to a provider on exactly that
// input. GET /v1/artists/{mbid}/similar does it for ANY well-formed UUID with
// no existence check at all.
//
// So the DAST-safe spec had to be filtered a second time, against a register
// that classifies egress rather than destructiveness:
// security/zap/upstream-scope.tsv.
//
// FAILS CLOSED, IN BOTH DIRECTIONS
//
//   - an operation in the spec with no row in the register  -> exit 1
//   - a row in the register with no operation in the spec   -> exit 1
//   - a register that classifies zero operations            -> exit 1
//   - a result with zero surviving operations               -> exit 1
//
// The last two are the lesson of security/AUDIT-2026-07-29.md F7 and F16: a
// checker that reports success on an empty input is indistinguishable from one
// that works, and "OK 0 operations in the DAST-safe spec" is the worst possible
// output because ZAP will then scan nothing and report clean.
//
// Usage:
//   node security/zap/scripts/scope-upstream.mjs <in.json> <out.json>
//                                                [--allow-subject-gated] [--quiet]
//
// --allow-subject-gated keeps operations that can egress ONLY when the
// authenticated subject holds a stored provider credential. The runner passes
// it only after PROVING the scan subject holds zero connections; see
// security/scripts/run-dast.sh. It is off by default because the safe default
// has to be the one that survives somebody forgetting.
//
// Exit: 0 written, 1 a reconciliation or floor failure, 2 usage or IO error.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  loadSpec,
  eachOperation,
  routeKey,
  SpecError,
  HTTP_METHODS,
} from "../../lib/openapi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTER_PATH = resolve(HERE, "..", "upstream-scope.tsv");

/** The only classifications the register may use. */
export const CLASSIFICATIONS = new Set(["none", "subject-gated", "egress"]);

/**
 * Parse the tab-separated register.
 *
 * Hand-parsed on purpose: this tooling has no YAML or CSV dependency and does
 * not want one, because the whole security-tooling tree is meant to run from a
 * bare checkout with nothing installed. The format is deliberately rigid so
 * that a malformed line is an error rather than a silently skipped route.
 */
export function parseRegister(text) {
  const rows = new Map();
  const problems = [];

  text.split("\n").forEach((raw, idx) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;

    const cells = line.split("\t");
    if (cells.length < 4) {
      problems.push(
        `line ${idx + 1}: expected 4 tab-separated columns ` +
          `(route, classification, providers, evidence), found ${cells.length}. ` +
          "Tabs, not spaces: the parser is literal about it.",
      );
      return;
    }

    const route = cells[0].trim();
    const classification = cells[1].trim();
    const providers = cells[2].trim();
    const evidence = cells.slice(3).join("\t").trim();

    if (!/^[A-Z]+ \//.test(route)) {
      problems.push(
        `line ${idx + 1}: ${JSON.stringify(route)} is not a "METHOD /path" key.`,
      );
      return;
    }
    if (!CLASSIFICATIONS.has(classification)) {
      problems.push(
        `line ${idx + 1}: classification ${JSON.stringify(classification)} for ${route} ` +
          `must be one of ${[...CLASSIFICATIONS].join(", ")}.`,
      );
      return;
    }
    if (evidence === "") {
      problems.push(
        `line ${idx + 1}: ${route} has no evidence. A classification with no ` +
          "stated reason is an undocumented accepted risk, and those belong in " +
          "security/accepted-risks.md rather than here.",
      );
      return;
    }
    if (rows.has(route)) {
      problems.push(
        `line ${idx + 1}: ${route} is classified twice. The second row would ` +
          "silently win, which is how a route gets downgraded by accident.",
      );
      return;
    }

    rows.set(route, { route, classification, providers, evidence });
  });

  return { rows, problems };
}

/**
 * Decide the fate of every operation and rebuild the document.
 *
 * Rebuilt as an allowlist rather than mutated as a denylist, matching
 * prune-openapi.mjs: for a filter whose job is to stop a request reaching a
 * provider that can revoke us, the direction of the default matters more than
 * the line count.
 */
export function scope(doc, register, { allowSubjectGated = false } = {}) {
  const problems = [];
  const kept = [];
  const removed = [];
  const seen = new Set();

  for (const op of eachOperation(doc)) {
    const key = routeKey(op);
    seen.add(key);
    const row = register.get(key);
    if (row === undefined) {
      problems.push(
        `${key} has no row in ${REGISTER_PATH}. Classify it as none, ` +
          "subject-gated or egress before it can be scanned. Unclassified " +
          "operations are rejected rather than defaulted, because the " +
          "convenient default is the one that gets our provider access revoked.",
      );
      continue;
    }
    const scannable =
      row.classification === "none" ||
      (row.classification === "subject-gated" && allowSubjectGated);
    (scannable ? kept : removed).push({ key, ...row });
  }

  // A stale row is not cosmetic. It means the register was written against a
  // spec that no longer exists, so nobody can say whether the surviving rows
  // still describe reality.
  for (const key of register.keys()) {
    if (!seen.has(key)) {
      problems.push(
        `${key} is classified in ${REGISTER_PATH} but is not an operation in ` +
          "the spec. Remove the row, or find out why the route disappeared.",
      );
    }
  }

  if (problems.length > 0) return { problems, kept, removed, doc: null };

  const removedKeys = new Set(removed.map((r) => r.key));
  const out = structuredClone(doc);
  out.info = { ...out.info };
  out.info["x-pullfm-upstream-scoped"] = {
    removedOperations: removed.map((r) => `${r.key} [${r.classification}]`),
    subjectGatedIncluded: allowSubjectGated,
    note:
      "Generated by security/zap/scripts/scope-upstream.mjs from " +
      "security/zap/upstream-scope.tsv. Operations that can reach a third-party " +
      "provider are absent. Do not use this document for anything except DAST.",
  };

  out.paths = Object.fromEntries(
    Object.entries(out.paths)
      .map(([path, item]) => [
        path,
        Object.fromEntries(
          Object.entries(item).filter(
            ([k]) =>
              !HTTP_METHODS.includes(k) ||
              !removedKeys.has(`${k.toUpperCase()} ${path}`),
          ),
        ),
      ])
      .filter(([, item]) => HTTP_METHODS.some((m) => item[m])),
  );

  return { problems, kept, removed, doc: out };
}

export function loadRegister(path = REGISTER_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new SpecError(`cannot read register at ${path}: ${err.message}`);
  }
  const { rows, problems } = parseRegister(text);
  if (problems.length > 0) {
    throw new SpecError(
      `${path} is malformed:\n  ${problems.join("\n  ")}\n` +
        `FAIL    ${problems.length} problem(s) in the upstream-egress register.`,
    );
  }
  // A register that classifies nothing would let every operation through the
  // "no row" check only by failing it, but an emptied register plus a spec with
  // no operations would produce a confident green on zero input. Refuse both.
  if (rows.size === 0) {
    throw new SpecError(
      `${path} classifies zero routes. An empty register is not a valid one: ` +
        "it cannot distinguish 'nothing egresses' from 'nobody looked'.",
    );
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  const allowSubjectGated = argv.includes("--allow-subject-gated");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--help") || positional.length !== 2) {
    process.stderr.write(
      "Usage: node security/zap/scripts/scope-upstream.mjs <in.json> <out.json> " +
        "[--allow-subject-gated] [--quiet]\n",
    );
    process.exit(2);
  }
  const [input, output] = positional;

  let doc;
  let register;
  try {
    doc = loadSpec(input);
    register = loadRegister();
  } catch (err) {
    if (err instanceof SpecError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.message.includes("is malformed") ? 1 : 2);
    }
    throw err;
  }

  const result = scope(doc, register, { allowSubjectGated });

  if (result.problems.length > 0) {
    for (const p of result.problems) process.stderr.write(`UNSCOPED  ${p}\n`);
    process.stderr.write(
      `\nFAIL    ${result.problems.length} reconciliation problem(s) between the ` +
        "spec and the upstream-egress register.\n",
    );
    process.exit(1);
  }

  // AUDIT 2026-07-29 F16: the pruner exits 0 on a spec with zero operations,
  // and "OK 0 operation(s)" is a green DAST result that proves nothing. This
  // filter can produce the same outcome by classifying everything as egress,
  // so it refuses to.
  if (result.kept.length === 0) {
    process.stderr.write(
      "FAIL    every operation was removed as provider-reaching, so ZAP would " +
        "import an empty spec and report clean. A DAST run with no operations " +
        "is not a passing scan, it is an absent one.\n",
    );
    process.exit(1);
  }

  try {
    writeFileSync(output, `${JSON.stringify(result.doc, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`cannot write ${output}: ${err.message}\n`);
    process.exit(2);
  }

  if (!quiet) {
    process.stdout.write(
      `OK      ${result.kept.length} operation(s) cannot reach a provider, ` +
        `${result.removed.length} removed -> ${output}\n`,
    );
    for (const r of result.removed) {
      process.stdout.write(
        `        removed [${r.classification}] ${r.key}` +
          `${r.providers && r.providers !== "-" ? ` -> ${r.providers}` : ""}\n`,
      );
    }
    if (!allowSubjectGated) {
      process.stdout.write(
        "        subject-gated operations were excluded; pass " +
          "--allow-subject-gated only after proving the scan subject holds zero " +
          "provider connections.\n",
      );
    }
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("scope-upstream.mjs")) main();
