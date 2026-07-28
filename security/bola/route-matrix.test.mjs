// ---------------------------------------------------------------------------
// Pull.fm - tests for the BOLA route enumerator and the DAST spec pruner.
//
// Gate 3 requires the BOLA suite to fail CI "if any route lacks a test". The
// enumerator is what implements that clause, so the cases that matter here are
// the negative ones: a route the enumerator would silently skip is a route with
// no BOLA coverage and a green build.
//
// Run:  node --test security/bola/route-matrix.test.mjs
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECURITY = resolve(HERE, "..");
const MATRIX = resolve(HERE, "route-matrix.mjs");
const PRUNER = resolve(SECURITY, "zap", "scripts", "prune-openapi.mjs");
const FIXTURES = resolve(SECURITY, "testdata", "openapi");
const SPEC = resolve(FIXTURES, "pullfm-v1.example.json");

function run(script, args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (err) {
    return {
      code: err.status ?? -1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

const matrixOf = (fixture) => run(MATRIX, [resolve(FIXTURES, fixture)]);

test("the reference spec enumerates cleanly", () => {
  const r = matrixOf("pullfm-v1.example.json");
  assert.equal(r.code, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.ok(
    m.operationCount > 20,
    "fixture should cover the whole PLAN.md §6 surface",
  );
  assert.ok(m.bolaTestCount > 0);
});

test("every user-scoped route carries a complete BOLA descriptor", () => {
  const m = JSON.parse(matrixOf("pullfm-v1.example.json").stdout);
  for (const route of m.routes.filter((r) => r.requiresBolaTest)) {
    assert.ok(route.bola, `${route.route} has no bola block`);
    assert.ok(route.bola.objectType, `${route.route} has no objectType`);
    assert.ok(
      route.bola.deny.length > 0,
      `${route.route} declares no denial status`,
    );
    assert.ok(
      !route.bola.deny.includes(200),
      `${route.route} accepts 200 as a denial, which would pass on a real BOLA`,
    );
  }
});

test("the catalogue routes are NOT classified as user-scoped", () => {
  // A heuristic based on "has a path parameter" would misclassify these, which
  // is the whole argument for an explicit annotation.
  const m = JSON.parse(matrixOf("pullfm-v1.example.json").stdout);
  const artist = m.routes.find((r) => r.route === "GET /v1/artists/{mbid}");
  assert.equal(artist.authz, "authenticated-shared");
  assert.equal(artist.requiresBolaTest, false);
});

test("DELETE /v1/me IS classified as user-scoped despite having no path parameter", () => {
  const m = JSON.parse(matrixOf("pullfm-v1.example.json").stdout);
  const del = m.routes.find((r) => r.route === "DELETE /v1/me");
  assert.equal(del.authz, "user-scoped");
  assert.equal(del.bola.strategy, "implicit-subject");
});

test("an unclassified route fails enumeration (the Gate 3 clause)", () => {
  const r = matrixOf("unclassified-route.json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GET \/v1\/wishlist\/\{id\}/);
  assert.match(r.stderr, /unclassified/i);
});

test("a user-scoped route with no BOLA descriptor fails", () => {
  const r = matrixOf("missing-bola-block.json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /x-pullfm-bola/);
});

test("a BOLA param that is not a real path parameter fails", () => {
  const r = matrixOf("bad-bola-param.json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a declared path parameter/);
});

test("declaring 200 as an acceptable denial fails", () => {
  const r = matrixOf("bad-deny-status.json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /deny/);
});

test("a $ref path item is refused rather than silently skipped", () => {
  const r = matrixOf("path-ref.json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\$ref/);
});

test("the pruner removes exactly the operations marked exclude", () => {
  const out = resolve(FIXTURES, "..", "..", "..", ".pruned-spec.tmp.json");
  const r = run(PRUNER, [SPEC, out, "--quiet"]);
  assert.equal(r.code, 0, r.stderr);

  const pruned = JSON.parse(readFileSync(out, "utf8"));
  const removed = pruned.info["x-pullfm-dast-pruned"].removedOperations;

  // The destructive operations that would end the scan session.
  assert.ok(removed.includes("DELETE /v1/me"));
  assert.ok(removed.includes("DELETE /v1/connections/{service}"));
  // The operations that would drive real third-party traffic.
  assert.ok(removed.includes("POST /v1/connections/{service}"));
  assert.ok(removed.includes("GET /v1/connections/{service}/callback"));
  // The one that generates a full personal-data export per hit.
  assert.ok(removed.includes("GET /v1/me/export"));

  // GET /v1/me must survive: it is the plan's authentication sanity check, and
  // it shares a path with DELETE /v1/me. This is the assertion that proves the
  // pruning is method-aware, which is the entire reason the script exists.
  assert.ok(
    pruned.paths["/v1/me"]?.get,
    "GET /v1/me was removed along with DELETE",
  );
  assert.ok(!pruned.paths["/v1/me"]?.delete, "DELETE /v1/me survived");

  // /metrics stays in scope on purpose: detecting that it answers from the
  // public edge is a finding we want.
  assert.ok(pruned.paths["/metrics"]?.get);

  // A path whose only operation was excluded is dropped entirely, so ZAP does
  // not request a bare path the API never declared.
  assert.ok(!pruned.paths["/v1/connections/{service}/callback"]);

  execFileSync("/bin/rm", ["-f", out]);
});

test("an operation with no DAST disposition fails the pruner", () => {
  const r = run(PRUNER, [
    resolve(FIXTURES, "missing-dast-annotation.json"),
    "/dev/null",
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /x-pullfm-dast/);
});

test("the pruned spec still enumerates, so both tools agree on the same document", () => {
  const out = resolve(FIXTURES, "..", "..", "..", ".pruned-spec2.tmp.json");
  assert.equal(run(PRUNER, [SPEC, out, "--quiet"]).code, 0);
  const r = run(MATRIX, [out]);
  assert.equal(r.code, 0, r.stderr);
  execFileSync("/bin/rm", ["-f", out]);
});
