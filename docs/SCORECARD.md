# Gate scorecard

The plan is measured against this, not against intent. A gate is green only when
a machine checks it and the command to re-run it is written down.

**Last updated:** 2026-07-28

---

## Status

| Gate  | Criterion                                                           | Status          | Evidence                                                                     |
| ----- | ------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| **0** | TLS hello-world reachable, IaC applies with zero drift              | **blocked**     | Terraform written and validating; requires `pull.fm` delegated + credentials |
| **1** | Migrations reversible, cascade transactional, constraints fire      | **GREEN**       | `node packages/db/scripts/verify-migrations.mjs` (12 checks)                 |
| **2** | All endpoints correct vs upstreams, contract tests, cache hit >=90% | **not started** | Contract locked; handlers stubbed at 501                                     |
| **3** | Auth flow, BOLA isolation, tokens encrypted, no plaintext in logs   | **partial**     | Crypto and redaction proven; authz suite pending                             |
| **4** | Restore from scratch <30 min, RPO <=5 min                           | **not started** | R2 bucket defined in Terraform                                               |
| **5** | Synthetic failure alerts <60s, runbook links resolve                | **not started** |                                                                              |
| **6** | Maintenance window, zero non-2xx rolling deploy, replica promotion  | **partial**     | Maintenance mode verified; deploy pipeline pending                           |
| **7** | Capacity model + SLOs under mocked upstreams                        | **partial**     | Harness proven in both directions against the mock; needs a real BFF         |
| **8** | Zero high/critical, pinned tools, accepted risks unexpired          | **partial**     | Scanners clean, tools pinned, register enforced; ZAP DAST needs a live host  |
| **L** | Privacy policy, ToS, DPAs, deletion + export end to end             | **not started** | Endpoints exist; policies and cascade pending                                |
| **S** | Store accounts, privacy labels, web deletion URL                    | **not started** | May be dropped if web-only, see PLAN.md section 11.6                         |
| **$** | Billing alerts on every vendor                                      | **not started** | Must precede provisioning                                                    |
| **D** | Commit to main reaches prod with a verified rollback                | **not started** |                                                                              |

---

## Green gates in detail

### Gate 1: migrations

```bash
node packages/db/scripts/verify-migrations.mjs
```

12 checks, all passing:

- Two full up/down cycles. Two rather than one, because a migration can be
  reversible once and still leave residue that breaks the second application,
  and that failure only appears during a production rollback.
- Down leaves zero tables behind.
- Deleting a user removes every dependent row in one statement (Gate L).
- Deezer previews cannot be written without an expiry (their URLs are signed).
- iTunes previews without an expiry are allowed (their URLs are stable).
- Ciphertext columns reject values too short to be valid AES-GCM.
- Unknown cache providers and duplicate wishlist entries are rejected.
- Per-provider cache size is measurable, so the Last.fm 100 MB licence cap
  can be enforced rather than estimated.

---

## Verified but not yet a full gate

These are proven and re-runnable, but their parent gate has other unmet criteria.

### Credential envelope (Gate 3, partial)

```bash
pnpm --filter @pull-fm/crypto test
```

22 adversarial tests. Not coverage tests: each encodes an attack that must fail.

- Every single-bit corruption of the ciphertext is rejected.
- A credential sealed for user A cannot be opened as user B, or under a
  different provider, or a different column.
- Length-prefixed AAD resists splitting attacks.
- Rotation keeps rows sealed by an older key readable; re-wrap changes the key
  without touching ciphertext.
- A key that has been dropped from configuration fails loudly, since silent
  failure there would be unrecoverable data loss.
- Error messages never echo the credential or key material.

### Log redaction (Gate 3, partial)

```bash
pnpm --filter @pull-fm/bff test
```

10 tests asserting on emitted log bytes rather than on the redaction config,
because config assertions only prove the config says what it says.

- Tokens are redacted at the top level, nested, and in the snake_case form
  upstream APIs actually return.
- The `Authorization` header and cookies never appear.
- Query strings are stripped (they can carry a token or a search term) while
  the path survives, so logs stay useful for debugging.
- Credentials that an HTTP client attached to a thrown error do not leak, which
  the default pino error serializer would have emitted in full.
- Client IP and user agent are retained, since abuse investigation needs them.

### Maintenance mode (Gate 6, partial)

Verified: `MAINTENANCE_MODE=true` returns 503 with `Retry-After: 300` on
application routes while `/healthz` still returns 200, so the orchestrator can
distinguish intentional downtime from a crash.

### Load harness (Gate 7, partial)

```bash
node load/mock-upstreams/server.js --bff-stub    # never touches a real upstream
k6 run load/scenarios/steady-10k.js
```

Proven in **both** directions, which matters more than a green run:

- Against a cache-first architecture: passes, 93.1% warm cache hit, zero quota
  violations, MusicBrainz egress capped at 1 req/s and iTunes at 20/min.
- With `MOCK_SYNC_RESOLVE=1` (naive synchronous upstream calls): fails on
  `upstream_quota_violations` alone, while latency and cache hit rate still
  look perfect. That is exactly the failure this gate exists to catch, and a
  latency-only gate would have missed it.

The mock returns each provider's real refusal shape rather than a generic 429
(MusicBrainz 503 with no `Retry-After`, iTunes 403 plain text, Deezer HTTP 200
with an error object), so code that only handles 429 fails here instead of in
production.

**Gap:** every run so far used the BFF stub, so records are marked
`gate_valid: false`. Gate 7 needs real handlers.

### Scanners (Gate 8, partial)

```bash
pnpm scan:all
```

| Scanner                    | Result                              |
| -------------------------- | ----------------------------------- |
| gitleaks                   | no leaks (whole repo, full history) |
| Semgrep custom rules       | 0 findings                          |
| Semgrep OWASP + TypeScript | 0 errors                            |
| Trivy dependencies         | 0 high/critical                     |
| Trivy Terraform (3 roots)  | 0 misconfigurations                 |

Tool versions are now pinned to commit SHAs and enforced by
`node security/scripts/check-action-pinning.mjs`, and the accepted-risk register
is validated on every push.

**Gaps before Gate 8 closes:** OWASP ZAP DAST has not run (needs a deployed
host), TLS grade is unmeasured for the same reason, and the threat model has not
been reviewed by anyone other than its author.

---

## Honest notes

- **Nothing is provisioned.** All infrastructure is plan-only. Gate 0 cannot be
  attempted until `pull.fm` is delegated and credentials are supplied.
- **`burst-50k` is deliberately deferred** to post-launch. Load-testing against
  an invented traffic model produces false confidence; the pre-launch
  substitute is a written capacity model with the arithmetic shown.
- **Load tests never touch real upstreams.** Last.fm and MusicBrainz revoke
  access without appeal, so the original cold-cache and burst scenarios would
  have ended the project inside the gate meant to prove it was ready.
- **Gate 8 is a self-assessment, not an audit.** One person signing off on
  their own checklist is worth stating plainly.
