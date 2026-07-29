# Gate scorecard

The plan is measured against this, not against intent. A gate is green only when
a machine checks it and the command to re-run it is written down.

**Last updated:** 2026-07-28 (Gate 0 closed)

---

## Status

| Gate  | Criterion                                                           | Status          | Evidence                                                                                         |
| ----- | ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| **0** | TLS hello-world reachable, IaC applies with zero drift              | **GREEN**       | All four criteria met and re-runnable. See "Gate 0" below                                        |
| **1** | Migrations reversible, cascade transactional, constraints fire      | **GREEN**       | `node packages/db/scripts/verify-migrations.mjs` (12 checks)                                     |
| **2** | All endpoints correct vs upstreams, contract tests, cache hit >=90% | **not started** | Contract locked; handlers stubbed at 501                                                         |
| **3** | Auth flow, BOLA isolation, tokens encrypted, no plaintext in logs   | **partial**     | Crypto and redaction proven; authz suite pending                                                 |
| **4** | Restore from scratch <30 min, RPO <=5 min                           | **not started** | R2 bucket defined in Terraform                                                                   |
| **5** | Synthetic failure alerts <60s, runbook links resolve                | **not started** |                                                                                                  |
| **6** | Maintenance window, zero non-2xx rolling deploy, replica promotion  | **partial**     | Maintenance mode verified; deploy pipeline pending                                               |
| **7** | Capacity model + SLOs under mocked upstreams                        | **partial**     | Harness proven in both directions against the mock; needs a real BFF                             |
| **8** | Zero high/critical, pinned tools, accepted risks unexpired          | **partial**     | Scanners clean, tools pinned, register enforced; ZAP DAST needs a live host                      |
| **L** | Privacy policy, ToS, DPAs, deletion + export end to end             | **not started** | Endpoints exist; policies and cascade pending                                                    |
| **S** | ~~Store accounts, privacy labels, web deletion URL~~                | **RETIRED**     | Distribution is GitHub Releases, not app stores. See PLAN.md section 11.6                        |
| **$** | Billing alerts on every vendor                                      | **not started** | Must precede provisioning                                                                        |
| **D** | Commit to main reaches prod with a verified rollback                | **partial**     | main -> staging is automatic and externally verified; prod and the executed rollback are Phase 6 |     |

---

## Green gates in detail

### Gate 0: staging is live and serving TLS

All four criteria, each with the command that re-checks it.

**1. `terraform plan` exits 0 with zero drift on a clean checkout.**

```bash
cd infra/terraform/envs/staging && terraform plan -detailed-exitcode   # exit 0
cd infra/terraform/envs/shared  && terraform plan -detailed-exitcode   # exit 0
```

Both report "No changes. Your infrastructure matches the configuration"
(2026-07-28), including after the break-glass SSH rule was added and removed.

**2. `curl -sf https://api-staging.pull.fm/healthz` returns 200 with a valid
certificate.**

```
$ curl -sf https://api-staging.pull.fm/healthz
{"status":"ok","uptimeSeconds":285,"version":"ced4ef92483454c2ede5b7e43b926530f1a386cf"}
```

The hostname is `api-staging.pull.fm`, **not** `api.staging.pull.fm`.
Cloudflare's free Universal SSL certificate covers `pull.fm` and `*.pull.fm`
and nothing deeper, so a two-label hostname has no edge certificate at all and
fails the TLS handshake before reaching the origin. The only fix Cloudflare
sells is Advanced Certificate Manager at 10 USD/month per zone. Production is
unaffected because `api.pull.fm` is a single label. Recorded as a deviation in
PLAN.md section 1b.

**3. testssl.sh grade.**

```bash
testssl.sh --quiet api-staging.pull.fm
```

| Component         | Score  |
| ----------------- | ------ |
| Protocol support  | 100    |
| Key exchange      | 100    |
| Cipher strength   | 90     |
| **Final**         | 96     |
| **Overall grade** | **A+** |

Measured on both edge addresses (104.21.49.227 and 172.67.153.3), TLS 1.2 and
1.3 only, no weak ciphers, forward secrecy on every simulated client that
connects at all.

The first run scored **A-**, and the single reason was `HSTS max-age is too
short`: the zone shipped with 86400 as a deliberately cautious starting value.
It was not cautious, it was failing. It is now 15552000 (180 days) with
`includeSubDomains` and `preload` both off, which is where the irreversible
risk actually lives.

**4. A commit to `main` auto-deploys to staging in under ten minutes with no
human step.**

`.github/workflows/deploy-staging.yml` builds and publishes the image, then
polls `https://api-staging.pull.fm/healthz` until `.version` equals the commit
SHA it just built. It fails the job if that does not happen inside the budget.

This is deliberately not a self-report. The workflow never connects to the
node; the node pulls. What the green check means is that the commit is serving
real traffic through Cloudflare, the load balancer, nginx and the container -
not that a deploy script exited zero. Evidence is the `version` field above
matching `git rev-parse HEAD`.

Measured end to end: image build about 2 minutes warm, registry poll up to 60
seconds, container start about 15 seconds.

### What Gate 0 does NOT cover, stated plainly

- **Gate $ is still open.** Billing alerts are configured on no vendor, so
  staging was applied ahead of its own stated precondition.
- **Terraform state is local**, not in R2. Losing the laptop orphans the
  environment.
- **Tailscale is not installed on the nodes.** The break-glass firewall rule
  was used once to bootstrap and removed; it is currently the only interactive
  path in. Routine operation needs none, because the deploy loop pulls.
- **A deploy is a container recreate**, so there is a brief connection refusal.
  Zero-non-2xx rolling deploys are Gate 6 and need the second application node.

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

Measured run (2026-07-28, 3m28s, ramp to 300 VUs against the mock): **all 9
thresholds pass**, including `cache_hit_rate > 0.90`, `upstream_quota_violations
< 1`, and p95 under 300ms on feed, search, config, and preview.

The egress evidence from the mock control plane is the part that matters, since
k6 cannot see it:

| Provider     | Peak req/s | Peak req/min | Rate-limited |
| ------------ | ---------- | ------------ | ------------ |
| MusicBrainz  | 1          | 12           | 0            |
| iTunes       | 1          | 20           | 0            |
| ListenBrainz | 2          | 11           | 0            |

MusicBrainz never exceeded its 1 req/s global ceiling and iTunes sat at exactly
its ~20/min limit, under a load representing 10,000 users.

**Gap:** every run so far used the BFF stub, so records are marked
`gate_valid: false`. Gate 7 needs real handlers before it can close.

### Scanners (Gate 8, partial)

```bash
pnpm scan:all
```

All of the below run as blocking CI jobs on every push, and both workflows are
green as of 2026-07-28.

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

- **Staging is provisioned and running; prod is not.** Both console-only
  prerequisites were cleared: the `pull-fm` Hetzner project exists and R2 is
  enabled. `envs/prod` has never been applied.
- **A control can be correct and still be in the wrong place.** The "only
  Cloudflare may reach the origin" firewall rule does not cover load-balanced
  traffic at all: it arrives on the private interface and Hetzner Cloud
  Firewalls filter only the public one. The rule was not wrong, it was
  incomplete, and nothing in a plan or a scanner would have said so. The
  enforcement that actually covers that path is the nginx allowlist on
  `$proxy_protocol_addr` plus Authenticated Origin Pulls. Both were verified by
  trying the bypass: a request to the load balancer IP with the right SNI fails
  the TLS handshake, and a request straight to the origin IP times out.
- **`burst-50k` is deliberately deferred** to post-launch. Load-testing against
  an invented traffic model produces false confidence; the pre-launch
  substitute is a written capacity model with the arithmetic shown.
- **Load tests never touch real upstreams.** Last.fm and MusicBrainz revoke
  access without appeal, so the original cold-cache and burst scenarios would
  have ended the project inside the gate meant to prove it was ready.
- **Gate 8 is a self-assessment, not an audit.** One person signing off on
  their own checklist is worth stating plainly.
- **A control that looks configured can still be absent.** The custom Semgrep
  rules were referenced by CI, validated locally against fixtures, and produced
  clean runs, while never actually being in the repository: a `.gitignore` entry
  meant for Semgrep's cache also matched `.semgrep/`. It surfaced only after the
  job was changed to print its output instead of writing it to a SARIF file.
  This is the argument for the distinction this document draws between green and
  written, and for preferring evidence over configuration as proof.
