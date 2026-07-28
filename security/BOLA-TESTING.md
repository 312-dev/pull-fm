# BOLA / object-level authorization testing

**The requirement, verbatim from `docs/PLAN.md` §7, Gate 3:**

> BOLA suite enumerates every user-scoped route from the OpenAPI spec and asserts 403/404 for a
> foreign subject on 100% of them, failing CI if any route lacks a test.

That sentence contains three separate obligations, and they are usually met with one and a half.
This document is how all three are met here.

| #   | Obligation                                          | Mechanism                                                                                                                          |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Enumerate every user-scoped route **from the spec** | [`route-matrix.mjs`](bola/route-matrix.mjs) reads the OpenAPI 3.1 document and emits a machine-readable matrix                     |
| 2   | Assert denial for a foreign subject on 100%         | The suite generates its tests **from** that matrix, so coverage is structural rather than asserted                                 |
| 3   | **Fail CI if any route lacks a test**               | The enumerator rejects any operation that is not explicitly classified, and the suite reconciles executed tests against the matrix |

Artifacts:

- [`bola/route-matrix.mjs`](bola/route-matrix.mjs) - the enumerator. Working, tested, runnable today.
- [`bola/route-matrix.test.mjs`](bola/route-matrix.test.mjs) - its tests, including the negative
  cases that prove an unclassified route fails.
- [`bola/bola-suite.skeleton.mjs`](bola/bola-suite.skeleton.mjs) - the suite itself, as an
  executable specification. The BFF's handlers and auth plugin are Phase 2 work, so its three harness functions
  throw; the body is complete and should not need to change when they are implemented.
- [`testdata/openapi/`](testdata/openapi/) - a fixture spec covering the whole `PLAN.md` §6 surface,
  plus six negative fixtures.

---

## 1. Why this is the highest-priority test in the repository

`PLAN.md` §6 describes an API where essentially every route returns data belonging to exactly one
person. `/v1/me`, `/v1/connections`, `/v1/wishlist`, `/v1/feed`, `/v1/recommendations`,
`/v1/stations` are all subject-scoped; only the catalogue routes are not. There is no
administrative surface, no multi-tenancy, and no role model. Therefore the only authorization
decision this system ever makes is "does this subject own this object", and it makes that decision
on almost every request.

OWASP ranks BOLA as API1 because it is the most common serious API flaw. Here it is also the
**only** authorization flaw available, which means a BOLA is not one bug among many: it is the bug.
Combined with `THREAT-MODEL.md` AT-1 branch 2a, a BOLA on `/v1/connections` is a direct path to
asset A1, the per-user credential vault.

---

## 2. Route enumeration: classify, do not infer

Every operation in the OpenAPI document must declare `x-pullfm-authz`. The enumerator exits
non-zero if any operation does not, which is the literal implementation of Gate 3's "failing CI if
any route lacks a test".

| Class                  | Meaning                                                           | BOLA test?                   |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------- |
| `public`               | No credential required; identical response for everyone           | no                           |
| `authenticated-shared` | Credential required, response owned by nobody (catalogue, search) | no                           |
| `user-scoped`          | Credential required **and** the response is scoped to the subject | **yes**                      |
| `system`               | Operational surface that must be unreachable from the public edge | no, tested by unreachability |
| `webhook`              | Authenticated by signature, not session                           | no, tested by forgery        |

### Why not infer the classification

The obvious heuristics are "it has a path parameter" or "it has a `security` requirement". Both are
wrong on this specific API, in both directions:

| Route                      | Heuristic says      | Truth                                                              |
| -------------------------- | ------------------- | ------------------------------------------------------------------ |
| `DELETE /v1/me`            | no path param, skip | **user-scoped**, and the most destructive route in the system      |
| `GET /v1/artists/{mbid}`   | path param, test it | catalogue data owned by nobody; a BOLA test can never pass         |
| `POST /v1/webhooks/workos` | no security, public | unauthenticated by design, but must never be treated as harmless   |
| `GET /v1/wishlist`         | no path param, skip | **user-scoped**; the BOLA vector is the cursor, not a path segment |

A heuristic that is wrong in the "skip it" direction silently produces zero coverage on the most
dangerous route in the API. A heuristic that is wrong in the "test it" direction produces a test
that cannot pass, which gets marked `.skip`, and skipping becomes normal. Both outcomes end with a
green build and no coverage.

An annotation costs one line in the pull request that adds the route, at the moment when the author
knows the answer and the reviewer can see it. Fail-closed enumeration means forgetting is a build
failure rather than a silent gap.

### The BOLA descriptor

Each `user-scoped` operation additionally declares how a foreign object identity is substituted:

```jsonc
"x-pullfm-bola": {
  "strategy": "path-param",       // how the object is addressed
  "objectType": "wishlist_item",  // which subject-A fixture to aim at this route
  "param": "id",                  // which parameter carries the identity
  "deny": [404]                   // acceptable denial status codes
}
```

| Strategy           | Substitution                                                    | Example                             |
| ------------------ | --------------------------------------------------------------- | ----------------------------------- |
| `path-param`       | Put subject A's object id in the path while authenticating as B | `DELETE /v1/wishlist/{id}`          |
| `query-param`      | Same, in a query parameter. Covers opaque cursors               | `GET /v1/wishlist?cursor=`          |
| `body-ref`         | Same, in the request body                                       | future mutating routes              |
| `header`           | Same, in a header. Covers `Idempotency-Key`                     | `POST /v1/wishlist`                 |
| `implicit-subject` | Nothing to substitute; the object is implied by the session     | `GET /v1/me`, `GET /v1/connections` |

`implicit-subject` routes are the ones a naive suite skips because there is no id to tamper with.
They still get a test, just a different assertion: subject B's response must contain no trace of
subject A. That is what catches a cache keyed without the subject (`THREAT-MODEL.md` T12) and a
subject taken from a client-supplied header (M14).

`deny` is declared **per route** rather than assumed, because 403 and 404 mean different things and
both are correct in different places:

- **404** where the existence of the object is itself private. `DELETE /v1/wishlist/{id}` returns
  404 for a foreign id, because a 403 would confirm that the id exists and belongs to someone,
  which is an enumeration oracle.
- **403** where the route is known to exist and the denial is not informative. `DELETE
/v1/connections/{service}` uses a fixed service enum, so there is nothing to enumerate.

Gate 3's wording accepts either. Declaring the expectation per route stops the suite from accepting
whatever it happens to receive, which is how a 500 or a 200-with-empty-body gets mistaken for a
denial.

### `path-param` descriptors are cross-checked against the spec

If `param` names something that is not a declared path parameter of that path template, enumeration
fails. Otherwise a typo produces a test that substitutes nothing, requests the route normally, gets
a legitimate 404 from an unrelated cause, and passes. See the
`bad-bola-param.json` fixture and its test.

### Run it

```bash
node security/bola/route-matrix.mjs <openapi.json> --out security/bola/route-matrix.json --summary
```

Against the reference fixture today:

```
  TOTAL OPERATIONS         27
  authenticated-shared      7
  public                    3
  system                    1
  user-scoped              15
  webhook                   1
  -> BOLA tests required   15
```

---

## 3. Provisioning the two subjects

The suite needs subject **A (victim)** and subject **B (attacker)**, both real, both distinct, and
B's session must be genuinely valid or the whole exercise collapses (see §6, control 2).

Pull.fm has no passwords (`PLAN.md` §4: social plus magic-link only), so there is no credential the
test harness can simply post to a login endpoint. Two options, and the trade-off is real:

### Option A: staging WorkOS environment plus a test inbox

Drive the actual magic-link flow against a dedicated WorkOS staging environment, with two mailboxes
the harness can poll.

- **For:** exercises the entire authentication path exactly as production does.
- **Against:** the suite now depends on a vendor and an email round trip inside a per-PR CI job.
  Every WorkOS incident, every greylisting delay, becomes a red build on a security gate, and a
  security gate that is flaky gets bypassed. It is also slow, and it cannot run offline.

### Option B (chosen for CI): a JWKS seam

The BFF verifies bearer tokens against a JWKS URL taken from configuration
(`https://api.workos.com/sso/jwks/{client_id}` in production). In CI, that URL points at a JWKS the
test harness serves locally, and the harness mints tokens with the matching private key.

- **For:** deterministic, fast, offline, and it leaves the code path under test completely
  untouched. Token verification, subject extraction, and every ownership predicate run exactly as
  they do in production. Only the identity provider is substituted, and the identity provider is
  not what a BOLA suite is testing.
- **Against:** it is a seam, and a seam that is reachable in production would be a total
  authentication bypass. That risk is real and must be closed explicitly, not assumed away.

**Closing the seam.** Three independent controls, because one is not enough for a bypass this
severe:

1. A startup assertion: if `NODE_ENV === "production"` and the configured JWKS URL is not the WorkOS
   host, the process refuses to start. Fail closed at boot, not at first request.
2. The JWKS URL is not an operator-settable value in production; it is derived from the WorkOS
   client id, which is already required configuration.
3. A test asserting the assertion, so removing it fails CI.

Option A is still worth running, just not per-PR. The end-to-end signup path is already covered by
Gate 3's other clause ("E2E signup -> connect -> non-empty feed passes in CI"), which is the right
place for it: that test is about authentication, this suite is about authorization, and coupling
them makes both flakier without making either stronger.

---

## 4. Fixture seeding, and the trap that makes most BOLA suites worthless

The default failure mode of a BOLA test is that it passes for the wrong reason:

```
GET /v1/wishlist/00000000-0000-0000-0000-000000000000   as subject B   ->   404
```

That 404 is exactly what the gate asks for. It is also exactly what you get when the object simply
does not exist, when the route is not mounted, when the path is misspelled, and when the whole
service is returning 404 for everything. **A denial is only evidence if the object being denied
actually exists and actually belongs to someone else.**

So, before any assertion runs:

1. Subject A is given **at least one object of every `objectType` named in the matrix**.
2. Subject B is given its own object of each type, so B's credential can be proven valid
   independently (§6, control 2).
3. The suite fails in `before()` if any `objectType` in the matrix has no fixture. Not skips: fails.
   A route whose object type cannot be created is a route that cannot be meaningfully tested, and
   that fact must be loud.

Fixtures are created **through the public API**, not by direct SQL insert. Seeding through SQL
would hide the case where an object cannot be created without also creating something else, and it
would let the fixture and the application disagree about ownership, which is precisely the property
under test.

`objectType` values in the current matrix: `subject`, `connection`, `connect_state`,
`wishlist_item`, `feed`, `recommendation_set`, `station`.

`connection` is the awkward one. Creating a real connection means completing an OAuth flow against
a third party, which the suite must not do (`UPSTREAM-TERMS.md`, and `THREAT-MODEL.md` T16). The
fixture therefore inserts a connection row through the same service-layer function the callback
handler uses, with a mock provider registered in the upstream client registry, so the row is real,
the ownership columns are populated by the real code, and no third party is contacted. This is the
one place the suite reaches below the HTTP surface, and it is called out here rather than buried.

---

## 5. What is asserted per route

Five assertions per user-scoped route. Three of them are controls on the test rather than on the
system, which is the difference between a suite that finds BOLAs and a suite that reports green.

| #   | Assertion                                                               | Defends against                                                                                    |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **Positive control.** Subject A gets 2xx on A's object                  | A broken or unmounted route making every subsequent denial meaningless                             |
| 2   | **Session control.** Subject B gets 2xx on B's own object               | B's token being invalid, so the "denial" is really a 401 in disguise and no authorization code ran |
| 3   | **The gate.** Subject B gets one of `deny[]` on A's object              | The actual BOLA                                                                                    |
| 4   | **Anonymous control.** No credential gets 401                           | A route that is accidentally public                                                                |
| 5   | **Property control.** A's own response body matches no credential shape | API3:2023 and `THREAT-MODEL.md` M12: no route returns a token, not even to its owner               |

Assertion 5 is not object-level authorization, but it belongs in the same loop because it is the
same traversal and it catches the highest-severity leak in the system. It matches on field names
(`access_token`, `session_key`, `wrapped_dek`) **and** on value shape (a bare 32-character hex
string, which is what a Last.fm session key looks like), so a credential leaking through an
unexpected key name is still caught.

For `implicit-subject` routes, assertion 3 becomes: B's response must not contain A's subject id or
any of A's fixture markers.

### Cross-cutting cases that are not per-route

Three vectors are structural rather than route-specific, and are asserted once:

- **`Idempotency-Key` replay across subjects.** `PLAN.md` §6 mandates the header on every mutating
  call. A cache keyed on the header value alone turns one caching mistake into a BOLA on every
  mutating route at once (`THREAT-MODEL.md` T14). The suite has A perform a mutation with key `K`,
  then has B replay `K`, and asserts B never receives A's response.
- **Cursor tampering.** A cursor issued to A, replayed by B, must not return A's rows even if the
  cursor's integrity check is bypassed, because the keyset predicate always ANDs
  `user_id = $subject` (M15).
- **Client-supplied subject identifiers.** `X-User-Id` and a `user_id` body field must be rejected
  or ignored, never honoured (M14).

---

## 6. Proving coverage is complete

Two mechanisms, because each covers the other's blind spot.

**By construction.** Tests are generated by iterating the matrix. There is no hand-written list of
routes anywhere in the suite, so a route in the spec is a route in the suite.

**By reconciliation.** Every generated block records its route key in a ledger. A final test
compares the ledger against the matrix and fails on any difference. This catches what generation
alone cannot: a `.skip`, a `--test-name-pattern` filter, an exception thrown during generation that
truncates the loop, or a `describe` block that silently produced no tests. Generation gives you
coverage; reconciliation gives you _evidence_ of coverage, and only the second one survives someone
debugging a flaky test at 1am.

CI publishes the matrix and the ledger as artifacts, so "which routes were tested" is answerable
after the fact rather than inferred from a passing tick.

---

## 7. The canary: proving the suite can fail

A test suite that has never failed is indistinguishable from a test suite that cannot fail. For a
security gate, that distinction is the whole value.

`PULLFM_BOLA_CANARY=1` runs the suite against a build that mounts one deliberately vulnerable
route: a copy of `GET /v1/wishlist/{id}` whose query omits the owner predicate. The canary test
asserts that this route **is** exploitable. If the canary passes, the harness demonstrably detects
the exact bug class it exists to detect. If the canary is denied, the canary is not wired up and
the suite's green result means nothing.

The canary route is mounted only under a build flag that is asserted absent in production (same
three-control pattern as the JWKS seam in §3).

Run it on a schedule rather than per-PR: it needs a deliberately broken build, and its purpose is
to validate the harness, not the application. Once per release is enough; never is not.

---

## 8. Wiring into CI

```bash
# 1. Generate the spec from the Fastify route schemas (Gate 2 makes the spec the source of truth)
pnpm --filter @pullfm/bff openapi:emit > openapi.json

# 2. Enumerate. Fails here if any operation is unclassified. This is Gate 3's
#    "failing CI if any route lacks a test" clause, and it runs before the app starts.
node security/bola/route-matrix.mjs openapi.json --out security/bola/route-matrix.json --summary

# 3. Run the suite against the app
PULLFM_BOLA_MATRIX=security/bola/route-matrix.json \
PULLFM_BOLA_BASE_URL=http://127.0.0.1:3000 \
  node --test apps/bff/test/security/bola.test.ts
```

Ordering matters. Step 2 must fail before step 3 runs, so that "the enumerator rejected a new route"
is reported as an unclassified route rather than as a mysterious test failure.

---

## 9. What this suite does not cover

Stated so that nobody mistakes a green Gate 3 for a complete authorization proof.

- **API5:2023, Broken Function Level Authorization.** The suite iterates routes that are _in the
  spec_. A route that exists in the code but not in the spec is invisible to it. That gap is closed
  by a separate Gate 2 obligation ("OpenAPI spec is source of truth, 100% of documented endpoints
  have contract tests") plus a spec-versus-router diff test that fails when the Fastify route table
  and the emitted spec disagree. Without that diff test, "enumerate from the spec" is only as
  complete as the spec.
- **Second-order BOLA through asynchronous work.** Preview resolution and feed generation are
  background jobs (`PLAN.md` §3). If a worker writes subject A's data into subject B's feed, no
  synchronous request-response test will see it. Needs its own test at the worker boundary.
- **Time-of-check to time-of-use.** A connection revoked between the authorization check and the
  upstream call.
- **Authorization inside the upstream provider.** If a ListenBrainz token is scoped more broadly
  than we assume, that is a provider-side property this suite cannot observe.
- **`GET /v1/me/export` content.** The suite asserts the route is denied to a foreign subject; it
  does not verify that the export's _contents_ are correctly scoped. That belongs with the Gate L
  export test, where the full document is available for inspection.
