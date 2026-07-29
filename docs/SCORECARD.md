# Gate scorecard

The plan is measured against this, not against intent. A gate is green only when
a machine checks it and the command to re-run it is written down.

**Last updated:** 2026-07-29 (Gate 4 measured and failing; Gate $ reclassified; Gate R opened)

**Staging is currently torn down** (EUR 0.00/mo). Any gate whose command needs a
live host is marked `needs staging up` rather than counted as a pass.

---

## Status

Every row carries the command that re-checks it. A row with no command is not
green, by construction.

| Gate      | Criterion                                                           | Status                                       | Re-run with                                                                             |
| --------- | ------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **0**     | TLS hello-world reachable, IaC applies with zero drift              | **GREEN** (see note)                         | `terraform plan -detailed-exitcode`; `curl -sf https://api-staging.pull.fm/healthz`     |
| **1**     | Migrations reversible, cascade transactional, constraints fire      | **GREEN**                                    | `node packages/db/scripts/verify-migrations.mjs`                                        |
| **2**     | All endpoints correct vs upstreams, contract tests, cache hit >=90% | **not started**                              | -                                                                                       |
| **3**     | Auth flow, BOLA isolation, tokens encrypted, no plaintext in logs   | **partial**                                  | `pnpm --filter @pull-fm/bff test`; `pnpm --filter @pull-fm/crypto test`                 |
| **4**     | Restore from scratch <30 min, RPO <=5 min                           | **FAILING (measured)**                       | `./infra/staging-env.sh down && up && curl -sf .../healthz` - see "Gate 4" below        |
| **5**     | Synthetic failure alerts <60s, runbook links resolve                | **spec only**                                | no command exists yet; alert list specified in `RUNBOOK-INCIDENT.md`                    |
| **6**     | Maintenance window, zero non-2xx rolling deploy, replica promotion  | **partial**                                  | `pnpm --filter @pull-fm/bff test` covers the maintenance flag only                      |
| **7**     | Capacity model + SLOs under mocked upstreams                        | **partial**                                  | `node load/mock-upstreams/server.js --bff-stub` + `k6 run load/scenarios/steady-10k.js` |
| **8**     | Zero high/critical, pinned tools, accepted risks unexpired          | **partial**                                  | `pnpm scan:all`; `make risks`; `node security/scripts/check-action-pinning.mjs`         |
| **L**     | Privacy policy + EULA at stable URLs, DPAs, deletion + export       | **drafted, blocked**                         | no command; drafts in `legal/`, `[OPEN]` list in `legal/privacy-policy.md`              |
| ~~**S**~~ | ~~Store accounts, privacy labels, web deletion URL~~                | **RETIRED**                                  | Distribution is GitHub Releases. PLAN.md section 11.6                                   |
| **R**     | Releases signed + reproducible, signing key escrowed                | **not started**                              | no release pipeline exists yet                                                          |
| **$**     | Billing alerts on every vendor **that offers them**                 | **GREEN, with a recorded vendor limitation** | `make cost`                                                                             |
| **D**     | Commit to main reaches prod with a verified rollback                | **partial**                                  | `.github/workflows/deploy-staging.yml`; prod and rollback are Phase 6                   |

**What changed since the last revision, and why:**

- **Gate 4 moved from "not started" to "FAILING".** It was measured. That is a
  worse-sounding status and a more useful one: "not started" implies the work is
  ahead of us, while "failing" records that we tried and know exactly what broke.
- **Gate $ moved from "not started" to green with a limitation.** Cloudflare's
  alerts are armed and machine-verified. Hetzner appears to offer no spend-cap
  feature at all, which is a fact about the vendor and not a task on our list.
  See "Gate $" below.
- **Gate S retired, Gate R opened.** Leaving GitHub Releases unmeasured because
  the store gate went away would have quietly dropped a real obligation.
- **Gate L moved from "not started" to "drafted, blocked"**, because drafts now
  exist and the blockers are enumerated rather than vague.

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

- **Gate 0 describes a _running_ environment, not a rebuildable one.** Every
  assertion above was true of an environment that had already been bootstrapped
  by hand. It says nothing about recreating one, and when that was tried the
  result was five minutes of HTTP 525. See "Gate 4" below. This is a limitation
  of how Gate 0 was written, and it is worth saying rather than defending.
- **`envs/staging` state is in R2** (`pull-fm-tfstate`) since 2026-07-29, but
  **`envs/shared` and `envs/prod` state is still local.** That matters most for
  `shared`, which is the root that is actually applied: losing the laptop
  orphans the zone TLS posture.
- **Tailscale is not installed on the nodes.** The break-glass firewall rule
  was used once to bootstrap and removed; it is currently the only interactive
  path in. Routine operation needs none, because the deploy loop pulls - but a
  rebuild does need one, which is half of why Gate 4 fails.
- **A deploy is a container recreate**, so there is a brief connection refusal.
  Zero-non-2xx rolling deploys are Gate 6 and need the second application node.
- **Staging was applied ahead of Gate $**, which was its stated precondition.
  Gate $ has since closed to the extent the vendors allow; the ordering was
  still wrong at the time.

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

### Gate $: billing alerts, and one vendor that has no such feature

```bash
make cost          # exits non-zero if a required alert is missing or disabled
make cost-json     # the same, machine-readable
```

**Green, with one honestly labelled vendor limitation.** The distinction this
gate now draws is between _a task we have not done_ and _a control the vendor
does not sell_, because conflating them leaves a permanent red mark that no
amount of work can clear.

| Vendor         | Alert                                       | Status                                                  |
| -------------- | ------------------------------------------- | ------------------------------------------------------- |
| **Cloudflare** | budget $10, budget $25, R2 storage usage $5 | **armed via API, machine-verified by `make cost`**      |
| **R2**         | covered by the Cloudflare R2 usage alert    | **armed**                                               |
| **WorkOS**     | none                                        | **not applicable** - $0 to 1M MAU, no metered dimension |
| **Hetzner**    | none available                              | **vendor limitation, evidenced below**                  |

**Hetzner appears to offer no spend-cap or budget feature that any client can
reach.** Probed 2026-07-29:

| Probe                                  | Result                             |
| -------------------------------------- | ---------------------------------- |
| `GET api.hetzner.cloud/v1/billing`     | 404 `api route not found`          |
| `GET api.hetzner.cloud/v1/costs`       | 404                                |
| `GET api.hetzner.cloud/v1/cost_alerts` | 404                                |
| `GET api.hetzner.cloud/v1/usage`       | 404                                |
| `GET api.hetzner.cloud/v1/cost_limits` | 404                                |
| `GET api.hetzner.cloud/v1/budgets`     | 404                                |
| `GET console.hetzner.com/api/v1/usage` | **200, `content-type: text/html`** |

The last row is the trap: it answers 200 to an API token and looks like a
working endpoint. It is the console's SPA shell, not an API. **The operator also
looked for the setting in the console and could not find it.** So this is
recorded as a **vendor limitation with the probe evidence attached**, not as an
outstanding task, and `make cost` prints it as `[MANUAL]` and does not count it
as a pass either way.

**Drift is still detectable, which is why this is green rather than amber.**
`make cost` calls the live Hetzner Cloud API on every run and enumerates servers,
load balancers, volumes, primary IPs and floating IPs, computing the run rate
from their actual price data. An environment left running shows up as a non-zero
run rate the next time anyone runs it. The hard cost control is not an alert at
all, it is `./infra/staging-env.sh down`.

Full detail, including the API facts that cost time to discover:
[`RUNBOOK-COST.md`](RUNBOOK-COST.md).

---

## Measured and failing

A gate that has been tried and failed is a different thing from one that has not
been tried, and it is worth its own heading.

### Gate 4: restore from scratch - FAILING

```bash
./infra/staging-env.sh down
./infra/staging-env.sh up
curl -sf https://api-staging.pull.fm/healthz     # this is the step that fails
```

Measured 2026-07-29, by actually doing it:

| Step                                | Result                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `down`                              | 19 resources destroyed, run rate to EUR 0.00/mo, R2 backup bucket survived  |
| `up`                                | **45 seconds**, 19 resources created, load balancer reclaimed the same IPv4 |
| `curl .../healthz`                  | **HTTP 525 for five straight minutes**                                      |
| Hetzner load balancer target health | **unhealthy on both 80 and 443**                                            |

**Why.** nginx, the origin certificate, the BFF container, the deploy timer, and
the Redis and Postgres services are applied by **a human over SSH**. cloud-init
deliberately installs none of it, because that would put the KEK and the WorkOS
key into `user_data`, which lives in Terraform state and is readable from the
Hetzner API for the life of the server. That decision is correct; the missing
piece is the automated, secret-free path that should have replaced it. Worse,
the rebuilt node has **no way in**: no port 22 rule, and Tailscale is not
installed because `tailscale_auth_key` is empty in every committed
configuration.

**Status as of what can be verified:** the infrastructure half of Gate 4 works
and is fast. The half that makes a node serve traffic is a manual runbook of
**unmeasured length that has never been timed**, and until it is automated the
30-minute assertion cannot be evaluated at all, let alone met. A restore from
the pgBackRest repository has additionally never been attempted, because
**pgBackRest is not deployed**: `wal_level` and `archive_mode` are set so
enabling it is a config reload, but `archive_command` is currently a no-op and
no retention values are configured anywhere.

**Not owned by this document.** Another work stream is automating node
convergence. This entry records the finding and the reason; it will go green
when the same three commands above end in a 200.

### What this failure invalidates elsewhere

- `docs/api/deletion-and-backups.md` describes a pgBackRest PITR window as
  though it exists. It describes the **intended** position; no window is
  configured. That document now says so.
- `legal/privacy-policy.md` cannot state a retention period for backups until
  one is configured, and its appendix lists that as a publication blocker.

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

## Not started, with the reason stated

### Gate L: legal documents - DRAFTED, BLOCKED

Drafts exist at [`../legal/privacy-policy.md`](../legal/privacy-policy.md) and
[`../legal/terms-of-service.md`](../legal/terms-of-service.md), plus a frontend
attribution checklist at [`../legal/attribution.md`](../legal/attribution.md).
None is published, none has been reviewed by a lawyer, and there is no command
that checks this gate.

**Gate L stopped being paperwork and became a shipping blocker.** SeatGeek's API
terms make both documents contractual preconditions:

| Clause  | Requires                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4.4** | A Privacy Policy that accurately discloses what we collect, store, use and disclose                                                                                                                                 |
| **4.3** | An Application EULA with terms **at least as protective of SeatGeek as their own API terms**, **expressly designating the SeatGeek Entities as third-party beneficiaries entitled to enforce it against end users** |

Until both exist, `GET /v1/artists/:mbid/events` cannot be enabled at all.

**What blocks publication is code, not drafting.** The privacy policy carries an
appendix of `[OPEN]` items where the system does not do what a policy would have
to claim:

| #   | Blocker                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `audit_log` retains an IP address linked to a deleted account **indefinitely**; no purge exists             |
| 2   | **No log retention period is configured anywhere** in the system                                            |
| 3   | pgBackRest is **not deployed**, so there is no PITR window to state                                         |
| 4   | **No DPAs on file** with Hetzner, Cloudflare, or WorkOS (GDPR Art. 28 requires written processor contracts) |
| 5   | **No EU Article 27 representative** appointed                                                               |
| 6   | Controller's state of organisation, postal address, and supervisory authority unfilled                      |
| 7   | The US-access transfer mechanism is undecided                                                               |
| 8   | No legal review                                                                                             |

Items 1 through 3 are engineering tasks. **Item 1 is the sharpest**: the register
currently keeps an IP address tied to an internal account id forever, after the
account is gone, and no honest sentence can be written about that until it has a
bound.

### Gate R: signed and reproducible releases - NOT STARTED

Gate S retired when distribution moved to GitHub Releases, and this replaces it
rather than reducing the obligation. Nothing exists yet: there is no release
workflow, no signing key, and no reproducibility check.

What it will assert: artifacts are signed, the signature verifies against a
published key, a rebuild from the tagged commit reproduces byte-identical
artifacts in CI, the signing key is escrowed in two places the way the KEK is
(`PULLFM-RISK-003`), a key-loss procedure is written, and `GET /v1/config`
min-supported-build enforcement is tested.

**Why this is not softer than the store gate.** A store rejects a bad build;
GitHub Releases does not. Signing and reproducibility are the only things between
a user and a substituted artifact, and the signing key is a credential whose
disclosure lets an attacker publish an update that our own users' clients accept.

### Gate 5: alerting - SPEC ONLY

The alert list Gate 5 requires is specified in
[`RUNBOOK-INCIDENT.md`](RUNBOOK-INCIDENT.md), with each condition, how to fire it
synthetically, and the runbook section it links to. **Nothing in that list is
configured.** It is a specification, and it is labelled as one in the document
itself. Gate 5 stays open until each row can be demonstrated firing to ntfy
inside 60 seconds with a timestamped log, and every runbook URL returns 200.

---

## Honest notes

- **Staging is torn down and prod has never been applied.** Both console-only
  prerequisites were cleared: the `pull-fm` Hetzner project exists and R2 is
  enabled. Staging is ephemeral by design (PLAN.md section 10c) and is currently
  left **DOWN**, which is also the correct end state for an environment that
  cannot rebuild itself. `envs/shared` stays applied because a zone setting has
  no hourly cost.
- **An intention written in a plan is not a control.** PLAN.md section 10c said
  "production sets `delete_protection` true; staging false" for a full day before
  anything passed those variables, so the module default (`true`) applied to
  staging and the first teardown stopped halfway with EUR 21.98/mo still
  billing. The document was not wrong about what should happen; it was wrong to
  read as a description of what did. This is the same failure class as the
  `.semgrep/` note below, and both argue for the same rule: a claim is worth what
  its verification command is worth.
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
