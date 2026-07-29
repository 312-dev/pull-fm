/**
 * The OpenAPI document as an inventory (Gate 2, API9:2023).
 *
 * "The spec is the source of truth" is only true if a route cannot exist
 * without appearing in it and cannot appear in it without existing. Both
 * directions are asserted here, because each has a different failure:
 *
 *   Route not in the spec   invisible to the BOLA suite, which enumerates FROM
 *                           the spec. That is the API5 gap security/
 *                           BOLA-TESTING.md section 9 names explicitly.
 *   Spec entry with no route a published contract nobody can honour, which is
 *                           discovered by a client rather than by CI.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { toOpenApiPath } from "../../src/lib/openapi.js";

let ctx: TestApp;
let document: {
  openapi: string;
  info: { title: string; description?: string };
  components?: { securitySchemes?: Record<string, unknown> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

function operations(): { key: string; operation: Record<string, unknown> }[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${path}`,
        operation,
      })),
  );
}

beforeAll(async () => {
  ctx = await buildTestApp();
  document = ctx.app.swagger() as unknown as typeof document;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe("the document", () => {
  test("is OpenAPI 3.1", () => {
    expect(document.openapi).toMatch(/^3\.1/);
  });

  test("documents both credential types with a working example", () => {
    const schemes = document.components?.securitySchemes ?? {};
    expect(Object.keys(schemes).sort()).toEqual([
      "pullfmToken",
      "workosBearer",
    ]);
    const description = document.info.description ?? "";
    expect(description).toContain("pfm_live_");
    expect(description).toContain("curl");
    expect(description).toContain(
      "POST https://api.pull.fm/v1/tokens".slice(5),
    );
  });

  test("states the no-bulk-redistribution position", () => {
    // Last.fm and MusicBrainz licence their data for use, not redistribution.
    // A reader of the API reference has to be able to see that without reading
    // the repository.
    const description = document.info.description ?? "";
    expect(description).toMatch(/raw Last\.fm or MusicBrainz payloads/i);
  });
});

describe("the document is the inventory", () => {
  /**
   * Routes permitted to be absent from the document.
   *
   * AUDIT 2026-07-29, and this list exists because of what it found.
   * `schema: { hide: true }` is the one unguarded exit from the entire Gate 3
   * chain. `collectAnnotations` (src/lib/openapi.ts) returns early on it, so
   * the route is never classified; being absent from the swagger document it
   * is also never added to `unclassified`, so `applyAnnotations` does not
   * throw; and the filter below removes it from this inventory test. The
   * consequence is that a route added with `hide: true` produces zero BOLA
   * tests and a green build, which is precisely the outcome Gate 3 is written
   * to make impossible ("failing CI if any route lacks a test").
   *
   * That escape is not closed here, because a hidden route is sometimes
   * correct: `GET /openapi.json` cannot describe itself. It is made LOUD
   * instead. Adding a hidden route now fails this test, and the reviewer has
   * to state, in this file, why that route needs no authorization coverage.
   *
   * Adding an entry is a security decision, not a formality. It belongs here
   * only if the route is genuinely public and object-free.
   */
  const HIDDEN_ROUTE_ALLOWLIST = new Set([
    // The spec document itself. Public, static, and holds no user object.
    "GET /openapi.json",
  ]);

  test("no route hides itself out of the BOLA enumeration without review", () => {
    const hidden = ctx.routes
      .filter((r) => r.hidden && r.method !== "HEAD" && r.method !== "OPTIONS")
      .map((r) => `${r.method} ${toOpenApiPath(r.url)}`);

    const unreviewed = hidden.filter((r) => !HIDDEN_ROUTE_ALLOWLIST.has(r));
    expect(
      unreviewed,
      "route(s) use `schema: { hide: true }`, which removes them from the " +
        "OpenAPI document, from the route matrix, and from the BOLA suite, " +
        "with no error anywhere. If the route is genuinely public and holds " +
        "no user-owned object, add it to HIDDEN_ROUTE_ALLOWLIST with a reason. " +
        "Otherwise remove `hide` and annotate it: " +
        unreviewed.join(", "),
    ).toEqual([]);

    // And the allowlist itself must not rot: an entry for a route that no
    // longer exists is a standing permission nobody is looking at.
    const stale = [...HIDDEN_ROUTE_ALLOWLIST].filter(
      (r) => !hidden.includes(r),
    );
    expect(
      stale,
      `HIDDEN_ROUTE_ALLOWLIST names route(s) that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  test("every route in the router appears in the document", () => {
    // Fastify's own route table is the ground truth. Anything the emitter
    // dropped would be invisible to the BOLA enumerator.
    const documented = new Set(operations().map((o) => o.key));

    const routed = new Set(
      ctx.routes
        .filter(
          (r) => !r.hidden && r.method !== "HEAD" && r.method !== "OPTIONS",
        )
        .map((r) => `${r.method} ${toOpenApiPath(r.url)}`),
    );

    const missing = [...routed].filter((r) => !documented.has(r));
    expect(
      missing,
      `route(s) exist in the router but not in the OpenAPI document: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("every documented operation is reachable", async () => {
    // A documented route that does not exist answers 404 from the not-found
    // handler. Anything else, including 401, proves the route is mounted.
    for (const { key } of operations()) {
      const [method, path] = key.split(" ") as [string, string];
      const url = path.replace(
        /\{[^}]+\}/g,
        "00000000-0000-4000-8000-000000000000",
      );
      const res = await ctx.app.inject({
        method: method as "GET",
        url,
        headers: { "idempotency-key": `contract-${randomUUID()}` },
      });
      expect(res.statusCode, `${key} is documented but not mounted`).not.toBe(
        404,
      );
    }
  });
});

describe("annotations", () => {
  test("every operation is classified for authorization and for DAST", () => {
    // The emitter already refuses to produce a document with an unclassified
    // operation. This asserts the result, so a change to the emitter that
    // weakened the refusal is caught here rather than by the enumerator.
    const classes = new Set([
      "public",
      "authenticated-shared",
      "user-scoped",
      "system",
      "webhook",
    ]);
    for (const { key, operation } of operations()) {
      expect(classes, `${key} has no valid x-pullfm-authz`).toContain(
        operation["x-pullfm-authz"],
      );
      expect(
        ["include", "exclude"],
        `${key} has no valid x-pullfm-dast`,
      ).toContain(operation["x-pullfm-dast"]);
    }
  });

  test("every user-scoped operation declares how a foreign identity is substituted", () => {
    for (const { key, operation } of operations()) {
      if (operation["x-pullfm-authz"] !== "user-scoped") continue;
      const bola = operation["x-pullfm-bola"] as
        { strategy: string; objectType: string; deny: number[] } | undefined;
      expect(
        bola,
        `${key} is user-scoped with no BOLA descriptor`,
      ).toBeDefined();
      expect(bola?.deny.length).toBeGreaterThan(0);
      expect(bola?.objectType.length).toBeGreaterThan(0);
    }
  });

  test("the irreversible and credential-bearing routes are excluded from active DAST", () => {
    // ZAP drives every included operation with hostile input. Letting it drive
    // account deletion or the connect flow would destroy the environment it is
    // scanning and, for the connect flow, contact a third party.
    const excluded = operations()
      .filter((o) => o.operation["x-pullfm-dast"] === "exclude")
      .map((o) => o.key);
    for (const route of [
      // Sign-in. ZAP driving these with hostile input would spend the mail
      // budget of whatever address it invented, against a real identity
      // provider, and would trip its abuse controls on our account.
      "POST /v1/auth/start",
      "POST /v1/auth/verify",
      "DELETE /v1/me",
      "PATCH /v1/me",
      "GET /v1/me/export",
      "GET /v1/me/export/download",
      "POST /v1/tokens",
      "DELETE /v1/tokens/{id}",
      "POST /v1/tokens/{id}/rotate",
      "POST /v1/connections/{service}",
      "GET /v1/connections/{service}/callback",
      "DELETE /v1/connections/{service}",
      "GET /v1/auth/callback",
      "POST /v1/auth/refresh",
      "POST /v1/auth/logout",
    ]) {
      expect(
        excluded,
        `${route} is not excluded from active scanning`,
      ).toContain(route);
    }
  });
});

describe("response schemas (M12)", () => {
  test("no success response declares a property that could hold a credential", () => {
    // Fastify serialises with fast-json-stringify, which emits only declared
    // properties. So the absence of a property here is not documentation, it is
    // the enforcement: a handler that accidentally selected `access_token_ct`
    // could not put it on the wire.
    const forbidden =
      /^(access_?token|refresh_?token|session_?key|wrapped_?dek|kek_?id|token_hash|.*_ct)$/i;

    const walk = (node: unknown, where: string): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const properties = record["properties"];
      if (properties !== undefined && typeof properties === "object") {
        for (const name of Object.keys(properties as Record<string, unknown>)) {
          expect(
            forbidden.test(name),
            `${where} declares a credential-shaped property "${name}"`,
          ).toBe(false);
        }
      }
      for (const value of Object.values(record)) walk(value, where);
    };

    // The sign-in responses are the one place a session legitimately crosses
    // the wire: there is no way to hand a client a session without handing it a
    // session. They are `public` rather than `user-scoped` and are exempted
    // here by an explicit list rather than by an accident of naming, so the
    // exemption is reviewable and cannot grow without a diff.
    //
    // A cookie-transport sign-in returns none of these properties, but the
    // schema is shared with the bearer response and declares them, so the
    // exemption covers the schema rather than the behaviour.
    const sessionBearingOperations = new Set([
      "POST /v1/auth/verify",
      "GET /v1/auth/callback",
      "POST /v1/auth/refresh",
    ]);

    for (const { key, operation } of operations()) {
      const responses = operation["responses"] as
        Record<string, unknown> | undefined;
      if (responses === undefined) continue;
      for (const [status, response] of Object.entries(responses)) {
        if (sessionBearingOperations.has(key)) continue;
        if (Number(status) >= 300) continue;
        walk(response, `${key} ${status}`);
      }
    }
  });
});
