// ---------------------------------------------------------------------------
// Pull.fm - BOLA / object-level authorization suite  (REFERENCE SKELETON)
//
// STATUS: this is a specification in executable form, not a working test. The
// BFF's handlers and auth plugin are Phase 2 work (docs/PLAN.md), so the harness
// functions at the bottom throw. When they land, this file moves to
// apps/bff/test/security/bola.test.ts, the harness is implemented against the
// real app, and the body of the suite should need no changes. Keeping it here
// now means the design is reviewable before there is code to argue about.
//
// The rationale, the failure modes it defends against, and the coverage proof
// are in security/BOLA-TESTING.md. Read that first; this file is the mechanism.
//
// Deliberately NOT named *.test.mjs so `node --test` does not pick it up and
// fail the build on a file that is documentation.
// ---------------------------------------------------------------------------

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MATRIX_PATH =
  process.env.PULLFM_BOLA_MATRIX ?? "security/bola/route-matrix.json";
const BASE_URL = process.env.PULLFM_BOLA_BASE_URL ?? "http://127.0.0.1:3000";

// The canary makes the suite prove it can fail. See BOLA-TESTING.md §7.
const CANARY = process.env.PULLFM_BOLA_CANARY === "1";

const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
const userScoped = matrix.routes.filter((r) => r.requiresBolaTest);

// Coverage ledger. Every generated test records itself here, and the final
// assertion compares the ledger against the matrix. Without this, a `.skip`, a
// filter, or an exception during test generation silently shrinks the suite
// while the build stays green.
const executed = new Set();

let victim; // subject A: owns every fixture object
let attacker; // subject B: owns its own copy of each object, and nothing of A's
let fixtures; // { [objectType]: { victimId, attackerId } }

before(async () => {
  victim = await provisionSubject("victim");
  attacker = await provisionSubject("attacker");
  fixtures = await seedFixtures(victim, attacker);

  // Fail loudly if a route's object type has no fixture. Without this, the
  // "foreign subject is denied" assertion passes trivially because the object
  // does not exist, and the suite reports full coverage of nothing. This is the
  // single most common way a BOLA suite is worthless.
  const missing = [
    ...new Set(
      userScoped.map((r) => r.bola.objectType).filter((t) => !(t in fixtures)),
    ),
  ];
  assert.deepEqual(
    missing,
    [],
    `no subject-A fixture exists for object type(s): ${missing.join(", ")}. ` +
      "A BOLA test against a non-existent object passes for the wrong reason.",
  );
});

describe("object-level authorization (Gate 3)", () => {
  for (const route of userScoped) {
    describe(route.route, () => {
      // -- Control 1: the route works at all, for its owner ------------------
      // Without this, every other assertion in this block is satisfied by a
      // route that is simply broken.
      test("positive control: the owner can reach the object", async () => {
        const res = await call(route, { as: victim, object: "victim" });
        assert.ok(
          res.status >= 200 && res.status < 300,
          `owner got ${res.status}; the route is broken, so the denial below proves nothing`,
        );
      });

      // -- Control 2: the attacker's credential is genuinely valid -----------
      // Without this, a 403 for the attacker might just mean "B is not logged
      // in", which would make the suite pass even with no authorization logic
      // at all.
      if (route.bola.strategy !== "implicit-subject") {
        test("positive control: the attacker's own object is reachable", async () => {
          const res = await call(route, { as: attacker, object: "attacker" });
          assert.ok(
            res.status >= 200 && res.status < 300,
            `attacker got ${res.status} on their OWN object; their session is not valid, ` +
              "so the cross-subject denial below is not evidence of authorization",
          );
        });
      }

      // -- The assertion Gate 3 actually names -------------------------------
      test("a foreign subject is denied", async () => {
        const res =
          route.bola.strategy === "implicit-subject"
            ? await call(route, { as: attacker, object: "attacker" })
            : await call(route, { as: attacker, object: "victim" });

        if (route.bola.strategy === "implicit-subject") {
          // Nothing to substitute: assert instead that the response is scoped
          // to B and contains no trace of A.
          const body = await res.text();
          assert.ok(
            !body.includes(victim.id),
            `response to subject B mentions subject A's id (${victim.id})`,
          );
          for (const marker of fixtures[route.bola.objectType]?.victimMarkers ??
            []) {
            assert.ok(
              !body.includes(marker),
              `response to B leaked A's data: ${marker}`,
            );
          }
        } else {
          assert.ok(
            route.bola.deny.includes(res.status),
            `expected one of ${route.bola.deny.join("/")} for a foreign subject, got ${res.status}`,
          );
        }
      });

      // -- Control 3: no credential is rejected outright ---------------------
      test("an unauthenticated request is rejected", async () => {
        const res = await call(route, { as: null, object: "victim" });
        assert.equal(
          res.status,
          401,
          `expected 401 without a credential, got ${res.status}`,
        );
      });

      // -- API3:2023, property level -----------------------------------------
      // The owner is allowed the object; the owner is never allowed the
      // credential inside it. THREAT-MODEL.md M12: no route returns a token,
      // not even to its owner.
      test("no response body contains anything credential-shaped", async () => {
        const res = await call(route, { as: victim, object: "victim" });
        const body = await res.text();
        for (const pattern of CREDENTIAL_SHAPES) {
          assert.doesNotMatch(body, pattern, `response matched ${pattern}`);
        }
      });

      executed.add(route.route);
    });
  }

  // -- Cross-cutting: the shapes that are not per-route ---------------------

  test("an Idempotency-Key cannot be replayed across subjects", async () => {
    // THREAT-MODEL.md T14. docs/PLAN.md §6 mandates Idempotency-Key on every
    // mutating call, so a cache keyed on the header value alone is a BOLA on
    // every mutating route simultaneously.
    const key = `bola-${Date.now()}`;
    const first = await call(
      { method: "POST", path: "/v1/wishlist" },
      {
        as: victim,
        headers: { "Idempotency-Key": key },
        body: { mbid: fixtures.wishlist_item.victimMbid },
      },
    );
    assert.ok(first.status >= 200 && first.status < 300);

    const replay = await call(
      { method: "POST", path: "/v1/wishlist" },
      {
        as: attacker,
        headers: { "Idempotency-Key": key },
        body: { mbid: fixtures.wishlist_item.attackerMbid },
      },
    );
    const body = await replay.text();
    assert.ok(
      !body.includes(fixtures.wishlist_item.victimId),
      "replaying subject A's Idempotency-Key returned A's cached response to subject B",
    );
  });

  test("a cursor from one subject cannot page into another subject's rows", async () => {
    // THREAT-MODEL.md M15. Even if cursor signing is bypassed, the keyset
    // predicate must still AND user_id = $subject.
    const page = await call(
      { method: "GET", path: "/v1/wishlist" },
      { as: victim },
    );
    const { cursor } = await page.json();
    if (!cursor) return; // fewer rows than a page; nothing to test

    const res = await call(
      { method: "GET", path: "/v1/wishlist" },
      { as: attacker, query: { cursor } },
    );
    const body = await res.text();
    assert.ok(
      !body.includes(fixtures.wishlist_item.victimId),
      "subject A's cursor returned A's rows to subject B",
    );
  });

  test("a client-supplied subject identifier is ignored", async () => {
    // THREAT-MODEL.md M14. The subject comes from the verified JWT, never from
    // a header or a body field.
    const res = await call(
      { method: "GET", path: "/v1/me" },
      { as: attacker, headers: { "X-User-Id": victim.id } },
    );
    const body = await res.text();
    assert.ok(!body.includes(victim.id), "X-User-Id was honoured");
  });

  // -- The coverage proof ----------------------------------------------------
  test("100% of user-scoped routes were exercised", () => {
    const expected = new Set(userScoped.map((r) => r.route));
    const missing = [...expected].filter((r) => !executed.has(r));
    assert.deepEqual(
      missing,
      [],
      `route(s) enumerated from the OpenAPI spec but never tested: ${missing.join(", ")}`,
    );
    assert.equal(executed.size, expected.size);
  });

  // -- The suite's own negative control -------------------------------------
  test("the suite is capable of failing", { skip: !CANARY }, async () => {
    // Run with PULLFM_BOLA_CANARY=1 against a build that mounts a deliberately
    // vulnerable route (one that omits the owner predicate). If this passes,
    // the harness cannot detect a BOLA and every green run above is
    // meaningless. See BOLA-TESTING.md §7.
    const res = await call(
      {
        method: "GET",
        path: "/__canary__/wishlist/{id}",
        bola: { strategy: "path-param", param: "id" },
      },
      { as: attacker, object: "victim" },
    );
    assert.ok(
      res.status >= 200 && res.status < 300,
      "the canary route is supposed to be vulnerable; if it denies, the canary is not wired up",
    );
  });
});

// ---------------------------------------------------------------------------
// Credential shapes that must never appear in a response body.
// Deliberately broad: a false positive here costs one investigation, a false
// negative is asset A1 on the wire.
// ---------------------------------------------------------------------------
const CREDENTIAL_SHAPES = [
  /"(access|refresh)_?token"/i,
  /"session_?key"/i,
  /"wrapped_?dek"/i,
  /"kek_?id"/i,
  /\baccess_token_ct\b/,
  /\brefresh_token_ct\b/,
  // Last.fm session keys are 32 hex characters. Matching the shape rather than
  // the field name catches a value that leaks through an unexpected key.
  /"[a-f0-9]{32}"/,
];

// ---------------------------------------------------------------------------
// Harness. Implement these against the BFF; everything above stays as-is.
// ---------------------------------------------------------------------------

/**
 * Create a real subject and return { id, token }.
 *
 * See BOLA-TESTING.md §3 for the two options and why the JWKS seam is chosen
 * for CI. Whatever is implemented here MUST leave the authorization code path
 * (the thing under test) completely unmodified.
 */
async function provisionSubject(_role) {
  throw new Error("not implemented: see BOLA-TESTING.md §3");
}

/**
 * Create, for every objectType named in the matrix, one object owned by the
 * victim and one owned by the attacker. Returns a map keyed by objectType.
 * Must go through the public API, not direct SQL, so that a route which cannot
 * create its own fixture is discovered here rather than assumed away.
 */
async function seedFixtures(_victim, _attacker) {
  throw new Error("not implemented: see BOLA-TESTING.md §4");
}

/**
 * Issue one request. `object` selects whose identifier is substituted into the
 * route according to route.bola.strategy: "victim" or "attacker".
 */
async function call(_route, _opts) {
  throw new Error("not implemented: see BOLA-TESTING.md §5");
}

export { BASE_URL, CREDENTIAL_SHAPES };
