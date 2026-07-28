# Pull.fm - Infrastructure-First Execution Plan (v2)

> **Supersedes** `~/Repos/crate-plan.md` and `~/Repos/crate-architecture.md`. Both are retired.
> The architecture doc in particular is _actively wrong_ (it specifies YouTube playback,
> Better-Auth, and an unresolved public/private question) and must not be used as rationale.
>
> **Revised 2026-07-28** after a three-way audit of every load-bearing assumption against live
> APIs, published terms, and current vendor pricing. Corrections are marked **[R]** with the
> reason, so the diff from v1 is auditable rather than silent.

**Prime directive (unchanged):** the backend is _running, observable, backed up, load-tested, and
security-audited_ before any UI work begins. "Nailed down" means green on a machine-checkable
gate, not designed on paper.

**Scale target (restated honestly) [R]:** engineered for **10,000 users**, with a _documented and
costed_ path to 50,000. v1 claimed 50k needed "no data migration, no re-platform." That is false:
the binding constraint at 50k is **upstream API quota**, not our infrastructure, and relieving it
requires a local MusicBrainz mirror. See §3.

---

## 0. What the audit changed

Five assumptions in v1 were wrong. Two of them were severe.

| #     | v1 assumption                               | Reality                                                                                                                                                                                                                                                        | Impact                                                                                   |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **1** | Infisical stores per-user tokens            | **Physically impossible.** Infisical Cloud caps at 300 secret ops/min (Pro); 50k users with hourly-expiring tokens need ~50,000 refresh _writes_/hour. Short by ~3x on writes alone. The feature has been "on the roadmap" since 2023 with zero docs coverage. | **Redesigned.** See §5.                                                                  |
| **2** | Hetzner CPX31/CPX41 sizing                  | Hetzner raised **CPX/CCX by 150-210% on 2026-06-15.** US CPX41: €38.99 -> **€120.49**. ARM (CAX) rose only ~30%.                                                                                                                                               | **~6x cost error.** Moved to CAX.                                                        |
| **3** | "Previews are keyless, therefore risk-free" | Keyless is not licence-free. **Deezer is explicitly non-commercial**; **Apple forbids "independent entertainment value"** and forbids caching previews.                                                                                                        | **Resolved** by the non-commercial lock (§1a); caching + attribution rules still bind.   |
| **4** | Last.fm is a free discovery pillar          | **Non-commercial only**, with a **100 MB cache cap**. Any affiliate revenue is "a material breach."                                                                                                                                                            | **Resolved** by §1a; the **100 MB cap still binds** and is now a hard design constraint. |
| **5** | WorkOS is portable                          | True on price ($0 to 1M MAU, no B2C per-org fees). But **WorkOS does not export password hashes, at all.**                                                                                                                                                     | **Mitigated,** see §4.                                                                   |

Two further corrections: **AcousticBrainz is dead** (frozen 2022, shutdown notice three years
overdue) so it is dump-only and never a runtime dependency; and **MusicBrainz's 1 req/s is a
global per-IP ceiling** (~86k lookups/day for the entire service), not per-user.

Full evidence: [`UPSTREAM-TERMS.md`](UPSTREAM-TERMS.md).

---

## 1a. Pull.fm is NON-COMMERCIAL (locked 2026-07-28, operator decision)

**Pull.fm will not be commercialised.** No subscriptions, no ads, no affiliate revenue, no paid
tiers. This is a locked product constraint, not a launch-phase state.

This single decision resolves the three licensing blocks the audit found, because every one of
them was triggered by _commercial_ use:

| Was blocking                                    | Now                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Last.fm ToS 3.1-3.2 non-commercial-only         | **Compliant.** No `partners@last.fm` agreement needed.                       |
| Deezer ToS §IV non-commercial-only              | **Compliant.**                                                               |
| Apple preview terms / affiliate conflict        | **Compliant**, given attribution and no revenue.                             |
| MetaBrainz supporter tier (required on revenue) | **Not required.**                                                            |
| Essentia MTG models (CC BY-NC-SA 4.0)           | **Now usable** - unlocks `energy` and `valence`, previously licence-blocked. |

**Constraints that survive and are now hard design rules:**

1. **No affiliate tags, ever.** Purchase links to Qobuz/Bandcamp/Apple are plain links. An
   affiliate parameter would retroactively breach Last.fm, Deezer, and Apple simultaneously.
   Enforced by a lint rule, not by memory.
2. **Last.fm cached data must stay under 100 MB** (ToS 4.3.4). This is now the binding Last.fm
   constraint. Last.fm-derived rows carry a TTL and are **size-capped with LRU eviction**, and the
   cap is monitored with an alert at 80 MB.
3. **Attribution is mandatory** - Last.fm's specified `last.fm/music/[artist]` link format,
   "provided courtesy of iTunes" for Apple previews, and MusicBrainz's required `User-Agent`.
4. **Apple previews are streamed, never cached as audio.** Only the resolved URL is stored.
   Deezer preview URLs are signed and expire, so they are never stored at all.
5. **If commercialisation is ever reconsidered, this section is the blocker to revisit first.**

**Non-commercial does not exempt us from:** GDPR/CCPA (we process personal data regardless of
revenue), App Store and Play Store requirements including `DELETE /me` and a web-accessible
deletion URL, or any security obligation. **Gate L and Gate S remain in force.**

---

## 1. Decisions locked (v2)

| Area                       | Decision                                                                                                               | Changed?             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Playback**               | 30s previews (iTunes hotlinkable; **Deezer URLs are signed and expire, never cache them**)                             | **[R]** caching rule |
| **Data layer**             | Postgres 17 + PgBouncer (transaction mode) from day one                                                                | **[R]** added pooler |
| **Auth**                   | **WorkOS AuthKit, social + magic-link only. No passwords, ever.**                                                      | **[R]** see §4       |
| **Per-user token storage** | **AES-256-GCM envelope encryption, ciphertext in Postgres.** Infisical removed entirely.                               | **[R]** see §5       |
| **App secrets**            | 1Password -> Nomad variables. No standing secrets service.                                                             | **[R]**              |
| **Compute**                | **Hetzner CAX (ARM64)**, project `pull-fm`                                                                             | **[R]** cost         |
| **Orchestration**          | Nomad v2.0.4 (BSL permits running our own commercial app)                                                              | confirmed            |
| **Backups**                | Cloudflare R2 + pgBackRest (R2 pricing confirmed unchanged)                                                            | confirmed            |
| **Discovery**              | **ListenBrainz primary.** Last.fm _contingent_ on commercial terms. MusicBrainz for connections.                       | **[R]**              |
| **Audio features**         | Local Postgres table; AcousticBrainz dumps offline; ReccoBeats cached-on-fetch. **Never a hot-path third-party call.** | **[R]**              |
| **Events**                 | **Disabled.** No provider approved. `/v1/artists/:mbid/events` returns 501.                                            | user directive       |
| **Alerts**                 | ntfy (ops) + Resend (user-facing, deferred)                                                                            | unchanged            |

---

## 2. Corrected cost model

v1 had no dollar figure. At the sizes it named, it would have cost **~$350-550/mo pre-launch**.

| Line item                            | 10k users        | 50k users        |
| ------------------------------------ | ---------------- | ---------------- |
| Compute: 2x CAX21 BFF + 1x CAX31 DB  | €47              | €82              |
| Load balancer LB11                   | €7.49            | €7.49            |
| Auth (WorkOS, social-only)           | $0               | $0               |
| Auth custom domain (recommended)     | $99              | $99              |
| Bot protection (WorkOS Radar)        | ~$0-100          | ~$300            |
| Token encryption (envelope, app-key) | $0               | $0               |
| R2 backups                           | ~$0              | ~$5              |
| **Total**                            | **~$155-255/mo** | **~$400-500/mo** |

Without the custom domain and Radar, the floor is **~$60/mo at 10k**. Radar is the honest line
item v1 omitted: a consumer signup form _will_ be attacked.

**Billing alerts are mandatory on Hetzner, Cloudflare, R2, and WorkOS** before provisioning
anything. Solo operator plus attached card plus no cap is a failure mode. -> **Gate $**

---

## 3. The real scaling ceiling [R]

v1's topology diagram treated upstream limits as a footnote. They are the actual constraint.

| Upstream      | Limit               | Scope                               |
| ------------- | ------------------- | ----------------------------------- |
| MusicBrainz   | **1 req/s**         | **global, per-IP** (~86k/day total) |
| iTunes Search | **~20 calls/min**   | **per-IP**                          |
| Deezer        | ~50 req / 5s        | per-IP                              |
| Last.fm       | undocumented (~5/s) | per-key, all users share it         |
| ListenBrainz  | 30 req / 10s        | per-token                           |

At v1's own traffic model (2,000 DAU x ~15 preview resolves = ~30k resolves/day) from two egress
IPs, **cold-cache resolution against iTunes is arithmetically impossible.**

**Therefore the architecture is cache-first, not fetch-first:**

1. Every MBID-keyed fact is written to Postgres on first resolution and served from there forever.
2. A **local MusicBrainz mirror** is the documented 50k unlock, budgeted (~50 GB + replication)
   and explicitly _not_ pretended away.
3. Preview resolution is a **background job**, never a synchronous request path.
4. Every provider sits behind a **circuit breaker + quota counter + runtime kill switch**.

---

## 4. Auth: WorkOS, social-only [R]

The audit confirmed WorkOS is genuinely free at our scale with no per-org or per-connection fee
for B2C. It also found that **WorkOS does not export password hashes** and provides no path out,
while shipping polished tooling to import _in_.

**Resolution: never issue a password.** Google + Apple OAuth and magic-link only.

This is the rare fix that is strictly better on every axis:

- **No hashes exist**, so there is nothing to be held hostage. Lock-in structurally evaporates:
  users re-link by email address at any future provider.
- **Better consumer UX** - social sign-in is what a music app's users expect.
- **Removes an entire vulnerability class**: no password storage, reset flow, or stuffing surface.
- **Preserves the existing WorkOS setup and credentials** already in 1Password.

Two additions v1 lacked: a **scheduled export of the WorkOS user list into our own backups** (so a
vendor suspension cannot make us unable to identify our own users), and a **WorkOS webhook
receiver** for `user.deleted`, without which an identity deleted upstream orphans our data forever.

---

## 5. Per-user token vault: envelope encryption [R]

**Infisical is removed.** It was the wrong tool: a secrets manager is designed for ~20
application secrets, not 50,000 per-user credentials. Beyond the rate-limit impossibility, v1's
design carried a **circular startup dependency** (BFF -> Infisical -> its own Postgres) and an
**unrecoverable-loss vector** (lose the root key, every user's tokens are permanent ciphertext),
neither of which v1's backup phase addressed.

The correct pattern is what companies whose entire product is storing other people's OAuth tokens
actually do (Nango, Paragon): **AES-256-GCM ciphertext in their own Postgres.** Neither uses a
secrets manager.

```sql
create table user_oauth_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  provider            text not null,
  provider_account_id text not null,
  -- Envelope: a per-row data key, itself wrapped by an app-wide key encryption
  -- key. Rotating the KEK re-wraps DEKs only; token plaintext is never touched.
  kek_id              text  not null,
  wrapped_dek         bytea not null,
  -- nonce(12) || ciphertext || tag(16)
  access_token_ct     bytea not null,
  refresh_token_ct    bytea,
  access_expires_at   timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now(),
  unique (user_id, provider, provider_account_id)
);
create index on user_oauth_connections (kek_id);  -- drives rotation backfill
```

Non-obvious requirements, each of which prevents a real failure:

- **Fresh 96-bit nonce per encryption**, and a fresh DEK per row. Never reuse a DEK across users.
- **Bind `user_id || provider || column` as AAD** into the GCM tag, so a row-swap or cross-column
  attack fails closed. Most implementations skip this; it is nearly free.
- **`kek_id` column from day one.** Nango's published design cannot rotate its key because it
  omitted this. We will not repeat that.
- **Single-flight refresh lock** (`pg_advisory_xact_lock`) per connection. Providers rotate
  refresh tokens; two concurrent refreshes lock the user out permanently.
- **`on delete cascade`** to `users`, so account deletion is transactional. A secrets manager
  could not have given us this, which is a GDPR problem as well as a correctness one.

**Not pgcrypto.** Postgres' own docs warn the key travels as a query parameter, landing it in
`log_statement`, `pg_stat_activity`, and APM traces - key and ciphertext in one trust boundary,
defeating the purpose.

**KEK location:** a 256-bit app key from 1Password, injected as a Nomad variable. Escrowed in two
places (1Password + offline), because losing it is unrecoverable. Cost at 50k users: **$0.**

---

## 6. API surface (v2)

Split into a **platform surface** (stable under every product outcome, built first) and a
**product surface** (will churn once a UI exists, built behind a stable envelope). This is what
lets us honour "infra before UI" without certifying guesses to a 50k standard.

### Platform (stable)

```
GET    /v1/config                 min client version, feature flags, maintenance, provider health
GET    /v1/me
DELETE /v1/me                     [R] account deletion + cascade   <- App Store 5.1.1(v)
GET    /v1/me/export              [R] GDPR/CCPA data portability
GET    /v1/connections
POST   /v1/connections/:service
GET    /v1/connections/:service/callback   [R] Last.fm auth.getSession needs a callback
DELETE /v1/connections/:service
GET    /v1/wishlist               cursor-paginated
POST   /v1/wishlist               Idempotency-Key required
DELETE /v1/wishlist/:id
POST   /v1/webhooks/workos        [R] user.deleted, session events
GET    /healthz  /readyz  /metrics
```

### Product (volatile, behind a stable envelope)

```
GET /v1/feed                      -> { sections: [{ kind, title, items[] }], cursor }
GET /v1/recommendations?seed=
GET /v1/stations  /v1/stations/:id/tracks
GET /v1/search?q=
GET /v1/artists/:mbid  /similar
GET /v1/tracks/:mbid  /preview
GET /v1/albums/:mbid
GET /v1/artists/:mbid/events      -> 501 Not Implemented (disabled, no provider)
```

`/feed` returns a typed list of `sections`, each with a `kind`. The ranking algorithm can change
completely without breaking the client contract. **Gate 2 tests the envelope, not the taxonomy.**

**Cross-cutting, all [R]:** RFC 9457 problem+json errors, cursor pagination everywhere,
`Idempotency-Key` on every mutating call (mobile clients retry on flaky networks), rate-limit
headers, per-user and per-IP quotas on the endpoints that spend metered upstream quota.

---

## 7. Phases and gates

**Track L runs in parallel from day 0.** Store accounts and legal answers are latency-bound, not
effort-bound - they consume calendar, not focus. Serialising them after Phase 8 adds weeks of
dead time for zero benefit.

```
TRACK L (parallel, day 0)          -> Gate L, Gate S, Gate $
  Last.fm commercial terms email (partners@last.fm)   <- may redesign discovery
  Apple/Deezer preview ToS decision
  Apple Developer org + D-U-N-S | Google Play org
  Privacy policy | ToS | DPAs | EU Art.27 rep
  Billing alerts on all vendors

Phase 0  Foundations + real CI/CD. Staging only.        -> Gate 0, Gate D
Phase 1  Data plane: Postgres + PgBouncer + migrations
         + Redis + pgBackRest/WAL from first byte.      -> Gate 1, Gate 4
Phase 2  Platform API + auth + envelope vault
         + deletion/export + rate limiting.             -> Gate 3
Phase 3  Upstream layer: MB queue, crosswalk, preview
         resolver, circuit breakers, worker tier.       -> Gate 2
Phase 4  Observability. Moved earlier [R]: you cannot
         load-test what you cannot observe.             -> Gate 5
Phase 5  Product endpoints behind the envelope.         -> envelope contract only
Phase 6  Prod cutover + DR + maintenance rehearsal.     -> Gate 6
Phase 7  Capacity, honestly. MOCKED upstreams.          -> Gate 7
Phase 8  Backend security audit.                        -> Gate 8

>>> Gate BACKEND-DONE -> UI work authorized <<<
```

### Gates, rewritten to be falsifiable

v1's gates included unfalsifiable phrases like "dashboards live" and a circular "RTO documented
and met." Every gate below is machine-checkable.

| Gate  | Assertion                                                                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | `terraform plan` exits 0 with zero drift on clean checkout; `curl -sf https://api.staging.pull.fm/healthz` returns 200 with valid cert; testssl.sh >= A; commit to `main` auto-deploys to staging in <10 min with no human step                                                                      |
| **1** | Migrations apply up **and down** cleanly in CI; a 10,000-request burst to the MB queue measures **<=1.0 req/s egress at the network layer** over 10 min with zero dropped jobs; PgBouncer serves >=200 client conns on <=25 server conns                                                             |
| **2** | OpenAPI 3.1 spec is source of truth; 100% of documented endpoints have contract tests; every endpoint has defined+tested behaviour for upstream 429/500/timeout; **warm cache hit >=90%**, cold-cache p95 <2s over a 1,000-request replay                                                            |
| **3** | E2E signup -> connect -> non-empty feed passes in CI; **BOLA suite enumerates every user-scoped route from the OpenAPI spec** and asserts 403/404 for a foreign subject on 100% of them, failing CI if any route lacks a test; `pg_dump \| grep <known-test-token>` returns 0; 24h of logs grep to 0 |
| **4** | Restore from R2 into a fresh node completes **<30 min wall clock, timed**; row-count+checksum matches primary; RPO <=5 min verified by killing the primary mid-write; drill re-runs monthly and alerts on failure                                                                                    |
| **5** | Each of a **named list** of alert conditions fires to ntfy **within 60s** when triggered synthetically, evidenced by a timestamped log; every alert has a runbook URL returning 200                                                                                                                  |
| **6** | Maintenance flag -> 100% of requests 503 with `Retry-After` within 60s; cleared -> 100% 200 within 60s; **rolling deploy under sustained load produces zero non-2xx**; replica promotion <5 min                                                                                                      |
| **7** | Under a failure-injection matrix (each upstream forced to 429/500/timeout in turn) `/feed` returns 200 with degraded sections, p95 <800ms, errors <1%, no pool exhaustion, recovery <60s                                                                                                             |
| **8** | Zero high/critical from Semgrep, Trivy, gitleaks, ZAP baseline with **pinned tool versions**; every accepted risk in `security/accepted-risks.md` has an owner and **expiry date**, and CI fails on an expired entry; Observatory >= A+                                                              |
| **L** | Privacy policy + ToS at stable URLs; DPAs on file; `DELETE /me` and `GET /me/export` verified end-to-end including cascade to WorkOS, Redis, and logs; documented backup-retention position for deleted data                                                                                         |
| **S** | Apple + Google org accounts verified; privacy labels drafted against actually-collected fields; reviewer demo account live; **web-accessible deletion URL** live (Google requirement)                                                                                                                |
| **$** | Billing alerts on all vendors; synthetic overage fires one                                                                                                                                                                                                                                           |
| **D** | Commit to `main` reaches prod through staging with a migration step and **a rollback verified by executing one**; no manual SSH                                                                                                                                                                      |

---

## 8. Load testing must use mocked upstreams [R]

v1's Gate 7 specified a `cold-cache` scenario at 50k-equivalent load with "max upstream
resolution pressure."

**Running that would have gotten our API access revoked before launch.** Last.fm and MusicBrainz
revoke without appeal or SLA. This was a product-ending failure mode sitting inside the gate
meant to prove readiness.

**Load tests run exclusively against a mock upstream layer** that reproduces each provider's
latency distribution, rate-limit responses, and error shapes. This tests what we can actually
control - our own breaking point - and is the only version of the test that is honest anyway,
since a real-upstream test mostly measures someone else's infrastructure.

`burst-50k` is **deferred to post-launch** [R], when the traffic shape is known rather than
invented. It is replaced pre-launch by a **written capacity model**: measured cost per request
type (CPU-ms, DB queries, upstream calls), extrapolated with the arithmetic shown, plus a
**documented scale trigger** ("add a BFF node at sustained 60% CPU or p95 >250ms").

---

## 9. Deferred, with justification [R]

Cut from the pre-launch critical path. Each retains its _capability_ while dropping standing cost.

| Deferred                                             | Why                                                                                                                                                                                         | Capability retained                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Streaming replica**                                | Idle at 0-10k users; v1 contradicted itself by building it pre-launch (§2) while listing it as a _scale-up step_ (§10). PITR already covers DR.                                             | WAL archiving on from day one, one-command replica build script, promotion runbook, drill executed once then torn down |
| **Self-hosted Prometheus/Grafana/Loki/Alertmanager** | Five stateful services one person maintains, added to _improve_ reliability. Grafana Cloud free tier is more reliable for the case that matters: observing our box while our box is broken. | Full observability, plus one external uptime checker outside our infrastructure                                        |
| **Infisical**                                        | Wrong tool (§5); circular dependency; unrecoverable-loss vector                                                                                                                             | 1Password -> Nomad variables                                                                                           |
| **Public status page**                               | No public yet                                                                                                                                                                               | Uptime Kuma when there is one                                                                                          |
| **`burst-50k`**                                      | Invented traffic model produces false confidence (§8)                                                                                                                                       | Capacity model + scale trigger                                                                                         |

---

## 10. Solo-operator reality [R]

v1 assumed a human is available. The opposite assumption is now explicit.

- **Alerts are not on-call.** ntfy at 3am with no escalation is a notification, not a response.
  Design for **auto-degradation instead of paging**: Nomad restart policies, an external health
  check that auto-enables the Cloudflare maintenance worker, and a read-only degraded mode.
- **Publish an honest SLO** ("best effort, no 24/7 response") rather than implying one we cannot
  staff.
- **Vacation mode** is a defined state: deploy freeze, auto-maintenance on failure, pinned notice.
- **Bus factor is 1** across 1Password, Cloudflare, Apple Developer (near-impossible to transfer),
  registrar, and the LLC bank. Print a 1Password Emergency Kit, add a recovery contact, write a
  one-page successor doc. Phase 0, one hour.
- **Blast-radius isolation is partially false.** The Hetzner project is isolated; the **Cloudflare
  account is shared with the personal fleet**. Account suspension or a compromised account token
  takes down both. Either separate the account or accept and document it.

---

## 10a. Provisioning blockers (verified 2026-07-28 against live APIs)

Credentials work. Two prerequisites are **console-only** and cannot be scripted.

| Blocker                          | Evidence                                                                                                                                                                           | Needed                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **No `pull-fm` Hetzner project** | `GET /v1/projects` returns **404**; the Cloud API has no project endpoint. The supplied token is scoped to the personal project (it enumerates `ente-jellyfin` and `hetzner-box`). | Create project `pull-fm` in the Hetzner console, mint a token scoped to it |
| **R2 not enabled**               | `POST /accounts/.../r2/buckets` returns **403 code 10042**, "Please enable R2 through the Cloudflare Dashboard."                                                                   | Enable R2 once in the Cloudflare dashboard                                 |

**Confirmed working:** `pull.fm` is an active Cloudflare zone (id `70f6a577591a0cf4813b0e1456699a28`),
delegated from Porkbun. Terraform plans clean against the real APIs: **22 to add, 0 to change,
0 to destroy.**

**Why the Hetzner project matters rather than just using the personal one:** Pull.fm stores other
people's ListenBrainz tokens and Last.fm session keys. Sharing a project with the personal fleet
means a shared firewall namespace, shared token blast radius, and a compromise of either side
reaching the other. Section 1 locked project isolation for exactly this reason, so provisioning
into the personal project would silently reverse a security decision to save one console click.

---

## 10b. Hetzner capacity reality (measured 2026-07-28, live API)

Gate 0 partially applied. **DNS, load balancer, network, and firewalls are live.
All three servers failed**, and the reason is supply, not configuration.

| Family                   | EU status                                    | Price (nbg1/hel1)                                 |
| ------------------------ | -------------------------------------------- | ------------------------------------------------- |
| **CAX (ARM)**            | **out of stock in every EU datacenter**      | would have been EUR 20.99                         |
| **CX (x86 shared)**      | **out of stock in every EU datacenter**      | -                                                 |
| **cpx_1_ (cpx21/31/41)** | **discontinued: "can no longer be ordered"** | legacy prices apply only to existing servers      |
| cpx_2_                   | orderable                                    | cpx22 EUR 22.99, cpx32 EUR 41.99, cpx42 EUR 69.49 |
| ccx (dedicated)          | orderable                                    | ccx13 EUR 50.49                                   |

`fsn1-dc14` reports **zero** available server types of any kind.

This confirms the June 2026 repricing finding rather than contradicting it: the
cheap cpx_1_ prices visible in the API are grandfathered, and the only types a
new project can actually order are the repriced generation.

**Cost consequence.** The plan's sizing (2 app + 1 database) now costs about
**EUR 95/mo for staging alone** on cpx22 + cpx32, against the EUR 55 the CAX
plan assumed. Options, cheapest first:

1. **Single-node staging** (one cpx32 running app + Postgres + Redis, no load
   balancer): ~EUR 42/mo. Loses the rolling-deploy and load-balancer rehearsal
   that Gate 6 needs.
2. **One app node + one database node** behind the existing load balancer
   (cpx22 + cpx22): ~EUR 53/mo. Keeps every gate testable; the second app node
   is only needed to prove the balancer distributes, which one node cannot show.
3. **As planned** (2x cpx22 + cpx32): ~EUR 95/mo. Full fidelity to production.
4. **Wait for CAX restock.** Unpredictable, and blocks Gate 0 indefinitely.

Recommendation: **option 2**. It preserves the load balancer, rolling deploys,
and a separate database host, which are the parts the gates actually exercise,
while the second app node adds cost without adding a new failure mode to test
before there are users.

---

## 11. Open decisions requiring the operator

These cannot be resolved by engineering judgment.

1. ~~**Commercial or non-commercial?**~~ **RESOLVED 2026-07-28: non-commercial.** See §1a.
2. ~~**Last.fm commercial terms**~~ **Not required** under §1a. Last.fm stays a discovery pillar,
   subject to the 100 MB cache cap.
3. **Apple Developer D-U-N-S** - weeks of calendar, zero engineering. Still required for store
   distribution regardless of commercial status. Start whenever store release becomes real.
4. **Cloudflare account separation** - separate account for Pull.fm, or accept shared blast radius?
5. **MusicBrainz mirror** - commit to it for 50k, or cap the service at ~10k and say so?
6. ~~**Distribution target**~~ **RESOLVED 2026-07-28: GitHub Releases.** Ship signed APK and
   desktop artifacts as GitHub Release assets rather than through app stores. **Gate S is
   retired**, along with the D-U-N-S wait and the $99 + $25 developer fees.

   What still applies despite leaving the stores: `DELETE /v1/me` and `GET /v1/me/export` stay,
   because GDPR and CCPA require them regardless of distribution channel. What no longer
   applies: privacy nutrition labels, the Data Safety form, reviewer demo accounts, and the
   web-accessible deletion URL Google mandates.

   New obligations this creates: releases must be **signed and reproducible**, the APK signing
   key becomes a critical secret with the same escrow requirement as the KEK, and users get no
   automatic update channel, which makes `GET /v1/config` min-supported-build enforcement more
   important rather than less.
