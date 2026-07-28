#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - BOLA route enumerator (Gate 3)
//
// Gate 3 (docs/PLAN.md §7): "BOLA suite enumerates every user-scoped route from
// the OpenAPI spec and asserts 403/404 for a foreign subject on 100% of them,
// FAILING CI IF ANY ROUTE LACKS A TEST."
//
// This script is the half of that sentence that makes the other half provable.
// It reads the OpenAPI document, insists that every single operation declares
// what kind of authorization it is subject to, and emits the machine-readable
// matrix that the test suite iterates. The suite generates one test per matrix
// row, so coverage is 100% by construction rather than by assertion, and a new
// route with no classification fails here before any test runs.
//
// WHY AN EXPLICIT ANNOTATION RATHER THAN A HEURISTIC
//
// The obvious approach is to infer "user-scoped" from the presence of a path
// parameter or a security requirement. Both inferences are wrong on this API,
// in both directions:
//
//   DELETE /v1/me            has no path parameter and IS user-scoped
//   GET /v1/artists/{mbid}   has a path parameter and is NOT user-scoped
//                            (catalogue data, owned by nobody)
//   POST /v1/webhooks/workos has no security requirement and must never be
//                            treated as an unauthenticated public route
//
// A heuristic therefore produces both false negatives (a route silently
// untested) and false positives (a test that can never pass, which gets
// skipped, which normalises skipping). An explicit annotation moves the
// decision into the pull request that adds the route, where the author has the
// context and the reviewer can see it.
//
// Usage:
//   node security/bola/route-matrix.mjs <openapi.json> [options]
//     --out <file>   write the matrix JSON here (default: stdout)
//     --summary      print a human-readable table to stderr
//     --json         emit findings as JSON instead of text on failure
// Exit: 0 valid, 1 an operation is unclassified or malformed, 2 usage/IO error.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  loadSpec,
  eachOperation,
  routeKey,
  SpecError,
} from "../lib/openapi.mjs";

// The closed set of authorization classes. Closed on purpose: a new class must
// be added here, which forces a decision about how the suite should test it.
export const AUTHZ_CLASSES = {
  // No credential required. Must return the same thing to everyone.
  public: { requiresBola: false },
  // Credential required, but the response contains no subject-owned object.
  // Catalogue and search live here. BOLA does not apply; rate limiting does.
  "authenticated-shared": { requiresBola: false },
  // Credential required AND the response is scoped to the authenticated
  // subject. Every one of these needs a BOLA test.
  "user-scoped": { requiresBola: true },
  // Operational surface that must not be reachable from the public edge at all
  // (/metrics). Tested by asserting it is unreachable, not by BOLA.
  system: { requiresBola: false },
  // Authenticated by a signature rather than a session. Tested by forging.
  webhook: { requiresBola: false },
};

// How the suite substitutes a foreign object identity for a given route.
export const BOLA_STRATEGIES = {
  // The object is addressed by a path parameter: swap in subject A's id while
  // authenticating as subject B. The classic IDOR shape.
  "path-param": { needsParam: true },
  // The object is addressed by a query parameter, including an opaque cursor.
  "query-param": { needsParam: true },
  // The object is referenced from the request body.
  "body-ref": { needsParam: true },
  // The object is addressed by a request header, e.g. Idempotency-Key.
  header: { needsParam: true },
  // The object is implied by the session: there is no client-supplied id to
  // substitute, so the test asserts that subject B sees B's data and never A's,
  // and that an absent or invalid credential is rejected.
  "implicit-subject": { needsParam: false },
};

// A denial must be observable. 200 is never a denial, and 500 means the check
// blew up rather than fired.
const VALID_DENY = new Set([400, 401, 403, 404, 409, 422]);

function classify(doc) {
  const rows = [];
  const problems = [];

  for (const op of eachOperation(doc)) {
    const key = routeKey(op);
    const authz = op.operation["x-pullfm-authz"];

    if (typeof authz !== "string") {
      problems.push({
        route: key,
        field: "x-pullfm-authz",
        message:
          "operation is unclassified. Every operation must declare one of: " +
          `${Object.keys(AUTHZ_CLASSES).join(", ")}. ` +
          "This is Gate 3's 'failing CI if any route lacks a test' clause: an " +
          "unclassified route is an untested route.",
      });
      continue;
    }
    if (!Object.hasOwn(AUTHZ_CLASSES, authz)) {
      problems.push({
        route: key,
        field: "x-pullfm-authz",
        message: `unknown class "${authz}"; expected one of ${Object.keys(AUTHZ_CLASSES).join(", ")}`,
      });
      continue;
    }

    const row = {
      route: key,
      method: op.method,
      path: op.path,
      operationId: op.operationId,
      authz,
      requiresBolaTest: AUTHZ_CLASSES[authz].requiresBola,
      bola: null,
    };

    if (AUTHZ_CLASSES[authz].requiresBola) {
      const bola = op.operation["x-pullfm-bola"];
      if (!bola || typeof bola !== "object") {
        problems.push({
          route: key,
          field: "x-pullfm-bola",
          message:
            "a user-scoped operation must declare how a foreign object identity is substituted",
        });
        continue;
      }
      const strategy = bola.strategy;
      if (!Object.hasOwn(BOLA_STRATEGIES, strategy)) {
        problems.push({
          route: key,
          field: "x-pullfm-bola.strategy",
          message: `unknown strategy "${strategy}"; expected one of ${Object.keys(BOLA_STRATEGIES).join(", ")}`,
        });
        continue;
      }
      if (typeof bola.objectType !== "string" || bola.objectType.length === 0) {
        problems.push({
          route: key,
          field: "x-pullfm-bola.objectType",
          message:
            "required. The suite uses it to look up which subject-A fixture to aim at this route, " +
            "and to fail when no such fixture exists (see BOLA-TESTING.md, positive control).",
        });
        continue;
      }
      if (BOLA_STRATEGIES[strategy].needsParam) {
        if (typeof bola.param !== "string" || bola.param.length === 0) {
          problems.push({
            route: key,
            field: "x-pullfm-bola.param",
            message: `strategy "${strategy}" requires the name of the parameter carrying the object identity`,
          });
          continue;
        }
        if (strategy === "path-param") {
          const declared = op.parameters.some(
            (p) => p?.in === "path" && p?.name === bola.param,
          );
          const templated = op.path.includes(`{${bola.param}}`);
          if (!declared || !templated) {
            problems.push({
              route: key,
              field: "x-pullfm-bola.param",
              message: `"${bola.param}" is not a declared path parameter of ${op.path}`,
            });
            continue;
          }
        }
      }
      const deny = bola.deny;
      if (
        !Array.isArray(deny) ||
        deny.length === 0 ||
        !deny.every((s) => VALID_DENY.has(s))
      ) {
        problems.push({
          route: key,
          field: "x-pullfm-bola.deny",
          message:
            `must be a non-empty list of status codes from ${[...VALID_DENY].join(", ")}. ` +
            "Declaring the expected denial per route is what lets 404-for-privacy and 403-for-forbidden " +
            "coexist without the suite accepting whatever it happens to get.",
        });
        continue;
      }
      row.bola = {
        strategy,
        objectType: bola.objectType,
        param: bola.param ?? null,
        deny: [...deny].sort((a, b) => a - b),
      };
    }

    rows.push(row);
  }

  const dupes = rows
    .map((r) => r.route)
    .filter((r, i, a) => a.indexOf(r) !== i);
  for (const d of new Set(dupes)) {
    problems.push({ route: d, field: "path", message: "duplicate operation" });
  }

  return { rows, problems };
}

function summarise(rows) {
  const byClass = new Map();
  for (const r of rows) byClass.set(r.authz, (byClass.get(r.authz) ?? 0) + 1);
  const lines = [...byClass.entries()]
    .sort()
    .map(([k, v]) => `  ${k.padEnd(22)} ${String(v).padStart(3)}`);
  const bolaCount = rows.filter((r) => r.requiresBolaTest).length;
  return [
    `  ${"TOTAL OPERATIONS".padEnd(22)} ${String(rows.length).padStart(3)}`,
    ...lines,
    `  ${"-> BOLA tests required".padEnd(22)} ${String(bolaCount).padStart(3)}`,
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node security/bola/route-matrix.mjs <openapi.json> [--out <file>] [--summary] [--json]\n",
    );
    process.exit(argv.length === 0 ? 2 : 0);
  }

  let specPath = null;
  let out = null;
  let summary = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--summary") summary = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      process.stderr.write(`unknown option: ${a}\n`);
      process.exit(2);
    } else if (specPath === null) specPath = a;
    else {
      process.stderr.write(`unexpected argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (!specPath || (out !== null && !out)) {
    process.stderr.write("missing required argument\n");
    process.exit(2);
  }

  let doc;
  try {
    doc = loadSpec(specPath);
  } catch (err) {
    if (err instanceof SpecError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  let result;
  try {
    result = classify(doc);
  } catch (err) {
    if (err instanceof SpecError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { rows, problems } = result;

  if (problems.length > 0) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, problems }, null, 2)}\n`,
      );
    } else {
      for (const p of problems) {
        process.stderr.write(
          `UNCLASSIFIED  ${p.route} [${p.field}]: ${p.message}\n`,
        );
      }
      process.stderr.write(
        `\nFAIL    ${problems.length} operation(s) cannot be enumerated for BOLA testing.\n`,
      );
    }
    process.exit(1);
  }

  const matrix = {
    generatedFrom: specPath,
    specVersion: doc.info?.version ?? null,
    operationCount: rows.length,
    bolaTestCount: rows.filter((r) => r.requiresBolaTest).length,
    routes: rows.sort((a, b) => a.route.localeCompare(b.route)),
  };
  const text = `${JSON.stringify(matrix, null, 2)}\n`;

  if (out) writeFileSync(out, text);
  else process.stdout.write(text);

  if (summary) process.stderr.write(`${summarise(rows)}\n`);
  process.exit(0);
}

// Only run the CLI when invoked directly, so the classification logic can be
// imported by tests without the process exiting out from under them.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

export { classify };
