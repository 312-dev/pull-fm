/**
 * The DAST upstream-egress register must describe the API that exists.
 *
 * WHY THIS RUNS IN CI, AGAINST THE REAL ROUTER
 *
 * MusicBrainz permits 1 request per second GLOBALLY per IP and revokes without
 * appeal; docs/PLAN.md section 8 calls exceeding it product-ending. The control
 * that keeps a DAST crawler away from every provider is
 * `security/zap/upstream-scope.tsv`, which classifies each operation as `none`,
 * `subject-gated` or `egress`, and `security/zap/scripts/scope-upstream.mjs`,
 * which removes the last two from the spec ZAP imports.
 *
 * A register only works if it cannot fall behind the router. So this reconciles
 * the two in BOTH directions at PR time: an operation with no classification
 * fails, and a classification with no operation fails. Adding a route therefore
 * costs one line and one decision, and forgetting to make that decision is a
 * red build rather than an unthrottled scanner pointed at a provider that can
 * end the project.
 *
 * WHY THE REGISTER EXISTS SEPARATELY FROM `x-pullfm-dast`
 *
 * `x-pullfm-dast: include | exclude` answers "would the scanner destroy the
 * subject it is testing?" It was being trusted for a second question it never
 * answered: "can the scanner reach a third party?" Three operations annotated
 * `include` egress to a provider on scanner-shaped input, and
 * `GET /v1/artists/{mbid}/similar` does it for ANY well-formed UUID with no
 * existence check, which is a guaranteed cache miss and therefore a guaranteed
 * outbound call. That gap is the reason for this file.
 *
 * The stronger fix is to make egress a required field of `PullfmAnnotations`
 * next to `dast`, so the classification lives where the fetch lives. This test
 * gives the same fail-closed property in the meantime; see the header of
 * security/zap/upstream-scope.tsv.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const SCOPER = join(REPO, "security", "zap", "scripts", "scope-upstream.mjs");
const PRUNER = join(REPO, "security", "zap", "scripts", "prune-openapi.mjs");

let ctx: TestApp;
let spec: Record<string, unknown>;

beforeAll(async () => {
  ctx = await buildTestApp();
  const res = await ctx.app.inject({ method: "GET", url: "/openapi.json" });
  expect(res.statusCode).toBe(200);
  spec = JSON.parse(res.body) as Record<string, unknown>;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

function run(args: readonly string[]): { stdout: string; status: number } {
  try {
    return {
      stdout: execFileSync(process.execPath, args, { encoding: "utf8" }),
      status: 0,
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      status: e.status ?? 1,
    };
  }
}

function scope(document: unknown, extra: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "pullfm-scope-"));
  const inPath = join(dir, "openapi.json");
  const outPath = join(dir, "scoped.json");
  writeFileSync(inPath, JSON.stringify(document));
  const result = run([SCOPER, inPath, outPath, "--quiet", ...extra]);
  return {
    ...result,
    read: () =>
      JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>,
  };
}

const operations = (doc: Record<string, unknown>): string[] => {
  const methods = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];
  const paths = doc["paths"] as Record<string, Record<string, unknown>>;
  return Object.entries(paths).flatMap(([path, item]) =>
    methods.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`),
  );
};

describe("upstream-egress register", () => {
  test("classifies every operation the router actually serves", () => {
    const result = scope(spec);
    expect(
      result.stdout,
      "security/zap/upstream-scope.tsv is out of step with the router. " +
        "Classify the operation(s) named above as none, subject-gated or egress " +
        "before they can be scanned.",
    ).not.toMatch(/UNSCOPED/);
    expect(result.status).toBe(0);
  });

  test("the register contains no rows for routes that no longer exist", () => {
    // Same run, opposite direction. A stale row means the register was written
    // against a spec that no longer exists, so nobody can say whether the rows
    // that remain still describe reality.
    const result = scope(spec);
    expect(result.stdout).not.toMatch(
      /is classified in .* but is not an operation/,
    );
  });

  test("the provider-reaching routes are absent from the scanned spec", () => {
    // Named explicitly rather than derived from the register, so that
    // downgrading one of these to `none` fails here instead of silently
    // widening the scan. These are the routes that can put traffic on a
    // provider's doorstep.
    const result = scope(spec, ["--allow-subject-gated"]);
    expect(result.status).toBe(0);
    const scanned = new Set(operations(result.read()));
    for (const route of [
      "POST /v1/connections/{service}",
      "GET /v1/connections/{service}/callback",
      "GET /v1/artists/{mbid}/similar",
      "GET /v1/tracks/{mbid}/preview",
      "GET /v1/artists/{mbid}/events",
    ]) {
      expect(
        scanned.has(route),
        `${route} must never be handed to a scanner`,
      ).toBe(false);
    }
  });

  test("subject-gated routes are excluded unless explicitly allowed", () => {
    const gated = "GET /v1/feed";
    expect(operations(scope(spec).read())).not.toContain(gated);
    expect(operations(scope(spec, ["--allow-subject-gated"]).read())).toContain(
      gated,
    );
  });

  test("an unclassified operation fails rather than defaulting", () => {
    // The convenient default is the one that gets our provider access revoked,
    // so prove the refusal rather than trusting the comment that describes it.
    const mutated = JSON.parse(JSON.stringify(spec)) as {
      paths: Record<string, Record<string, unknown>>;
    };
    mutated.paths["/v1/brand-new-route"] = {
      get: {
        responses: { 200: { description: "ok" } },
        "x-pullfm-dast": "include",
      },
    };
    const result = scope(mutated);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/GET \/v1\/brand-new-route/);
  });

  test("the pipeline still yields a non-empty spec, so a green scan is a real one", () => {
    // AUDIT-2026-07-29 F16: both spec-driven gates produced a confident green on
    // zero input. ZAP handed an empty document imports nothing and reports
    // clean, which is the worst available result. Run the real two-stage
    // pipeline and assert it produced something to scan.
    const dir = mkdtempSync(join(tmpdir(), "pullfm-pipeline-"));
    const raw = join(dir, "raw.json");
    const scoped = join(dir, "scoped.json");
    const safe = join(dir, "safe.json");
    writeFileSync(raw, JSON.stringify(spec));

    expect(
      run([SCOPER, raw, scoped, "--quiet", "--allow-subject-gated"]).status,
    ).toBe(0);
    expect(run([PRUNER, scoped, safe, "--quiet"]).status).toBe(0);

    const final = JSON.parse(readFileSync(safe, "utf8")) as Record<
      string,
      unknown
    >;
    const ops = operations(final);
    expect(ops.length).toBeGreaterThan(10);
    // The authenticated surface must survive both filters, or the scan is
    // unauthenticated in effect and tests the 401 handler.
    expect(ops).toContain("GET /v1/me");
  });
});
