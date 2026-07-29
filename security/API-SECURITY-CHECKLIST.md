# OWASP API Security Top 10 (2023), mapped to the Pull.fm API

Each item answers four questions in the same order: what the risk is, **how it applies to this
specific API** (naming the routes from `docs/PLAN.md` §6), what mitigates it and where, and how it
is **tested** so the claim is falsifiable rather than aspirational.

Cross-references: `T##` are threats from [`THREAT-MODEL.md`](THREAT-MODEL.md) §4, `M##` are
mitigations from §6, `AT-#` are the attack trees in §5.

The API surface under analysis:

```
public                 GET /v1/config   GET /healthz   GET /readyz
system                 GET /metrics
webhook                POST /v1/webhooks/workos
user-scoped            GET,DELETE /v1/me          GET /v1/me/export
                       GET /v1/connections        POST,DELETE /v1/connections/:service
                       GET /v1/connections/:service/callback
                       GET,POST /v1/wishlist      DELETE /v1/wishlist/:id
                       GET /v1/wishlist/:id/acquire
                       GET /v1/feed               GET /v1/recommendations
                       GET /v1/stations           GET /v1/stations/:id/tracks
authenticated-shared   GET /v1/search             GET /v1/artists/:mbid  /similar  /events
                       GET /v1/tracks/:mbid  /preview       GET /v1/albums/:mbid
```

---

## API1:2023 - Broken Object Level Authorization

**The risk.** An endpoint accepts an object identifier from the client and returns or modifies that
object without checking that the caller owns it.

### How it applies here

This is not one risk among ten for Pull.fm. It is _the_ risk, and everything else on this list is
secondary to it, for a structural reason: **there is exactly one authorization decision in the
entire system**, namely "does this subject own this object", and it is made on almost every
request. There is no role model, no tenancy, no admin surface. `PLAN.md` §6 describes an API where
fifteen of twenty-seven operations return data belonging to exactly one person.

The concrete instances, in descending order of what a successful exploit yields:

| Route                              | Object identity comes from   | What a BOLA yields                                                                                                                                                      |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/connections`              | the session, implicitly      | The connection list for another subject. If the response ever carried a token field, this is asset **A1** directly (`AT-1` branch 2a).                                  |
| `DELETE /v1/connections/:service`  | `:service` + the session     | Revoking someone else's connection. Low value to steal, high value to grief.                                                                                            |
| `GET /v1/me/export`                | the session, implicitly      | A complete GDPR export of another person: email, full listening history, wishlist. The single largest personal-data payload the API can produce.                        |
| `DELETE /v1/me`                    | the session, implicitly      | Irreversible cascade deletion of another account, including their vault rows (`on delete cascade`).                                                                     |
| `DELETE /v1/wishlist/:id`          | `:id` path parameter         | The textbook IDOR shape, and the one a scanner finds first.                                                                                                             |
| `GET /v1/wishlist`, `GET /v1/feed` | an opaque **cursor**         | Paging into another subject's rows. Easily missed because there is no obvious id in the request.                                                                        |
| `POST /v1/wishlist`                | the `Idempotency-Key` header | `PLAN.md` §6 mandates the header on every mutating call. If the stored response is keyed on the header value alone, replaying a key returns the previous caller's body. |
| `GET /v1/stations/:id/tracks`      | `:id` path parameter         | Another subject's generated station.                                                                                                                                    |

Count the shapes: only three of those eight are addressed by a path-parameter id. The other five are
addressed by the session, a cursor, or a header. **A BOLA review that greps for `/:id` finds three of
eight and declares victory**, which is precisely why the enumeration in
[`BOLA-TESTING.md`](BOLA-TESTING.md) classifies by a declared substitution strategy rather than by
URL shape.

### Mitigation

- **M11:** the ownership predicate is in the same SQL statement as the id predicate. Never
  fetch-then-check, because that pattern invites a later refactor to drop the check.
- **M10:** connections are **resolved from the subject**, never addressed by a client-supplied
  connection id. The only client-supplied key is `:service`, and the lookup is always
  `where user_id = $subject and provider = $service`. This removes the object-id substitution vector
  from the highest-value route in the API by design rather than by check.
- **M14:** the subject is derived exclusively from the verified JWT. `X-User-Id`-style headers and
  `user_id` body fields are rejected, not ignored.
- **M15:** cursors are opaque and integrity-protected, **and** the keyset predicate always ANDs
  `user_id = $subject`, so a forged cursor cannot escape the subject even if the signature check is
  defeated. Two independent controls, because cursor signing is exactly the kind of thing that gets
  refactored.
- **M13:** idempotency records are keyed on `sha256(subject || key || method || route || body-hash)`.
  A key reused with a different body returns 422 rather than a cached foreign response.
- **M16, M17:** `DELETE /v1/me` requires a fresh-auth proof that is not a cookie;
  `GET /v1/me/export` is asynchronous and delivered by a signed, single-use, short-TTL URL bound to
  the subject rather than as a synchronous body.
- **M12:** no route returns a credential, ever, not even to its owner. Structurally enforced: every
  response has a JSON schema and Fastify's serialiser emits only declared properties, so an
  accidentally selected `access_token_ct` cannot reach the wire.

### How it is tested

- **Gate 3, the BOLA suite.** Full design in [`BOLA-TESTING.md`](BOLA-TESTING.md). Five assertions
  per user-scoped route, of which three are controls on the test itself (positive control, session
  control, anonymous control), because a BOLA test that passes because the object does not exist is
  the default failure mode of this kind of suite.
- **Coverage is proven twice:** tests are generated from the route matrix, and a reconciliation test
  fails if the executed set differs from the matrix.
- **The suite is proven capable of failing** by a canary route that omits the owner predicate
  (`BOLA-TESTING.md` §7).
- **Static tripwire:** the existing Semgrep rule `pullfm-bola-missing-owner-predicate` flags a query
  filtered by id with no `user_id`/`owner_id`/`account_id` predicate. It is a tripwire for the common
  shape, not the proof.
- **Cross-cutting cases** (idempotency replay, cursor tampering, client-supplied subject) are
  asserted once each rather than per route.

---

## API2:2023 - Broken Authentication

**The risk.** Authentication mechanisms are implemented incorrectly, letting an attacker assume
another identity.

### How it applies here

`PLAN.md` §4 removes the largest part of this category by construction: **no passwords ever exist.**
Google and Apple OAuth plus magic link. There is no password store, no reset flow, no credential
stuffing surface, and no hash to leak. That is a genuine structural reduction, not a claim.

What remains is entirely about token verification and the connect flow:

1. **JWT verification (T21).** WorkOS access tokens are JWTs signed by a key published at
   `https://api.workos.com/sso/jwks/{client_id}`. The classic failures all apply: accepting
   `alg: none`, honouring a `kid` that points at an attacker-controlled JWKS, skipping `aud` so a
   token minted for a different WorkOS application is accepted, or skipping `exp` so a leaked token
   is valid forever.
2. **The connect flow (T22).** `GET /v1/connections/:service/callback` exists because Last.fm's
   `auth.getSession` requires a callback (`PLAN.md` §6). Without a subject-bound, single-use,
   expiring `state`, an attacker can cause a victim's browser to complete a connect flow that binds
   the **attacker's** Last.fm account to the victim's subject (scrobble poisoning, plus a permanent
   read channel into the victim's activity), or the reverse. Last.fm session keys **do not expire**,
   so this is not a transient compromise.
3. **Magic-link enumeration (T23).** Differential responses or timing on the login path reveal
   whether an address is registered.
4. **WorkOS availability (T25).** Not an attack, but authentication is fully outsourced, so a
   suspension is an outage with no local fallback.

### Mitigation

- **M18:** verify against the WorkOS JWKS with `alg` allowlisted to the JWKS algorithms, and
  `iss`, `aud`, `exp`, `nbf` all checked. JWKS cached per its `Cache-Control` and refetched on a
  `kid` miss (refetch-on-miss, not refetch-on-every-request, so an attacker cannot use unknown
  `kid`s as a request amplifier against WorkOS).
- **M20:** connect flows use a signed, single-use, 10-minute `state` bound to the subject **and**
  the target service, stored server-side and consumed atomically so a replay loses the race.
  `redirect_uri` is an exact-match allowlist, never a prefix match.
- **M21:** uniform response shapes and timing on signup and login.
- **M23:** scheduled export of the WorkOS user list into our own backups, so a vendor suspension
  cannot leave us unable to identify our own users.
- **M22:** append-only audit rows for connect, disconnect, and refresh.

### How it is tested

- Unit tests for `alg: none`, an unknown `kid`, a wrong `aud`, a wrong `iss`, and an expired token.
  Each must be rejected; a test that only checks the happy path proves nothing here.
- Integration tests for the connect flow: replayed `state`, `state` minted for a different subject,
  `state` past its TTL, and a `redirect_uri` outside the allowlist.
- A contract test asserting identical response shapes for a known and an unknown email address.
- Gate 3's E2E signup path covers the real WorkOS round trip; the BOLA suite deliberately does not
  (see `BOLA-TESTING.md` §3 for why coupling them makes both weaker).

---

## API3:2023 - Broken Object Property Level Authorization

**The risk.** The object is the right one, but the response exposes properties the caller should
not see, or the request lets the caller set properties they should not set.

### How it applies here

The read side is the dangerous one, and it is severe: `user_oauth_connections` holds
`access_token_ct`, `refresh_token_ct`, `wrapped_dek`, and `kek_id`. A `select *` feeding a
`GET /v1/connections` response would serialise the vault to its owner over HTTPS, where it lands in
client logs, crash reporters, HTTP caches, and screenshots. The owner is authorised for the
_object_; nobody is authorised for the _credential_.

The write side: `POST /v1/wishlist` accepting `{ "user_id": "<victim>" }` or
`{ "created_at": ... }` is mass assignment, and the first of those is a BOLA wearing a different
hat.

`GET /v1/me/export` is the same problem at maximum scale: a portability export is supposed to
contain everything the user has, and "everything" must be carefully defined to exclude the
encrypted credentials and the wrapping metadata.

### Mitigation

- **M12:** a response JSON schema on every route. Fastify's `fast-json-stringify` serialiser emits
  **only** declared properties, so an extra column selected by accident is dropped at the serialiser
  rather than caught in review. This is the single highest-leverage control in this section, because
  it makes the safe outcome the default one.
- `additionalProperties: false` on every **request** schema, so unknown fields are rejected rather
  than silently bound.
- The connections repository never selects the ciphertext columns for a read path. Decryption is a
  separate, explicit call made only when an upstream request is about to be issued.
- **M09** and the existing Semgrep rule `pullfm-no-decrypted-token-on-request`: a decrypted
  credential is function-local and never attached to `request` or `reply`, where an error serialiser
  would eventually find it.
- `GET /v1/me/export` is built from an explicit allowlist of columns, never from a table dump.

### How it is tested

- Gate 2 contract tests assert response bodies match the declared schema exactly.
- The BOLA suite's assertion 5 runs a credential-shape check against every user-scoped response
  body: field names (`access_token`, `session_key`, `wrapped_dek`, `kek_id`) **and** value shapes (a
  bare 32-character hex string, which is what a Last.fm session key looks like), so a credential
  leaking under an unexpected key name is still caught.
- Mass-assignment tests: `POST /v1/wishlist` with `user_id`, `id`, and `created_at` in the body must
  return 400, not 201.
- Gate 3's `pg_dump | grep <known-test-token>` returning 0 covers the storage side of the same
  invariant.

---

## API4:2023 - Unrestricted Resource Consumption

**The risk.** An endpoint consumes resources without bound: CPU, memory, database connections,
storage, or **money**.

### How it applies here

Pull.fm has an unusual and severe version of this, because the scarcest resource it consumes belongs
to somebody else.

**Third-party quota (T16, AT-5).** `UPSTREAM-TERMS.md` is unambiguous: MusicBrainz allows 1 request
per second **globally per IP**, roughly 86,000 lookups per day for the entire service; iTunes allows
about 20 calls per minute per IP. Any route that can trigger a synchronous upstream call is a remote
kill switch, and sustained abuse gets the egress IP blocked. `PLAN.md` §8 identifies that as
product-ending, and there is no second supplier of MBIDs. The exposed routes are `/v1/search`,
`/v1/tracks/:mbid/preview`, `/v1/artists/:mbid/similar`, and any cache-missing catalogue lookup.

**Our own resources.**

- `GET /v1/me/export` generates a full personal-data export per call. Unthrottled, it is a
  self-service denial of service on the worker tier.
- `GET /v1/feed` fans out across sections; an unbounded page size or an expensive cursor exhausts
  the PgBouncer pool (T10).
- Last.fm cached data has a hard 100 MB ceiling from the provider's own terms
  (`UPSTREAM-TERMS.md` L1). Exceeding it is simultaneously a storage problem and a licensing breach.
- Redis is configured with `maxmemory 256mb` / `allkeys-lru`, which is correct for a cache and
  catastrophic for quota counters (see API8 below).

### Mitigation

- **M33:** cache-first. No third party is ever called synchronously on a user request path. Preview
  resolution and MusicBrainz lookups are queued background work. This is a security control, not
  only a performance one, and should be understood that way when someone later proposes calling
  iTunes directly because it is simpler.
- **M34:** per-provider circuit breaker, quota counter, and runtime kill switch (`PLAN.md` §3.4).
- Per-subject **and** per-IP quotas, with the tighter limits on the routes that spend metered
  upstream quota (`PLAN.md` §6 cross-cutting requirements). Rate-limit headers on every response.
- **M17:** `GET /v1/me/export` is asynchronous, one in-flight export per subject, with a cooldown.
- **M30:** PgBouncer transaction pooling, `statement_timeout`,
  `idle_in_transaction_session_timeout`, and a maximum page size enforced by schema.
- **M38:** Last.fm cache capped at 100 MB with LRU eviction and an alert at 80 MB.
- **M28:** rate-limit counters must not share an eviction policy with the cache. See API8.
- Cloudflare handles volumetric abuse at the edge, and **M24** ensures it cannot be bypassed by
  addressing the origin directly.

### How it is tested

- **Gate 1:** a 10,000-request burst to the MusicBrainz queue measures **<= 1.0 req/s egress at the
  network layer** over 10 minutes with zero dropped jobs. Measured at the network layer, not
  asserted in application code, which is the only version of that test worth running.
- **Gate 2:** warm cache hit rate >= 90%; every endpoint has defined and tested behaviour for
  upstream 429, 500, and timeout.
- **Gate 7:** failure-injection matrix with each upstream forced to 429/500/timeout in turn;
  `/feed` must still return 200 with degraded sections, p95 < 800ms, errors < 1%, no pool
  exhaustion, recovery < 60s.
- Rate-limit integration tests assert 429 with `Retry-After`, and assert the limit **still holds
  while the cache is under eviction pressure** (the T11 case).
- The 80 MB Last.fm cache alert is one of the named Gate 5 alert conditions.

---

## API5:2023 - Broken Function Level Authorization

**The risk.** A route or method exists that the caller should not be able to invoke at all.

### How it applies here

Pull.fm has no admin API and no role model, which removes the classic "regular user reaches
`/admin`" shape entirely. What remains:

- **`GET /metrics`** is listed in `PLAN.md` §6's platform surface. Reachable from the public edge it
  is free reconnaissance: route names, error rates, queue depths, subject counts, and often enough
  timing detail to infer whether a given account exists.
- **Method-level gaps.** A path with a correctly authorised `GET` and a forgotten `DELETE` handler.
  `/v1/wishlist/:id` and `/v1/connections/:service` are the candidates.
- **Undocumented routes.** The BOLA suite enumerates from the OpenAPI spec, so a route that exists
  in the Fastify router but not in the spec is invisible to it. This is the one real gap in Gate 3's
  coverage and is called out in `BOLA-TESTING.md` §9.
- **`POST /v1/webhooks/workos`** is deliberately unauthenticated in the session sense. Its
  authorization is a signature. See API8 and T20.
- **`GET /v1/artists/:mbid/events`** returns 501 by design (`PLAN.md` §1). It must not become a
  half-implemented route that leaks provider data.

### Mitigation

- **M26:** `/metrics` binds to the private network only and is never routed through Cloudflare.
- Fastify's default 404 for undeclared methods, plus a `405` policy that does not enumerate which
  other methods exist.
- **The spec-versus-router diff test:** a test that walks Fastify's route table and the emitted
  OpenAPI document and fails if they disagree. Without it, "enumerate from the spec" is only as
  complete as the spec, and Gate 3's guarantee is conditional on a document nobody validated.

### How it is tested

- An external reachability test asserting `/metrics` is refused from outside the private network.
  Run from the CI runner, not from inside the VPC, or it proves the opposite of what is intended.
- The spec-versus-router diff test, run in CI.
- The BOLA suite's anonymous control (assertion 4) catches a user-scoped route that is accidentally
  public.
- ZAP's OpenAPI import plus the passive scan flags responses on paths that should not answer;
  `/metrics` is deliberately left **in** DAST scope for exactly this reason
  (`security/zap/context/pullfm-api.context.yaml`).

---

## API6:2023 - Unrestricted Access to Sensitive Business Flows

**The risk.** A flow is used automatically at a scale the business did not anticipate, causing harm
without any individual request being malicious.

### How it applies here

This is the item most often waved through as "not applicable to us", and for Pull.fm it is one of
the two or three that matter most, because the harm lands on third parties and on the product's
right to exist rather than on a user's data.

1. **Preview resolution as a scraping engine.** `GET /v1/tracks/:mbid/preview` and `GET /v1/search`
   are, from the outside, a free rate-limit-laundering service in front of iTunes, Deezer, and
   MusicBrainz. A scraper does not need to break anything; it just needs to be enthusiastic. The
   result is a blocked egress IP and, per `UPSTREAM-TERMS.md`, revocation without appeal or SLA.
2. **Signup automation.** `PLAN.md` §2 budgets explicitly for WorkOS Radar with the note that a
   consumer signup form _will_ be attacked. Mass account creation multiplies every per-subject quota
   by the number of accounts an attacker can mint, which converts the per-subject rate limit into a
   speed bump.
3. **Magic-link mail as an amplifier.** Requesting a magic link for arbitrary addresses turns our
   sender reputation into someone else's spam problem.
4. **Wishlist as free storage.** `POST /v1/wishlist` is an authenticated write with no natural
   ceiling.

None of these is a vulnerability in the CWE sense. All four are business-logic abuse, which is
exactly what API6 is for.

### Mitigation

- **M33:** because no request path calls a third party synchronously, scraping our API cannot
  produce a burst of upstream traffic. It produces queued jobs, which are rate-shaped by
  construction. The cache-first architecture is the primary control here.
- Per-subject quotas on preview resolution and search, tighter than the per-IP limit, since a
  scraper needs an account.
- WorkOS Radar for signup bot protection, plus a per-IP signup limit at the edge.
- Magic-link requests rate limited per address **and** per IP.
- Wishlist size cap per subject, enforced in schema and in SQL.
- **M38:** no affiliate tags anywhere. `PLAN.md` §1a makes this a hard rule enforced by lint,
  because an affiliate parameter would retroactively breach Last.fm, Deezer, and Apple
  simultaneously. Business-flow abuse by our own future selves is still business-flow abuse.

### How it is tested

- Gate 1's egress measurement is the real test of control 1: it proves that request volume at the
  front door does not become request volume at the upstream.
- Load tests run **exclusively against mocked upstreams** (`PLAN.md` §8). Running them against real
  providers would itself be the abuse this section describes, which is a rare case of the test and
  the vulnerability being the same action.
- Quota integration tests asserting that N accounts do not multiply the global upstream budget.
- The affiliate-tag lint rule.

---

## API7:2023 - Server Side Request Forgery

**The risk.** The API fetches a remote resource using a location the client influences.

### How it applies here

Pull.fm is an aggregator. Fetching remote resources is not an incidental feature, it is the product.
That makes SSRF a first-class risk rather than an edge case, and it interacts with the vault in the
worst possible way.

**The primary vector (T15).** `GET /v1/artists/:mbid`, `GET /v1/tracks/:mbid`,
`GET /v1/albums/:mbid`, and `/similar` interpolate a client-supplied identifier into an upstream
URL. An `mbid` containing `@`, `/`, `?`, `#`, or CRLF can redirect the request, and
**anything attached to that request goes with it**: the Last.fm API secret, or a per-user
ListenBrainz token. `AT-1` branch 2c calls this the cheapest known path from an ordinary request to
asset A1, because it never touches the database and never needs the KEK.

**Secondary vectors.**

- Upstream responses containing a redirect, chased into the private network (Postgres on 5432,
  Redis on 6379, or the Nomad API on 4646, which per T28 hands out the KEK).
- `redirect_uri` on the connect flow, if it is validated by prefix rather than by exact match.
- Any future feature accepting an artwork or feed URL.

### Mitigation

- **M31:** every `:mbid` validated as a canonical UUID **before** use, and upstream URLs constructed
  from components with encoded parameters rather than by string concatenation. Validation at the
  route boundary using the OpenAPI `format: uuid` schema, so the check cannot be forgotten in one
  client and remembered in another.
- **M32: the egress allowlist.** The BFF may open outbound connections only to an explicit host
  list. This is the control that still works after an attacker has code execution in the BFF, and it
  is the only one in this document with that property. It also bounds `AT-4`: a malicious dependency
  that reads the KEK has nowhere to send it.
- Redirects disabled on every upstream client. A provider that starts redirecting is a change we
  want to notice, not follow.
- **M20:** `redirect_uri` exact-match allowlist.
- **M26:** private-network services are unreachable from the BFF's egress path except on their
  specific ports, so even a successful SSRF has a small target set.

### How it is tested

- Contract tests firing CRLF, `@evil.example`, `../`, absolute URLs, and IPv6-mapped addresses at
  every `:mbid` parameter, asserting 400 before any outbound request is made.
- A network-level test asserting an unlisted destination host is refused.
- ZAP's active scan runs rule **20019 External Redirect** at High strength and Low threshold
  precisely because of this section (`security/zap/plans/api-scan.yaml`).
- Upstream client unit tests asserting `redirect: "manual"` and that a 3xx is an error.

---

## API8:2023 - Security Misconfiguration

**The risk.** The code is fine; the configuration is not.

### How it applies here

Three findings in this category are specific enough to name, and one of them is the highest-
likelihood defect in the entire threat model.

**1. Redis eviction silently disabling rate limiting (T11).**
[`docker-compose.dev.yml`](../docker-compose.dev.yml) configures a single Redis with
`maxmemory 256mb` and `maxmemory-policy allkeys-lru`. That is correct and deliberate for a cache:
`allkeys-lru` means an eviction storm degrades gracefully instead of returning OOM under load. It is
catastrophic for quota counters. If production mirrors that configuration, any cache-fill event (a
feed rebuild, a catalogue crawl, a load test) evicts the rate-limit keys, and **every per-user and
per-IP limit fails open with no error and no alert.** Every mitigation under API4 and API6 depends
on those counters existing. This is the highest-likelihood misconfiguration in the model precisely
because the setting is correct for its other job, so nobody looks at it twice.

**2. Origin reachable directly (T01).** Cloudflare provides the WAF, bot management, per-IP rate
limits, and the maintenance worker. If the Hetzner origin IP answers requests that did not come
through Cloudflare, all of that is optional from the attacker's point of view. Origin IPs leak
through historical DNS, certificate transparency, and any outbound connection the box makes.

**3. Unpinned CI tooling (T27, T29).**
[`.github/workflows/security.yml`](../.github/workflows/security.yml) uses `gitleaks-action@v2`,
`actions/checkout@v4`, and the container image `semgrep/semgrep:latest`. Gate 8 requires **pinned
tool versions**, so as written the gate cannot honestly be marked green. Registered as
`PULLFM-RISK-002` in the accepted-risk register, with the shortest expiry of any entry. The
register is held privately; see [`README.md`](README.md) "What is not in this directory".

Also in scope: `/metrics` exposure (see API5), Postgres statement logging capturing bound parameters
(T07, the same trap that makes pgcrypto unusable per `PLAN.md` §5), Redis without auth or TLS on the
private network (T13), permissive CORS on a bearer-token API, and missing security headers, which
Gate 8's "Observatory >= A+" turns into a measurable requirement.

### Mitigation

- **M28:** rate-limit counters on a separate Redis instance, or at minimum a separate logical
  database with `noeviction`, plus a synthetic alert that fires if a quota key disappears before its
  TTL. The alert matters as much as the configuration: the failure is silent by nature.
- **M24:** Cloudflare authenticated origin pull (mTLS) plus an hcloud firewall restricted to
  Cloudflare ranges.
- **M25:** `CF-Connecting-IP` trusted **only** when the connection presents the origin-pull client
  certificate. Otherwise the client IP comes from the socket. Without this, per-IP quotas key off an
  attacker-controlled header.
- **M27:** TLS 1.2+, HSTS with preload, and for a JSON API
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, plus COOP/CORP.
- **M08:** production Postgres runs `log_statement = none`;
  `log_min_duration_statement` records duration without bound parameters.
- **M26:** every datastore and the Nomad API bind to the private network only.
- **M40:** pin every action to a commit SHA and every scanner image to a digest, plus a CI lint that
  rejects an unpinned `uses:`.

### How it is tested

- **The Redis case has a specific test:** a load scenario that fills the cache to eviction while
  asserting the rate limiter still returns 429. A unit test cannot catch this, because the bug only
  exists under memory pressure.
- A test asserting a direct-to-origin-IP request is refused.
- A unit test with a spoofed `CF-Connecting-IP` on a connection without the client certificate.
- **Gate 0:** testssl.sh >= A. **Gate 8:** Observatory >= A+ and a clean ZAP baseline.
- Trivy IaC misconfiguration scanning (already in `security.yml`).
- An external port scan of the Hetzner IP asserted to show only 443.
- `pnpm scan:risks` fails the build when `PULLFM-RISK-002` expires, which is the mechanism that
  stops the pinning gap from being deferred indefinitely.

---

## API9:2023 - Improper Inventory Management

**The risk.** Undocumented, forgotten, or stale API surface. Old versions, debug endpoints,
non-production environments reachable from the internet.

### How it applies here

Pull.fm is new, so there is no legacy version to forget. The live concerns are structural:

- **`api-staging.pull.fm` is internet-reachable and holds real-shaped data.** It is in scope in
  `SECURITY.md`. Staging typically has weaker secrets, more verbose errors, and looser rate limits,
  and it is the DAST target, which means it is the environment most likely to be in a broken state
  at any given moment.
- **The OpenAPI document is the inventory**, and Gate 2 makes it the source of truth. That is only
  true if a route cannot exist without appearing in it. See the spec-versus-router diff test under
  API5; without it, the inventory is a document rather than a fact.
- **`PLAN.md` §6 splits platform (stable) from product (volatile).** The product surface will churn
  behind a stable envelope. Churn is where routes get orphaned: a `/v1/stations` variant that stops
  being called by the client but keeps answering.
- **Upstream inventory is part of our inventory.** `UPSTREAM-TERMS.md` records that AcousticBrainz
  is dead, Spotify removed 16 endpoints in February 2026, and `labs.api.listenbrainz.org` has no
  SLA. A dependency on a dead endpoint is an inventory defect that shows up as an outage.
- **`GET /v1/config`** advertises feature flags, minimum client version, and provider health. That
  is deliberate, and it is also a reconnaissance endpoint: it must not name internal hostnames or
  disclose which providers hold credentials.

### Mitigation

- OpenAPI 3.1 is generated from the Fastify route schemas, so the spec cannot lag the router.
- The spec-versus-router diff test fails CI on disagreement.
- Staging is behind Cloudflare Access or an equivalent, is clearly marked, and holds no production
  personal data.
- `GET /v1/config` returns only flags and coarse provider health (`ok` / `degraded`), never internal
  hostnames, versions, or credential state.
- `UPSTREAM-TERMS.md` is re-audited quarterly, as that document itself mandates.
- Deprecation policy: a route is announced in `/v1/config`, then returns `410 Gone` with a problem
  document, then is removed. Silent removal breaks mobile clients that cannot be force-upgraded.

### How it is tested

- The spec-versus-router diff test.
- Gate 2: 100% of documented endpoints have contract tests, which fails if a documented endpoint
  does not exist as much as if an existing endpoint is undocumented.
- The BOLA enumerator fails on any unclassified operation, so a route added without thought about
  its authorization class cannot reach main.
- A test asserting `GET /v1/config` matches a strict schema, so a field cannot be added to it
  without a deliberate change.

---

## API10:2023 - Unsafe Consumption of APIs

**The risk.** Data received from a third party is trusted more than data received from a user.

### How it applies here

This item reads as though it were written for this system. `UPSTREAM-TERMS.md` documents, from a
live audit, that Pull.fm's data sources include:

- **`labs.api.listenbrainz.org`**, described in our own notes as "an experimental tier with **no
  SLA**, best-effort only".
- **ReccoBeats**, with an anonymous operator ("LatteBit"), undocumented rate limits, no status page,
  and no revenue model. Our own assessment: "a convenience layer, not infrastructure".
- **AcousticBrainz**, frozen since 2022, three years past its announced shutdown, "running on
  goodwill", with MetaBrainz's own view being that the data "isn't of high enough quality to be
  useful for much at all".

Everything those services return is written into our Postgres and served to our clients. Concretely:

- **Stored injection.** An artist name or biography from MusicBrainz or Last.fm containing markup is
  persisted and re-served. Today every client is JSON-consuming, so it is inert; the moment a web
  client renders it, it is stored XSS, and the payload was planted long before.
- **Resource exhaustion.** An unbounded array or a compressed response that expands enormously.
  Neither provider guarantees a size.
- **Redirect chasing.** A 3xx from an upstream, followed into our own private network. See API7.
- **Schema drift as an availability event.** Spotify removed 16 endpoints in one changelog. A field
  disappearing must degrade a feed section, not throw an unhandled exception in the request path.
- **TLS and DNS trust (T19).** Per-user tokens are sent to these hosts. A DNS hijack or an
  intercepted TLS session sends asset A1 to an impostor.

### Mitigation

- **M35:** every upstream response validated against a schema before use, size-capped, guarded
  against decompression bombs, with redirects disabled. Validation failure degrades the section, it
  does not fail the request.
- **M31/M32:** URLs built from components; egress restricted to an allowlist of upstream hosts.
- Output-side defence: `Content-Type: application/json` with `X-Content-Type-Options: nosniff`, and
  contextual escaping is the client's contract. Storing upstream text unescaped is accepted
  deliberately (escaping on write corrupts data), so the defence is on the render boundary and is
  documented as such.
- **M34:** circuit breaker plus kill switch per provider, so a misbehaving upstream is removed from
  the path automatically rather than by a human at 3am (`PLAN.md` §10: alerts are not on-call).
- **Never a hot-path third-party call** (`PLAN.md` §1): audio features come from our own Postgres
  table, backfilled offline. AcousticBrainz is dumps-only and never called at runtime, which is an
  API10 control as much as an availability one.
- Certificate validation strictly enforced; no `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere, in any
  environment, including tests.

### How it is tested

- Fuzz tests against the mock upstream layer built for Gate 7: malformed JSON, oversized arrays,
  markup in string fields, unexpected content types, and 3xx responses.
- **Gate 7's failure-injection matrix:** each upstream forced to 429, 500, and timeout in turn;
  `/feed` must return 200 with degraded sections, p95 < 800ms, errors < 1%, recovery < 60s.
- **Gate 2:** every endpoint has defined and tested behaviour for upstream 429, 500, and timeout.
- A Semgrep rule asserting no client sets `rejectUnauthorized: false`.
- The existing `pullfm-musicbrainz-must-use-ratelimited-client` rule, which forces every MusicBrainz
  call through the one client that applies these controls.

---

## Summary: where this API deviates from the generic ranking

| Item                              | Generic rank | Rank here | Why                                                                                                                   |
| --------------------------------- | ------------ | --------- | --------------------------------------------------------------------------------------------------------------------- |
| API1 BOLA                         | 1            | **1**     | The only authorization decision the system makes, and a path to the credential vault                                  |
| API7 SSRF                         | 7            | **2**     | Fetching remote resources is the product; an unvalidated `mbid` sends a credentialed request wherever the client says |
| API6 Sensitive business flows     | 6            | **3**     | Upstream quota is the scarcest resource and its exhaustion is product-ending, with no vulnerability required          |
| API8 Misconfiguration             | 8            | **4**     | The Redis eviction case fails a whole class of controls open, silently                                                |
| API3 Property-level authorization | 3            | **5**     | `select *` on the vault table is a one-line path to asset A1                                                          |
| API10 Unsafe consumption          | 10           | **6**     | Two named upstreams have no SLA and one has an anonymous operator; this is documented fact, not a hypothetical        |
| API2 Broken authentication        | 2            | 7         | Structurally reduced by having no passwords; the connect-flow `state` is what is left, and it is severe               |
| API4 Resource consumption         | 4            | 8         | Largely subsumed by API6 here, since the binding limit is someone else's quota rather than our CPU                    |
| API5 Function-level authorization | 5            | 9         | No role model and no admin surface; `/metrics` exposure is the real instance                                          |
| API9 Inventory                    | 9            | 10        | New system, one version, spec generated from code. Revisit at the first deprecation                                   |
