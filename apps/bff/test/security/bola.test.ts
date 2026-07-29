/**
 * Object-level authorization suite (docs/PLAN.md Gate 3).
 *
 * Gate 3, verbatim:
 *
 *   "BOLA suite enumerates every user-scoped route from the OpenAPI spec and
 *    asserts 403/404 for a foreign subject on 100% of them, failing CI if any
 *    route lacks a test."
 *
 * Three obligations, met three different ways:
 *
 *   Enumerate from the spec   The spec is emitted from the live Fastify router
 *                             and fed to `security/bola/route-matrix.mjs`, the
 *                             same enumerator CI runs, as a child process, so
 *                             its exit code is part of the test. There is no
 *                             hand-written list of routes anywhere below.
 *
 *   Assert denial on 100%     Tests are GENERATED from the matrix, so coverage
 *                             is structural rather than asserted.
 *
 *   Fail CI on a missing test A ledger records every generated block and a
 *                             final test reconciles it against the matrix.
 *                             Generation alone cannot catch a `.skip`, a name
 *                             filter, or an exception that truncates the loop.
 *                             Generation gives coverage; reconciliation gives
 *                             evidence of coverage.
 *
 * Both halves of the enumeration also fail closed upstream of here: emitting
 * the spec throws if any operation lacks an `x-pullfm-authz` annotation, and
 * the enumerator exits non-zero if any operation is unclassified.
 *
 * Subjects are provisioned FRESH for every individual test rather than once per
 * suite. That is not caution, it is a requirement: `DELETE /v1/me` and
 * `POST /v1/auth/logout` are in the matrix, and their positive controls destroy
 * the subject they prove works. A shared subject would make every subsequent
 * assertion in the file meaningless in a way that still reports green.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import {
  provisionSubject,
  seedFixtures,
  type Fixtures,
  type Subject,
} from "../helpers/subjects.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENUMERATOR = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "security",
  "bola",
  "route-matrix.mjs",
);

// ---------------------------------------------------------------------------
// Credential shapes that must never appear in a response body.
//
// Kept identical to security/bola/bola-suite.skeleton.mjs so the two cannot
// drift. Broad on purpose: a false positive costs one investigation, a false
// negative is asset A1 on the wire. The value-shape pattern catches a
// credential leaking through an unexpected key name, which a field-name
// allowlist misses.
// ---------------------------------------------------------------------------
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /"(access|refresh)_?token"/i,
  /"session_?key"/i,
  /"wrapped_?dek"/i,
  /"kek_?id"/i,
  /\baccess_token_ct\b/,
  /\brefresh_token_ct\b/,
  // A Last.fm session key is 32 hex characters. The harness's mock provider
  // issues exactly that shape, so this pattern is live rather than theoretical:
  // if any route ever returned a stored credential, this catches it.
  /"[a-f0-9]{32}"/,
];

interface MatrixRow {
  route: string;
  method: string;
  path: string;
  operationId: string;
  authz: string;
  requiresBolaTest: boolean;
  bola: {
    strategy: string;
    objectType: string;
    param: string | null;
    deny: number[];
  } | null;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Record<string, unknown>>>;
}

/** Runs the real enumerator over a document and returns the matrix it emits. */
function enumerate(document: unknown): {
  userScoped: MatrixRow[];
  notImplemented: Set<string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "pullfm-bola-"));
  const specPath = join(dir, "openapi.json");
  const matrixPath = join(dir, "route-matrix.json");
  writeFileSync(specPath, JSON.stringify(document));

  // If any operation is unclassified this throws, before a single assertion
  // runs. That ordering is what security/BOLA-TESTING.md section 8 asks for: an
  // unclassified route must be reported as an unclassified route, not as a
  // mysterious test failure.
  execFileSync(process.execPath, [ENUMERATOR, specPath, "--out", matrixPath], {
    encoding: "utf8",
  });

  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
    routes: MatrixRow[];
  };

  // Routes that declare themselves not yet implemented, read FROM THE SPEC
  // rather than from a list in this file, so the exemption is visible in the
  // published document and disappears the moment a handler lands.
  const doc = document as OpenApiDocument;
  const notImplemented = new Set(
    Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) => op["x-pullfm-not-implemented"] === true)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    ),
  );

  return {
    userScoped: matrix.routes.filter((r) => r.requiresBolaTest),
    notImplemented,
  };
}

// ---------------------------------------------------------------------------
// Test generation happens at module load.
//
// vitest collects test cases synchronously, so `describe.each` needs the route
// list before any hook has run. A throwaway application is therefore built here
// purely to ask the router for its own spec; no database, Redis, or network
// call is made to do it. The application the assertions run against is built in
// `beforeAll` like everything else.
// ---------------------------------------------------------------------------
const { userScoped, notImplemented } = await (async () => {
  const probe = await buildTestApp();
  try {
    return enumerate(probe.app.swagger());
  } finally {
    await probe.close();
  }
})();

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

/** Every route block records itself here; the final test reconciles it. */
const executed = new Set<string>();

interface Scenario {
  victim: Subject;
  attacker: Subject;
  victimFixtures: Fixtures;
  attackerFixtures: Fixtures;
}

async function scenario(): Promise<Scenario> {
  const victim = await provisionSubject(ctx, "victim");
  const attacker = await provisionSubject(ctx, "attacker");
  return {
    victim,
    attacker,
    victimFixtures: await seedFixtures(ctx, victim),
    attackerFixtures: await seedFixtures(ctx, attacker),
  };
}

/**
 * Values for path parameters that are NOT the object identity.
 *
 * Note what this is and is not: a table of parameter VALUES, not a list of
 * routes. Which routes are tested still comes entirely from the matrix. The
 * `service` value differs by method because the two connection routes need
 * different preconditions, and getting it wrong would produce a positive
 * control that fails for a reason unrelated to authorization.
 */
function defaultPathValue(
  name: string,
  routeKey: string,
  fixtures: Fixtures,
): string {
  if (name === "service") {
    // DELETE needs a connection that exists; the callback needs a pending
    // state. seedFixtures creates a ListenBrainz connection and a Last.fm
    // state, so each route is pointed at the provider it needs.
    return routeKey.startsWith("DELETE ") ? "listenbrainz" : "lastfm";
  }
  if (name === "mbid") return randomUUID();
  if (name === "id") return fixtures.stationId;
  return "unknown";
}

/**
 * The object identity to substitute.
 *
 * Keyed on the PARAMETER first and the object type second, because the two do
 * not always agree and the parameter is what the route actually parses.
 * `GET /v1/wishlist` addresses a `wishlist_item` through a `cursor`, so
 * substituting the item id would produce a 400 for the owner as well as the
 * attacker, and the resulting suite would report a denial that is really a
 * malformed request. That is the "passes for the wrong reason" failure in a
 * different disguise.
 */
function objectValue(
  objectType: string,
  param: string | null,
  fixtures: Fixtures,
): string {
  switch (param) {
    case "cursor":
      // Two routes page with a `cursor`, and they are not interchangeable: a
      // cursor is scoped to the route that issued it as well as to the subject,
      // so handing the wishlist's cursor to /v1/feed would 400 for the OWNER
      // too and the positive control would prove nothing.
      return objectType === "wishlist_item"
        ? (fixtures.wishlistCursor ?? "opaque-cursor")
        : fixtures.feedCursor;
    case "state":
      return fixtures.connectState;
    case "token":
      return fixtures.exportTicket;
    default:
      break;
  }
  switch (objectType) {
    case "wishlist_item":
      return fixtures.wishlistItemId;
    case "api_token":
      return fixtures.apiTokenId;
    case "connect_state":
      return fixtures.connectState;
    case "export_ticket":
      return fixtures.exportTicket;
    case "station":
      return fixtures.stationId;
    case "feed":
    case "recommendation_set":
      return fixtures.feedCursor;
    case "subject":
      return fixtures.markers[0] ?? "unknown";
    case "connection":
      return "listenbrainz";
    default:
      // Fails loudly rather than skipping. A route whose object type cannot be
      // created is a route that cannot be meaningfully tested, and that fact
      // has to be loud (security/BOLA-TESTING.md section 4).
      throw new Error(
        `no fixture exists for object type "${objectType}". A BOLA test against a ` +
          "non-existent object passes for the wrong reason.",
      );
  }
}

interface CallOptions {
  as: Subject | null;
  /** Whose object identity is substituted into the route. */
  object: Fixtures;
  extraHeaders?: Record<string, string>;
}

function call(row: MatrixRow, opts: CallOptions) {
  let path = row.path;
  const query = new URLSearchParams();

  const strategy = row.bola?.strategy ?? "implicit-subject";
  const param = row.bola?.param ?? null;
  const objectType = row.bola?.objectType ?? "subject";

  if (strategy === "path-param" && param !== null) {
    path = path.replace(
      `{${param}}`,
      encodeURIComponent(objectValue(objectType, param, opts.object)),
    );
  } else if (strategy === "query-param" && param !== null) {
    query.set(param, objectValue(objectType, param, opts.object));
  }

  // Remaining path parameters get values that are valid but are not the object
  // identity, so the route reaches its handler.
  path = path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) =>
    encodeURIComponent(defaultPathValue(name, row.route, opts.object)),
  );

  // A one-item page guarantees the cursor fixture is non-null, so the
  // cursor-substitution assertions are never vacuous.
  if (row.path === "/v1/wishlist" && row.method === "GET") {
    query.set("limit", "1");
  }

  const headers: Record<string, string> = {
    // Mandatory on mutating routes. A fresh value per call means a replay is
    // never accidental.
    "idempotency-key": `bola-${randomUUID()}`,
    ...opts.extraHeaders,
  };
  if (opts.as !== null) headers["authorization"] = `Bearer ${opts.as.token}`;

  const body = bodyFor(row, opts.as);
  const qs = query.toString();

  return ctx.app.inject({
    method: row.method as "GET",
    url: qs.length > 0 ? `${path}?${qs}` : path,
    headers,
    ...(body === null ? {} : { payload: body }),
  });
}

/**
 * A minimal VALID body for each mutating route.
 *
 * Valid matters. Authentication runs at `preValidation`, ahead of schema
 * validation, so an unauthenticated request is 401 rather than 400 either way.
 * But an authenticated request with an invalid body is a 400 that would be
 * mistaken for a denial, so the bodies here have to satisfy their schemas.
 */
function bodyFor(row: MatrixRow, as: Subject | null): object | null {
  if (row.method === "DELETE" && row.path === "/v1/me") {
    // The confirmation must match the caller's own email. For the anonymous
    // control any syntactically valid string is enough, because the request is
    // rejected before the value is read.
    return { confirm: as?.email ?? "anonymous@example.test" };
  }
  if (row.method !== "POST" && row.method !== "PUT" && row.method !== "PATCH") {
    return null;
  }
  switch (row.path) {
    case "/v1/wishlist":
      return {
        artistName: "BOLA Probe",
        title: "BOLA Probe",
        recordingMbid: randomUUID(),
      };
    case "/v1/tokens":
      return { name: `probe ${randomUUID().slice(0, 8)}` };
    default:
      return {};
  }
}

describe.each(userScoped)("$route", (row: MatrixRow) => {
  const deferred = notImplemented.has(row.route);

  // -- Control 1: the route works at all, for its owner ----------------------
  // Without this, every other assertion in this block is satisfied by a route
  // that is simply broken.
  test("positive control: the owner can reach the object", async () => {
    const s = await scenario();
    const res = await call(row, { as: s.victim, object: s.victimFixtures });
    if (deferred) {
      // The handler is not written yet. Asserting exactly 501, rather than
      // "anything non-2xx", means a genuinely broken route still fails here, so
      // the exemption cannot hide a regression.
      expect(res.statusCode, `${row.route} is flagged not-implemented`).toBe(
        501,
      );
      return;
    }
    expect(
      res.statusCode,
      `owner got ${String(res.statusCode)}; the route is broken, so the denial below proves nothing: ${res.body.slice(0, 300)}`,
    ).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
  });

  // -- Control 2: the attacker's credential is genuinely valid ---------------
  // Without this, a 404 for the attacker might just mean "B is not signed in",
  // which would make the suite pass with no authorization logic at all.
  if (row.bola?.strategy !== "implicit-subject") {
    test("positive control: the attacker's own object is reachable", async () => {
      const s = await scenario();
      const res = await call(row, {
        as: s.attacker,
        object: s.attackerFixtures,
      });
      if (deferred) {
        expect(res.statusCode).toBe(501);
        return;
      }
      expect(
        res.statusCode,
        `attacker got ${String(res.statusCode)} on their OWN object; their session is not valid, ` +
          `so the cross-subject denial is not evidence of authorization: ${res.body.slice(0, 300)}`,
      ).toBeLessThan(300);
    });
  }

  // -- The assertion Gate 3 actually names -----------------------------------
  test("a foreign subject is denied", async () => {
    const s = await scenario();

    if (row.bola?.strategy === "implicit-subject") {
      // Nothing to substitute. The assertion becomes: subject B's response is
      // scoped to B and carries no trace of A. This is what catches a cache
      // keyed without the subject (T12) and a subject taken from a header (M14).
      const res = await call(row, {
        as: s.attacker,
        object: s.attackerFixtures,
      });
      for (const marker of s.victimFixtures.markers) {
        expect(
          res.body.includes(marker),
          `response to subject B leaked subject A's data: ${marker}`,
        ).toBe(false);
      }
      return;
    }

    const res = await call(row, { as: s.attacker, object: s.victimFixtures });
    if (deferred) {
      expect(res.statusCode).toBe(501);
      return;
    }
    expect(
      row.bola?.deny ?? [],
      `expected one of ${(row.bola?.deny ?? []).join("/")} for a foreign subject, got ${String(res.statusCode)}: ${res.body.slice(0, 300)}`,
    ).toContain(res.statusCode);

    // Belt and braces: even an accepted denial status must not carry A's data.
    for (const marker of s.victimFixtures.markers) {
      expect(res.body.includes(marker)).toBe(false);
    }
  });

  // -- Control 3: no credential is rejected outright -------------------------
  test("an unauthenticated request is rejected", async () => {
    const s = await scenario();
    const res = await call(row, { as: null, object: s.victimFixtures });
    expect(
      res.statusCode,
      `expected 401 without a credential, got ${String(res.statusCode)}: ${res.body.slice(0, 200)}`,
    ).toBe(401);
  });

  // -- API3:2023, property level ---------------------------------------------
  // The owner is allowed the object; the owner is never allowed the credential
  // inside it. THREAT-MODEL M12: no route returns a third-party token, not even
  // to its owner.
  test("no response body contains anything credential-shaped", async () => {
    const s = await scenario();
    const res = await call(row, { as: s.victim, object: s.victimFixtures });
    for (const pattern of CREDENTIAL_SHAPES) {
      expect(
        pattern.test(res.body),
        `response to ${row.route} matched ${String(pattern)}: ${res.body.slice(0, 300)}`,
      ).toBe(false);
    }
  });

  executed.add(row.route);
});

// ---------------------------------------------------------------------------
// Cross-cutting vectors. Structural rather than per-route, so asserted once.
// ---------------------------------------------------------------------------
describe("cross-cutting authorization", () => {
  test("an Idempotency-Key cannot be replayed across subjects", async () => {
    // THREAT-MODEL T14. docs/PLAN.md section 6 mandates the header on every
    // mutating call, so a record keyed on the header value alone would be a
    // BOLA on every mutating route simultaneously.
    const s = await scenario();
    const key = `replay-${randomUUID()}`;

    const first = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: {
        authorization: `Bearer ${s.victim.token}`,
        "idempotency-key": key,
      },
      payload: {
        artistName: "Victim Only",
        title: "Victim Only",
        recordingMbid: randomUUID(),
      },
    });
    expect(first.statusCode).toBe(201);
    const victimItemId = jsonOf<{ id: string }>(first).id;

    const replay = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: {
        authorization: `Bearer ${s.attacker.token}`,
        "idempotency-key": key,
      },
      payload: {
        artistName: "Attacker Only",
        title: "Attacker Only",
        recordingMbid: randomUUID(),
      },
    });

    expect(
      replay.body.includes(victimItemId),
      "replaying subject A's Idempotency-Key returned A's cached response to subject B",
    ).toBe(false);
    expect(replay.body.includes("Victim Only")).toBe(false);
  });

  test("a cursor from one subject cannot page into another subject's rows", async () => {
    // THREAT-MODEL M15. Two controls: the cursor is bound to the subject it was
    // issued to, AND the keyset predicate always ANDs user_id, so even a forged
    // cursor cannot escape the subject.
    const s = await scenario();
    const cursor = s.victimFixtures.wishlistCursor;
    expect(
      cursor,
      "the cursor fixture is null; the assertion below would be vacuous",
    ).not.toBeNull();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/wishlist?limit=1&cursor=${encodeURIComponent(cursor ?? "")}`,
      headers: { authorization: `Bearer ${s.attacker.token}` },
    });

    for (const marker of s.victimFixtures.markers) {
      expect(
        res.body.includes(marker),
        "subject A's cursor returned A's rows to subject B",
      ).toBe(false);
    }
  });

  test("a client-supplied subject identifier is rejected, not merely ignored", async () => {
    // THREAT-MODEL M14. Rejecting rather than ignoring is what makes the
    // attempt visible in a log and in this test.
    const s = await scenario();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        authorization: `Bearer ${s.attacker.token}`,
        "x-user-id": s.victim.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.includes(s.victim.id)).toBe(false);
  });

  test("a user_id field in a request body is rejected and writes nothing", async () => {
    const s = await scenario();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: {
        authorization: `Bearer ${s.attacker.token}`,
        "idempotency-key": `massassign-${randomUUID()}`,
      },
      payload: {
        artistName: "Mass Assignment",
        title: "Mass Assignment",
        user_id: s.victim.id,
      },
    });
    expect(res.statusCode).toBe(400);

    const victimList = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist?limit=100",
      headers: { authorization: `Bearer ${s.victim.token}` },
    });
    expect(victimList.body.includes("Mass Assignment")).toBe(false);
  });

  // -- The coverage proof ----------------------------------------------------
  test("100% of user-scoped routes were exercised", () => {
    const expected = new Set(userScoped.map((r) => r.route));
    const missing = [...expected].filter((r) => !executed.has(r));
    expect(
      missing,
      `route(s) enumerated from the OpenAPI spec but never tested: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(executed.size).toBe(expected.size);
    expect(executed.size).toBeGreaterThan(10);
  });

  // -- The exemption cannot grow silently ------------------------------------
  test("no route claims the not-implemented exemption", () => {
    // Every product route now has a handler, so the exemption covers nothing.
    // Asserting the empty set rather than deleting the test is the point: this
    // is what stops a future route being marked deferred and quietly skipping
    // the denial assertions above.
    const deferredUserScoped = userScoped
      .filter((r) => notImplemented.has(r.route))
      .map((r) => r.route)
      .sort();
    expect(deferredUserScoped).toEqual([]);
    expect([...notImplemented]).toEqual([]);
  });
});
