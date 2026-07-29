# DAST findings, 2026-07-29

**Target:** `https://api-staging.pull.fm`, the first deployed target this project has ever had.
**Scanner:** ZAP 2.17.0, pinned by digest. Baseline (passive) plan, authenticated.
**Method:** `security/DAST-RUNBOOK.md`. This file is the result; that file is the method.

> **Publication.** This is a dated findings report and follows the same rule as the other dated
> audits: private until its findings are closed and infrastructure identifiers are stripped. The
> runbook, the plans, the scoping register and the tooling are all public and carry no current-state
> findings, so nothing here has to move for them to stay published.

---

## Verdict

**Gate 8's ZAP clause: PASSES, honestly, for the first time.** Zero High findings across 20
authenticated operations. The clause has never been evaluated before on any commit, so this is a
first measurement rather than a re-confirmation.

**Gate 8's Observatory clause: still UNMEASURED.** See finding D3.

Severity below is the impact if exploited, not the difficulty of fixing.

---

## Application findings

### D1. No `Cache-Control` on any user-scoped response — FIXED

**Proved.** ZAP rule 10015, five endpoints: `GET /v1/me`, `GET /v1/connections`, `GET /v1/config`,
`/healthz`, `/readyz`. Every one answered 200 with **no `Cache-Control` header at all**. Confirmed by
hand against the live origin for `/v1/wishlist` and `/v1/tokens` as well.

**Severity: MEDIUM.** THREAT-MODEL T12.

**Exploitation.** A response with no `Cache-Control` is _heuristically cacheable_ by any intermediary
between the origin and the user. It does not require an attacker; it requires a proxy. `GET /v1/me`
carries an email address, a user id and authentication timestamps. `GET /v1/connections` describes
which third-party music accounts a person has linked, which is sensitive on its own. Two users
behind one corporate forward proxy, carrier transcoder, ISP cache or shared browser profile is all
it takes for one to be served the other's body, and **no control we own is in the request path when
it happens**: not the BOLA predicates, not the envelope, not the rate limiter. Cloudflare does not
cache these today because of the content type, which is a vendor default rather than a control we
asserted.

**What makes this worth writing up rather than filing as a hardening nit:** the repository had
already decided this was a true positive. `security/zap/rules/alert-filters.yaml` says so in as many
words, and `baseline-rules.tsv` grades rule 10015 `FAIL`. The intent was recorded in two places and
implemented in one — `routes/v1/product.ts` had a local `personalised()` helper, so the catalogue
routes were covered and the account, token, connection and wishlist routes were not. This is the
project's own through-line again: not a design flaw, a control that was written down and not wired.

**Fixed** in `apps/bff/src/server.ts` as an `onSend` default (`private, no-store` unless the handler
already chose a policy), rather than by copying `personalised()` into four more files, because a
per-handler opt-in is the kind of control a new route silently misses. Regression tests in
`apps/bff/test/security/cache-control.test.ts`, **confirmed to fail without the fix** (7 of 8) rather
than merely to pass with it. The tests assert both directions: catalogue reads must keep
`public, max-age=300`, because a hook that clobbered them would convert a cache hit into upstream
egress, which is the failure this project can least afford.

### D2. The nginx error page bypasses every application security header

**Proved.** ZAP rule 10038, one Medium, on `https://api-staging.pull.fm/metrics`.

`GET /metrics` returns nginx's own `404 Not Found` HTML page — `content-type: text/html`, body
containing `<hr><center>nginx</center>` — with **no `Content-Security-Policy`** and none of the
helmet header set. Contrast `GET /` on the same host, which reaches Fastify and carries the full
correct header set on its 404.

**Severity: LOW-MEDIUM.** Not directly exploitable today: the page is static, serves no
attacker-controlled content, and the `deny all` that produces it is itself a correct control (it is
defence in depth over the application's own loopback-or-`METRICS_TOKEN` gate, which returns 404
rather than 403 so a refusal is indistinguishable from an unrouted path — a good decision).

**Why it still matters.** It establishes that there is a class of response on this origin that the
application's header policy does not reach. Any future nginx-level error page, redirect or
maintenance response inherits the same gap, and the CSP is the control that makes several other
alerts moot. It also discloses the reverse proxy's identity in the body, which the `Server:` header
does not (Cloudflare rewrites that to `cloudflare`).

**Not fixed here — belongs to the infrastructure owner.** The remedy is `add_header` with `always`
on the error responses in the nginx config, plus `server_tokens off` if not already set. Reported
rather than edited because `infra/staging/` is another agent's tree.

### D3. Gate 8's Observatory clause is still unmeasurable, for a new reason

**Proved.** The official MDN Observatory v2 API refuses the host:

```
POST /api/v2/scan?host=api-staging.pull.fm
-> {"error":"scan-failed","message":"Site did respond with an unexpected HTTP status code 404."}
```

A control host returns a grade normally, so the API works and the refusal is specific to us.
Observatory fetches `/` and rejects a host whose root is neither a success nor a redirect. `GET /`
correctly returns 404 because the API declares no root operation.

**The audit of 2026-07-29 recorded this clause as "FAIL, unmeasurable" because the origin answered 521. The origin is up; the clause is still unmeasured.** Different cause, same verdict, and it is
worth being precise that the situation improved without the gate becoming assessable.

**What can be said.** Every header Observatory grades is present and correct on that very 404
response. A local implementation of the documented modifiers
(`security/scripts/observatory-grade.mjs`) scores **110, which maps to A+**:

| Test                          | Modifier | Result                                                          |
| ----------------------------- | -------: | --------------------------------------------------------------- |
| content-security-policy       |      +10 | `default-src 'none'` with no unsafe directives                  |
| x-frame-options               |       +5 | implemented via CSP `frame-ancestors 'none'`                    |
| referrer-policy               |       +5 | `no-referrer`                                                   |
| **strict-transport-security** |  **-10** | **`max-age=15552000` (180 days), under the 15768000 threshold** |
| cookies                       |        0 | none issued                                                     |
| cross-origin-resource-sharing |        0 | no `Access-Control-Allow-Origin` for a foreign origin           |
| redirection                   |        0 | HTTP redirects to HTTPS on the same host                        |
| x-content-type-options        |        0 | `nosniff`                                                       |
| subresource-integrity         |        0 | not HTML                                                        |

**This is an approximation and must not be recorded as "the Observatory grade".** It is a local
reimplementation; the authoritative scanner has not run.

**Two separate fixes, two different owners:**

1. **The measurement blocker.** `GET /` must return a success or a redirect. This is a route
   decision with real cascade — a new operation flows into the OpenAPI document, the BOLA route
   matrix, the DAST disposition annotation, the upstream-egress register, and the hidden-route
   allowlist test — so it was deliberately **not** taken unilaterally.
2. **The 10 points.** See D4.

### D4. The HSTS header on the wire is weaker than the code intends

**Proved.** The application configures
`hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true }` in `server.ts`. The wire
carries `strict-transport-security: max-age=15552000` — **180 days, no `includeSubDomains`, no
`preload`**. Independently confirmed by testssl.sh: "180 days=15552000 s, just this domain".

The value on the wire matches `infra/terraform/envs/shared/terraform.tfvars`
(`hsts_max_age = 15552000`, `include_subdomains = false`, `preload = false`), which drives
Cloudflare's zone-level `security_header` setting. **Cloudflare's HSTS setting overrides the
origin's, so the application's stronger intent is shadowed and never reaches a client.**

**Severity: LOW,** but it is a direct and cheap Gate 8 cost: it is the only negative modifier in the
table above, and raising `hsts_max_age` past 15,768,000 moves the local score from 110 to 120.

This is exactly the class of drift the audit's F-series is about — configuration asserting one thing
while the wire says another — and it is only visible by looking at the wire.

**Not fixed — `infra/terraform/` is another agent's tree.** Note that HSTS is effectively
irreversible for the duration of `max-age`, and the variable's own description says to enable
`preload` only when submission to the browser preload list is actually intended, so the three
settings are not one change.

---

## Controls confirmed working on the live deployment

Verified by hand against the running origin, not inferred from source.

| Claim                                             | Result                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| CORS does not reflect an arbitrary origin         | **HELD.** No `Access-Control-Allow-Origin` for `https://evil.example.com`, on simple requests and on preflight. |
| 404-for-unauthorized on the read path             | **HELD.** `GET /v1/wishlist/{unknown}/acquire` -> 404 problem+json; forged station id -> 404; malformed -> 400. |
| Unauthenticated access is refused                 | **HELD.** 401 on `/v1/me`, `/v1/wishlist`.                                                                      |
| A personal API token cannot mint or manage tokens | **HELD.** 403 with an explicit reason, and the scope check runs _before_ object resolution.                     |
| `/metrics` is not publicly reachable              | **HELD**, twice over: application gate returns 404, and nginx denies independently.                             |
| Error bodies are RFC 9457 problem+json            | **HELD.** No stack traces, no SQL, no internal hostnames observed in any response.                              |
| No `Server:` header leaking Fastify or Node       | **HELD.** Cloudflare rewrites to `cloudflare`.                                                                  |
| TLS                                               | TLS 1.2 and 1.3 only, ECDSA P-256, no known-vulnerable suites, chain OK, 89 days validity, CT present.          |

**A caveat on the 403/404 convention, stated because the opposite reading is tempting.** Mutating
routes (`DELETE /v1/wishlist/{id}`, `DELETE /v1/tokens/{id}`) returned **403, not 404**, for a
nonexistent id. That is _not_ a violation of the BOLA convention: the credential available was a
read-only personal API token, so the scope check fires before object resolution and the object is
never looked up. Authorization-before-resolution is the correct order and avoids an existence
oracle. **It does mean the 404-for-unauthorized convention could not be exercised on mutating routes
with the credential available**, and that gap should be closed with a session credential before Gate
3's claim is treated as verified end to end on the live deployment.

---

## Scope: what was excluded, and whether the MusicBrainz pacer moved

Nine of 38 operations were removed as provider-reaching; 13 more were removed as destructive; 20
were scanned, authenticated. The full classification with per-route evidence is in
`security/zap/upstream-scope.tsv`, and the reasoning is in section 2 of the runbook.

**The MusicBrainz pacer was NOT observed, and this run must not be recorded as "the pacer stayed
flat".** `/metrics` is gated to loopback or `METRICS_TOKEN`, `METRICS_TOKEN` defaults to empty, and
nginx denies the path, so the counters are unreachable from where the scan ran. The tooling prints
`UNKNOWN` rather than a reassuring zero, deliberately.

What _is_ established, by code trace rather than measurement: **no HTTP route reaches the MusicBrainz
client.** Every request-path MusicBrainz read is `CachedUpstream.peek`, which is database-only and
returns `null` on a miss instead of calling `load()`. The client is reached only by the background
cache-warmer and the offline warm-cache script. So the 1 req/s ceiling cannot be breached by a
scanner as the code stands, and the register plus its reconciliation test exist to notice the day
that stops being true.

Provider status from `/v1/config` was identical before and after the scan. That is a weak signal and
is reported as one.

**To upgrade this to a measurement:** set `METRICS_TOKEN` on the staging node and supply
`PULLFM_METRICS_URL` and `PULLFM_METRICS_TOKEN` to the runner or the workflow. The runner then fails
the run on any rise, and **refuses to scan at all** if asked for the counters and unable to read
them.

---

## Bearing on the published accepted-risk register

Nothing found here creates a new high-severity risk. Two observations sharpen existing ones:

- **D2 and D4 are both instances of the gap between configured intent and observed wire.** The
  register's entries are argued from configuration. At least one entry per review cycle should now
  be re-proved against the live origin, because two of the four findings in this report were
  invisible from the source tree.
- **D4 touches the same Cloudflare zone settings as the edge-control entries.** Whoever opens the
  Terraform change for `hsts_max_age` is already in the file where the WAF and rate-limiting rules
  are absent, so the two should be sequenced together rather than as separate PRs.

The scan found **no** new evidence bearing on the origin-bypass, IP-rotation or R2-token entries.
The IP-rotation limiter was not exercised: driving it would have meant thousands of requests against
shared staging, which is the load-testing behaviour that was correctly refused.
