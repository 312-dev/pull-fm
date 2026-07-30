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
requires a local MusicBrainz data layer. **Corrected 2026-07-29:** this read "a local MusicBrainz
mirror", which meant the CC BY-NC-SA Live Data Feed. It is a local load of the **CC0 canonical
dump** instead, and the difference is a permanent licence change, not a technique. See §3a.

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
revenue and regardless of distribution channel), the contractual document requirements SeatGeek
imposes on any integrator (their 4.3 and 4.4, see §11.7), or any security obligation. **Gate L
remains in force**; Gate S is retired and replaced by Gate R (§11.6).

---

## 1. Decisions locked (v2)

| Area                       | Decision                                                                                                               | Changed?             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Playback**               | 30s previews (iTunes hotlinkable; **Deezer URLs are signed and expire, never cache them**)                             | **[R]** caching rule |
| **Data layer**             | **Neon serverless Postgres 18** (`aws-us-east-1`), branch per environment, Neon's built-in pooler                      | **[R]** see 1c       |
| **Auth**                   | **WorkOS Magic Auth. MAGIC LINK ONLY: no passwords, no social, no passkeys, no SSO.**                                  | **[R]** see §4       |
| **Per-user token storage** | **AES-256-GCM envelope encryption, ciphertext in Postgres.** Infisical removed entirely.                               | **[R]** see §5       |
| **App secrets**            | 1Password -> Nomad variables. No standing secrets service.                                                             | **[R]**              |
| **Compute**                | **Hetzner CAX (ARM64)**, project `pull-fm`. One BFF tier plus one small shared-Redis node                              | **[R]** cost         |
| **Orchestration**          | Nomad v2.0.4 (BSL permits running our own commercial app)                                                              | confirmed            |
| **Backups**                | **Neon instant restore** for the database; R2 keeps the out-of-band logical dumps                                      | **[R]** see 1c       |
| **Discovery**              | **ListenBrainz primary.** Last.fm _contingent_ on commercial terms. MusicBrainz for connections.                       | **[R]**              |
| **Audio features**         | Local Postgres table; AcousticBrainz dumps offline; ReccoBeats cached-on-fetch. **Never a hot-path third-party call.** | **[R]**              |
| **Events**                 | **Client built (SeatGeek), route still 501.** Blocked on Gate L, not on code. See §10e and §11.7.                      | **[R]** see §11.7    |
| **Alerts**                 | ntfy (ops) + Resend (user-facing, deferred)                                                                            | unchanged            |

---

## 1b. Deviations recorded during execution (Gate 0, 2026-07-28)

Four decisions in section 1 did not survive contact with the environment. Each
is recorded here rather than quietly absorbed, with the trigger that would
reverse it.

| Locked in section 1                       | What actually shipped                                  | Why                                                                                                                                                                                                                                                                                               | Reversal trigger                                       |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Orchestration: Nomad v2.0.4**           | **Docker Compose under systemd**, staging only         | Staging is one application node with 2 GB. A single-node Nomad cluster spends 200-300 MB running a scheduler that places one task in the only location it could go. Every megabyte comes out of Postgres' page cache.                                                                             | A second application node, which Gate 6 needs anyway   |
| **App secrets: Nomad variables**          | Root-owned `0600` env files placed from 1Password      | Follows from the above. The capability is unchanged: secrets are still injected as environment, still never in git, still sourced from 1Password.                                                                                                                                                 | Same as above; the compose file maps to a job spec 1:1 |
| **Deploy: implied push**                  | **Pull.** A systemd timer polls the registry every 60s | A push deploy needs an inbound path to the origin and a CI credential with shell access to the node holding every user's OAuth tokens. Section 10's ingress posture exists to ensure neither. CI verifies from the public URL instead.                                                            | None expected; this is stronger, not weaker            |
| **Staging hostnames `*.staging.pull.fm`** | `api-staging.pull.fm`, `app-staging.pull.fm`           | Cloudflare Universal SSL covers `pull.fm` and `*.pull.fm` and nothing deeper, so a two-label hostname has **no edge certificate and never completes a handshake**. The fix Cloudflare sells is ACM at 10 USD/month per zone, about a third of this environment's budget, for a naming preference. | Buy ACM, if the dotted form is ever worth 120 USD/year |

**The hostname finding does not affect production.** `api.pull.fm` is one label
below the apex and Universal SSL already covers it, so section 2's cost model
stands unchanged.

**Verifying from the public URL is the substantive change.** A deploy job that
connects to a node and reports its own exit code proves the deployer ran. The
staging job polls `/healthz` until it reports the commit SHA just built, which
proves that commit is serving real traffic through Cloudflare, the load
balancer, nginx and the container. Gate D should be written the same way.

---

## 1c. Database topology: Neon, not a Hetzner Postgres node (planned 2026-07-29)

**Status: planned and verified, NOT applied.** `terraform plan` is clean against
the live Neon control plane (4 to import, 2 to add, 1 to change, **0 to
destroy**); `terraform apply` is gated on operator sign-off. Full procedure:
[`runbooks/neon-migration.md`](runbooks/neon-migration.md).

The database moves off a self-managed Hetzner node onto **Neon serverless
Postgres 18** in `aws-us-east-1` (Northern Virginia), managed by a fourth Terraform
root at `infra/neon/` with its state in the same R2 bucket as the others.

> **This said `aws-eu-central-1` (Frankfurt) until 2026-07-29.** The service moved
> to a United States posture that day: the live project is `cold-brook-02833828`
> on the paid `launch_v3` plan, and the Frankfurt project was **deleted** rather
> than kept warm. A Neon project's region cannot be changed, so this was a new
> project and a data migration, not a setting. `legal/privacy-policy.md` section 9
> is the authority on what that means for residency, and it is careful about one
> thing this line is not: **object storage is pinned to no jurisdiction at all**,
> so "United States" is true of the database and is NOT true of the backups.

| Was                                             | Is                                                            |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Postgres 17 on a Hetzner node                   | Neon Postgres 18, one project, branch per environment         |
| PgBouncer planned for that node (never shipped) | Neon's pooled endpoint, which _is_ PgBouncer transaction mode |
| pgBackRest to R2 for PITR                       | Neon instant restore; R2 keeps logical dumps                  |
| Staging DB destroyed per gate run               | Staging DB is a branch, reset in seconds                      |
| DB unreachable from the internet by topology    | DB reachable from the internet, guarded by a credential       |

**One Neon project holds both environments.** `main` is the default branch and
serves production; `staging` is a child of it. That is why `infra/neon` is a root
of its own rather than something `envs/staging` and `envs/prod` each own a slice
of: the same reasoning that created `envs/shared` for zone-wide TLS settings.

**The Hetzner data node did not disappear, it shrank.** Postgres left; the two
Redis instances stayed, and the node is now `role=cache` on a smaller type with
no data volume, no whole-machine backups and no delete protection. Folding Redis
into the BFF nodes would have deleted a whole server, and it is not possible:
the quota and rate-limit counters must be counted **once** across every BFF node,
and section 3's MusicBrainz ceiling is the sharp edge. Gate 1 asserts `<=1.0
req/s` egress **for the whole service**, and the token bucket that holds us to it
lives in Redis. Two BFF nodes with private buckets would each honour 1 req/s and
the service would emit 2.

**PgBouncer survives in `docker-compose.dev.yml` and only there.** In the cloud
it would be a second pooler in front of Neon's, for no new capability. Locally it
is the only thing providing transaction-pooling semantics, and those semantics
are not transparent: session advisory locks do not survive `COMMIT`, `SET`
outside a transaction does not persist, `LISTEN`/`NOTIFY` does not work. All of
them fail **silently**, so a laptop on port 5432 passes tests production cannot.
Local dev publishes both ports under the same two variable names the Neon
outputs use, `DATABASE_URL` (pooled) and `DATABASE_URL_DIRECT` (direct).

**The migration runner must use the direct endpoint**, and this is correctness
rather than tuning. `packages/db/scripts/migrate.mjs` takes a session-scoped
`pg_advisory_lock` so two nodes cannot both decide zero migrations are applied.
A transaction pooler hands the connection away at `COMMIT`, so the lock stops
serialising without erroring, and the damage appears only as two concurrent
`CREATE TABLE`s during a deploy.

### Two things this makes worse, stated rather than absorbed

1. **The database is now on the public internet.** The Hetzner node had no public
   IPv4 at all, plus a private network, plus a firewall with no inbound 5432
   rule: three mechanisms, none of which was a credential. A Neon endpoint is
   reachable by anyone holding the connection string. `allowed_ips` is the fix
   and needs a Scale plan; until then the credential is the only control. This
   belongs in `security/accepted-risks.md` with an owner and an expiry.
2. **Role passwords land in Terraform state in plaintext.** Neon returns them
   through its API, so the provider stores them and no setting prevents it. The
   R2 state bucket becomes the trust boundary for the production database
   credential.

### The free plan did not reach production, and the arithmetic is why we left it

> **RESOLVED 2026-07-29: the upgrade this section argues for has happened.** The
> organisation is on **`launch_v3`**, a paid plan. The live figures, read from the
> Neon API rather than the plans page: **5000 branches**, a **16 TiB** logical size
> limit, an **8 CU** autoscaling ceiling, and a **7 day** restore window. In place
> of a plan allowance there is now a **chosen** ceiling: a consumption quota armed
> at 720,000 CU-seconds (200 CU-hours) and 520 GB of egress. Storage is
> deliberately **not** capped, because `logical_size_bytes` bounds a branch for its
> lifetime rather than per period and the canonical loader peaks near 22 GB
> mid-load. The arithmetic below is kept because it is the reasoning that forced
> the upgrade, not a current constraint.

`org-tiny-leaf-89756764` was on `free_v3`: 0.5 GB storage per project, **100
CU-hours per project per month**, 10 branches, a 6 hour restore window, and
scale-to-zero after 5 minutes that cannot be disabled.

Staging-as-a-branch fits comfortably: two branches of ten, a child branch stores
only its diff, and a three-hour gate session at 0.25 CU costs 0.75 CU-hours.
**Production does not fit.** 100 CU-hours at the 0.25 CU floor is 400 hours of
activity; a month is 730. A compute actually serving users exhausts the monthly
allowance in about 17 days, before the 0.5 GB cap meets an architecture whose
premise is that every MBID-keyed fact is stored forever (section 3).

**A paid plan is therefore a Phase 6 prerequisite, not an optimisation.** It is
also what unlocks `allowed_ips`, a PITR window longer than 6 hours, and protected
branches, all three of which are wanted.

**Of those three, one was taken.** The PITR window is 7 days. **`allowed_ips` is
now available and is set to an empty list, which allows everything**, and no branch
is protected. That is a worse failure mode than the plan limitation it replaced,
because a field that exists and is empty reads as configured to anyone who checks
that it exists rather than what is in it.

### What this does not fix

**Section 10d still stands. Gate 4 still cannot pass.** The database half of a
restore drill gets dramatically better - instant restore is seconds against the
30 minutes pgBackRest was budgeted - but the finding in 10d was about the
application node, whose config management is still a manual SSH runbook of
unmeasured length. Replacing the database does not make an unrebuildable node
rebuildable, and claiming otherwise is exactly the kind of adjacent-win
accounting the scorecard rule exists to catch.

### Provider note

**Neon publishes no official Terraform provider.** Their documentation says they
sponsor the community `kislerdm/neon` provider and that it "is not maintained or
officially supported by Neon"; the registry 404s for `neondatabase/neon` and
`neondatabase-labs/neon` (checked 2026-07-29). v0.14.0 is pinned and lock-filed.
The residual single-maintainer risk is bounded: nothing in the data path depends
on the provider, and every resource is importable by a stable Neon identifier.

---

## 2. Corrected cost model

v1 had no dollar figure. At the sizes it named, it would have cost **~$350-550/mo pre-launch**.

| Line item                              | 10k users        | 50k users        |
| -------------------------------------- | ---------------- | ---------------- |
| Compute: 2x CAX21 BFF + 1x CAX11 cache | €40              | €75              |
| Load balancer LB11                     | €7.49            | €7.49            |
| Auth (WorkOS Magic Auth)               | $0               | $0               |
| Auth custom domain (**not purchased**) | $99              | $99              |
| Bot protection (WorkOS Radar)          | ~$0-100          | ~$300            |
| Token encryption (envelope, app-key)   | $0               | $0               |
| R2 backups                             | ~$0              | ~$5              |
| **Database (Neon)** [R]                | $0 (free plan)   | **see 1c**       |
| **Total**                              | **~$148-248/mo** | **~$393-493/mo** |

Without the custom domain and Radar, the floor is **~$60/mo at 10k**, and that floor is the one
that applies: section 4a settles on magic link only, so there is **no hosted AuthKit page to
unbrand** and the $99 custom-domain line is not bought. It is left in the table rather than
deleted because it is the price of reversing 4a, and a decision is easier to hold when its cost is
visible. Radar is the honest line item v1 omitted: a consumer signup form _will_ be attacked.

**[R] The database line is not honestly $0 at either size.** Section 1c shows the
Neon free plan cannot serve production: 100 CU-hours a month is 400 hours of
activity at the 0.25 CU floor, against 730 hours in a month. The table keeps $0
for the 10k column because nothing is serving users yet, and refuses to invent a
figure for 50k rather than guessing at a plan tier. Costing it is a Phase 6 task
with a real traffic shape, and it is tracked as a prerequisite rather than a
surprise.

**Billing alerts are mandatory on every vendor that offers them** before provisioning anything.
Solo operator plus attached card plus no cap is a failure mode. -> **Gate $**

**[R] Neon has the spend cap Hetzner does not.** Gate $ is recorded below as "one
vendor armed, one vendor limitation": Hetzner publishes no budget API and the
console offers no option the operator could find. Neon enforces a per-project
consumption quota server-side, suspending every compute in the project when it is
exceeded, and it is declarable in Terraform (`quota` in `infra/neon`). It is left
unset while the plan is free, because an allowance that simply stops is already a
cap; it should be set in the same change that moves to a paid plan.

**[R] Two of the four vendors have nothing to arm.** Cloudflare's alerts are set and
machine-verified through their API. **Hetzner offers no spend-cap or budget feature reachable by
any means we could find** - every plausible billing endpoint 404s and the console path that
answers 200 returns the SPA shell rather than an API - and the operator could not locate the
option in the console either. WorkOS has no metered dimension at our tier. So Gate $ is not "two
vendors outstanding"; it is **one vendor armed, one vendor limitation, one not applicable, and
one covered by the first**. The real cost control on the Hetzner side is
`./infra/staging-env.sh down`, and `make cost` reads the live Hetzner API on every run so a
resource left running is still detectable. Evidence and probe table:
[`RUNBOOK-COST.md`](RUNBOOK-COST.md).

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
2. A **local load of the CC0 MusicBrainz canonical dump** is the documented MusicBrainz unlock.
   **Corrected 2026-07-29** - this item previously read "a local MusicBrainz mirror", which meant
   the Live Data Feed. See §3a.
3. Preview resolution is a **background job**, never a synchronous request path.
4. Every provider sits behind a **circuit breaker + quota counter + runtime kill switch**.

### 3a. MusicBrainz discovery is local-first over CC0 data, with the API as fallback

**Corrected 2026-07-29.** The v2 plan named a "local MusicBrainz mirror" as the 50k unlock and
budgeted it at ~50 GB plus replication. A mirror means the **Live Data Feed**, and the Live Data
Feed replication packets are **CC BY-NC-SA 3.0**, not CC0. Loading them would attach attribution,
NonCommercial and ShareAlike obligations to the entire local database and to everything derived
from it, **permanently and irreversibly**. That would take §1a - a reversible operator decision -
and convert it into an irreversible technical one made by whoever ran the import. Full evidence in
[`compliance/metabrainz-terms-review.md` F5](./compliance/metabrainz-terms-review.md#f5-a-mirror-is-not-cc0)
and the licence split in [`UPSTREAM-TERMS.md` M1-M3](./UPSTREAM-TERMS.md).

**The shape now being built:**

```
resolve(name) ->  1. mbid_crosswalk            (already resolved once, permanent)
                  2. mb.canonical              (local CC0 dump, refreshed fortnightly)
                  3. MusicBrainz web service   (1 req/s, global, the residue only)
```

Layers 1 and 3 exist. **Layer 2 is being built, not running.** As of 2026-07-29 the schema
migration and the lookup-key reproduction are in the tree and the loader is not finished; the
layer ships behind a **feature flag that defaults OFF**, and with the flag off the resolver
behaves exactly as it does today. Do not describe this as a live capability, and do not count its
hit rate in any gate until the flag is on in staging with a loaded table behind it.

**Why the canonical dump specifically, and not the full export:**

| Property          | Canonical dump                                     | Live Data Feed / `mbdump-derived`                        |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Licence           | **CC0 1.0**, verified from the archive's `COPYING` | **CC BY-NC-SA 3.0**                                      |
| MetaBrainz signup | **None.** Anonymous HTTPS, `HTTP 200`              | Access token required for the Feed                       |
| Size              | 2.32 GB compressed, one CSV                        | 6.88 GB core + 0.47 GB derived, or streaming replication |
| Refresh           | Fortnightly file, re-load and swap                 | Continuous replication to keep running                   |
| Encumbrance       | None. CC0 attaches nothing downstream              | Permanent, irreversible, forecloses commercial use       |

The CC0 status is **verified, not assumed** - the 2026-07-28 review asserted it without a source,
and that gap was closed on 2026-07-29 by extracting the `COPYING` file from inside the published
archive (`sha256 75f3c90d...`, verbatim "Creative Commons Legal Code / CC0 1.0 Universal") and
corroborating it against `metabrainz.org/datasets/derived-dumps`.

**Two consequences to design around rather than discover:**

- **Freshness is bounded at about 14 days.** The dump is published twice a month and only two are
  retained; on 2026-07-29 the newest was 12 days old. This is tolerable **because MBIDs are
  permanent** - a stale dump yields a miss, never a wrong answer - **and because every miss falls
  through to layer 3**, which is live. The residue is that music released in the last fortnight
  resolves against the 1 req/s API, which is the worst possible distribution for a discovery
  product and should be watched as a hit-rate metric, not assumed away.
- **No genre data.** `mbdump-derived.tar.bz2` is where genre associations live and it is BY-NC-SA,
  so it is not taken. **Any roadmap item that ranks, filters or clusters by MusicBrainz genre is
  foreclosed** unless this decision is reopened explicitly, dated, by the operator, the way §1a was.
  It is not foreclosed by accident and it must not be un-foreclosed by accident either.

---

## 4. Auth: WorkOS Magic Auth, magic link ONLY [R]

The audit confirmed WorkOS is genuinely free at our scale with no per-org or per-connection fee
for B2C. It also found that **WorkOS does not export password hashes** and provides no path out,
while shipping polished tooling to import _in_.

**Resolution: never issue a password.** That half is unchanged and still load-bearing:

- **No hashes exist**, so there is nothing to be held hostage. Lock-in structurally evaporates:
  users re-link by email address at any future provider.
- **Removes an entire vulnerability class**: no password storage, reset flow, or stuffing surface.
- **Preserves the existing WorkOS setup and credentials** already in 1Password.

### 4a. The sign-in set is MAGIC LINK ONLY. Do not re-add social login or passkeys.

This section previously read "Google + Apple OAuth and magic-link only", with "social sign-in is
what a music app's users expect" as a supporting argument. **That is superseded.** The decision is
**WorkOS Magic Auth and nothing else**, and it is load-bearing rather than a preference, so the
reasoning is written out here to stop it being re-added as a helpful improvement.

**Social login costs the property the whole client design is built on.** Magic Auth is a plain
server-to-server call: we collect an email address on a screen we render, WorkOS emails a code,
the user types it into a screen we render, and we exchange it. The user never leaves the
application and never sees a hostname that is not ours. Social login cannot work that way. It
requires a browser redirect to a **WorkOS-hosted AuthKit page**, which means:

- a **third-party domain in the iOS consent dialog** and in browser chrome during sign-in, which
  is precisely the shape users have been trained to recognise as phishing; and
- **99 USD/month** for a WorkOS custom domain to unbrand it, which a non-commercial project with
  no revenue (section 1a) does not have.

"Better consumer UX" was the argument for social login. A redirect to somebody else's domain
during sign-in is not better UX, and paying 99 USD/month to hide it is not available.

**Passkeys are bound to the domain, and we do not own our final one yet.** A passkey is bound to
its Relying Party ID, which is a domain name. WorkOS documentation states outright that adding a
domain later **"would prevent the usage of passkeys that were registered on the old domain"**.
Enrolling passkeys before the project owns a settled custom domain would therefore invalidate
**every existing passkey** on any later move, with no migration path and nothing to offer users
but re-enrolment of the entire base. Deferring costs nothing and keeps the option open.

**Both are DEFERRED, not rejected.** What would have to become true to revisit: social login needs
the custom domain to be affordable, or the third-party redirect to become acceptable; passkeys
need the domain to be settled first.

**This is enforced, not merely documented**, by three independent controls, so the doc and the
code point at each other:

| Control                                                                                                                                                          | What it forbids                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `there is no password, social, or passkey route` in [`apps/bff/test/integration/magic-auth.test.ts`](../apps/bff/test/integration/magic-auth.test.ts)            | Any registered route whose path contains `password`, `signup`, `register`, `oauth`, `passkey`, `webauthn` or `sso` |
| `users_auth_method_chk` in [`packages/db/migrations/0005_magic_auth_identity.sql`](../packages/db/migrations/0005_magic_auth_identity.sql)                       | Any `users.auth_method` value but magic auth, so widening the set is a schema change and therefore a review        |
| The headers of [`apps/bff/src/routes/v1/auth.ts`](../apps/bff/src/routes/v1/auth.ts) and [`apps/bff/src/services/workos.ts`](../apps/bff/src/services/workos.ts) | The full argument, at the place someone would edit to add a provider                                               |

Anyone adding a sign-in method has to change this section, a test, and a migration. That is the
intended cost.

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
DELETE /v1/me                     [R] account deletion + cascade   <- GDPR Art.17
GET    /v1/me/export              [R] GDPR/CCPA portability; returns a single-use ticket
GET    /v1/me/export/download     [R] serves the document (M17: not synchronous on the GET)
POST   /v1/tokens                 [R] personal API tokens, shipped; session-only
GET    /v1/tokens                 [R] metadata only, never the secret
POST   /v1/tokens/:id/rotate      [R]
DELETE /v1/tokens/:id             [R]
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
GET /v1/artists/:mbid/events      -> 501; session-only, NEVER token-reachable (SeatGeek 4.7)
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
TRACK L (parallel, day 0)          -> Gate L, Gate R, Gate $
  Last.fm commercial terms email    <- NOT REQUIRED under §1a
  Apple/Deezer preview ToS decision <- RESOLVED by §1a
  Privacy policy | EULA/ToS | DPAs | EU Art.27 rep     <- blocks SeatGeek events
  Signed + reproducible releases, signing-key escrow   <- replaces Gate S
  Billing alerts on all vendors

Phase 0  Foundations + real CI/CD. Staging only.        -> Gate 0, Gate D
Phase 1  Data plane: Neon project + branches + migrations
         + shared Redis. PITR is Neon's, not pgBackRest. -> Gate 1, Gate 4
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

| Gate      | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**     | `terraform plan` exits 0 with zero drift on clean checkout; `curl -sf https://api-staging.pull.fm/healthz` returns 200 with valid cert (hostname changed, see section 1b); testssl.sh >= A; commit to `main` auto-deploys to staging in <10 min with no human step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **1**     | Migrations apply up **and down** cleanly in CI; a 10,000-request burst to the MB queue measures **<=1.0 req/s egress at the network layer** over 10 min with zero dropped jobs; the transaction pooler serves >=200 client conns on <=25 server conns (Neon's pooled endpoint in the cloud, PgBouncer locally)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2**     | OpenAPI 3.1 spec is source of truth; 100% of documented endpoints have contract tests; every endpoint has defined+tested behaviour for upstream 429/500/timeout; **warm cache hit >=90%**, cold-cache p95 <2s over a 1,000-request replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **3**     | E2E signup -> connect -> non-empty feed passes in CI; **BOLA suite enumerates every user-scoped route from the OpenAPI spec** and asserts 403/404 for a foreign subject on 100% of them, failing CI if any route lacks a test; `pg_dump \| grep <known-test-token>` returns 0; 24h of logs grep to 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **4**     | Restore from R2 into a fresh node completes **<30 min wall clock, timed**; row-count+checksum matches primary; RPO <=5 min verified by killing the primary mid-write; drill re-runs monthly and alerts on failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **5**     | Each of a **named list** of alert conditions fires to ntfy **within 60s** when triggered synthetically, evidenced by a timestamped log; every alert has a runbook URL returning 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **6**     | Maintenance flag -> 100% of requests 503 with `Retry-After` within 60s; cleared -> 100% 200 within 60s; **rolling deploy under sustained load produces zero non-2xx**; replica promotion <5 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **7**     | Under a failure-injection matrix (each upstream forced to 429/500/timeout in turn) `/feed` returns 200 with degraded sections, p95 <800ms, errors <1%, no pool exhaustion, recovery <60s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **8**     | Zero high/critical from Semgrep, Trivy, gitleaks, ZAP baseline with **pinned tool versions**; every accepted risk in `security/accepted-risks.md` has an owner and **expiry date**, and CI fails on an expired entry; Observatory >= A+                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **L**     | Privacy policy + **Application EULA** at stable URLs; the EULA satisfying their 4.3 in the exact terms quoted in §11.7 (displayed, **accepted before use**, **at least as protective of the SeatGeek Entities as SeatGeek's own API Terms** including warranty disclaimers and limitations of liability, **expressly designating them as third-party beneficiaries entitled to enforce it against End Users directly**, plus reasonable enforcement efforts and no unauthorised action, collection or device access) and the policy accurate against the schema (their 4.4); DPAs on file; every `[OPEN]` in `legal/privacy-policy.md` closed; `DELETE /me` and `GET /me/export` verified end-to-end including cascade to WorkOS, Redis, and logs; documented backup-retention position with a **configured** PITR window |
| ~~**S**~~ | **RETIRED.** Distribution is GitHub Releases, not app stores (§11.6). Replaced by Gate R.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **R**     | Every release artifact is **signed**, the signature verifies from a published key, and a **rebuild from the tagged commit reproduces byte-identical artifacts** in CI; the signing key is escrowed in two places like the KEK (`PULLFM-RISK-003`) and a key-loss procedure is written; `GET /v1/config` min-supported-build enforcement is tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **$**     | Billing alerts on **every vendor that offers them**, machine-verified; a vendor with no such feature is recorded as a vendor limitation with the probe evidence, not left as an open task; `make cost` reads the live API so drift is detectable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **D**     | Commit to `main` reaches prod through staging with a migration step and **a rollback verified by executing one**; no manual SSH                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

**Confirmed working:** `pull.fm` is an active Cloudflare zone, delegated from Porkbun. The zone id
is deliberately not recorded here; read it from `terraform output` or the provider API. Terraform plans clean against the real APIs: **22 to add, 0 to change,
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

## 10c. Staging is ephemeral (decided 2026-07-28)

Staging exists to run gates, not to serve traffic. A standing environment costs
about **EUR 35/mo to sit idle**; Hetzner bills hourly, so a three hour gate
session costs about **EUR 0.15**. Realistic usage lands near **EUR 1-2/mo**, a
95 percent saving with no architectural loss.

This is not a compromise: rebuilding from IaC is already a Gate 4 requirement,
so tearing down exercises the capability we have to prove anyway. Keeping
staging permanently running was the unusual choice, not destroying it.

```bash
./infra/staging-env.sh up      # provision for a gate run
./infra/staging-env.sh down    # destroy compute, keep backups and DNS
./infra/staging-env.sh cost    # current run rate
```

**Survives teardown:** the R2 backup bucket (free, and destroying it would make
the Gate 4 restore drill meaningless), Terraform state, and out-of-band DNS
records that Terraform does not manage.
**Does not survive:** servers, load balancer, private network, **the four
Terraform-managed DNS records**, and the contents of the staging Redis
instances. If a teardown loses something that mattered, it belonged in R2.

**Correction, 2026-07-29: "all staging Postgres data" used to be on the second
list and is no longer on either.** The staging database is a Neon branch
(section 1c). `staging-env.sh` does not create it and does not destroy it,
because the argument for destroying it does not survive the move: a Hetzner node
costs EUR 35/mo to sit idle, while a branch costs the storage of its diff from
its parent and suspends its compute after five minutes. **Continuing to tear it
down would be keeping the mechanism after its justification had gone.** When
staging data does need discarding the operation is a branch reset from `main`,
which takes seconds and returns a copy-on-write clone of production rather than
an empty database, so it is both faster and a better test than the rebuild it
replaces. The Hetzner half of `down` is unchanged and still correct: that
compute is still billed by the hour.

**Correction, 2026-07-29: DNS used to be on the survives list and that was
wrong.** A targeted `terraform destroy` destroys the targets **and everything
that depends on them**, and each DNS record's content is the load balancer
address. Keeping `module.dns` off the destroy list therefore protected nothing;
it only made the header untrue. `up` recreates all four records in the same run
that recreates the load balancer, so the practical outcome is unchanged and the
claim is now accurate. `infra/staging-env.sh` carries the same note at the point
where the target list is computed.

**Enabling change:** Terraform's `prevent_destroy` was removed from the compute
module. It is a static meta-argument that cannot vary per environment, so
keeping it would have made staging impossible to tear down. Hetzner's
`delete_protection` replaces it, is variable-driven, and is strictly stronger
because it also blocks deletion through the console, the CLI, and the raw API
rather than only through this repository. Production sets it true; staging false.

**Correction, 2026-07-29: "staging false" was written here but never wired.**
Until commit `f7d2c9c` the environment roots did not pass the delete-protection
variables at all, so the module defaults (`true`) applied to staging as well. The
first real `down` consequently **stopped halfway**, destroying the app node,
firewalls and DNS while leaving the database node and load balancer running at
**EUR 21.98/mo**, and Hetzner enforces the flag at the API, so the Terraform
graph that would have cleared it was already half destroyed by then. A cost
control that fails halfway is worse than none: the run rate looks like a partial
saving rather than a broken teardown. `envs/staging/variables.tf` now sets all
three to `false` and `envs/prod/variables.tf` sets all three to `true`, and a
full `down` reaches EUR 0.00 in one pass. **This section stated the intent for a
day before anything implemented it**, which is the exact failure mode the
scorecard's "green means machine-checked" rule exists to catch.

**Production sizing, for later:** a single `cpx22` (EUR 22.99/mo) is expected to
be sufficient. The cache-first architecture means upstream quota binds long
before CPU does, so scaling pressure arrives as a licence problem rather than a
compute one.

---

## 10d. The rebuild drill failed, and Gate 4 cannot pass today (measured 2026-07-29)

Section 10c argued that tearing staging down "exercises the capability we have
to prove anyway". That was correct, and this is the result of exercising it: the
capability is not there.

| Step                                       | Result                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `./infra/staging-env.sh down`              | 19 resources destroyed, run rate to **EUR 0.00/mo**                                                    |
| `./infra/staging-env.sh up`                | **45 seconds**, 19 resources created, load balancer reclaimed the same IPv4                            |
| `curl https://api-staging.pull.fm/healthz` | **HTTP 525 for five straight minutes** - Cloudflare could not complete a TLS handshake with the origin |
| Hetzner load balancer target health        | **unhealthy on both 80 and 443**                                                                       |

**Why.** Terraform's job ends at a booted node. nginx, the origin certificate,
the BFF container, the deploy timer, and the Redis and Postgres services are all
applied by **a human over SSH**. cloud-init deliberately installs none of it,
because that would put `/etc/pullfm/bff.env` - the KEK, the WorkOS key,
`DATABASE_URL` - into `user_data`, which is persisted in Terraform state and
readable from the Hetzner API for the life of the server. **That decision is
right.** What is missing is the automated, secret-free path that should have
replaced it.

**And there is no way in.** The rebuilt node has no public SSH: the firewall
carries no port 22 rule and Tailscale is not installed, because
`tailscale_auth_key` is empty in every committed configuration. Bootstrapping a
rebuilt environment means putting an operator `/32` into `ssh_allowlist_cidrs`
in a local tfvars, applying, bootstrapping by hand, and taking it back out.

**Consequences for the gates, stated rather than absorbed:**

- **Gate 4 cannot pass.** "Restore from R2 into a fresh node in under 30 minutes,
  timed" requires a node that serves traffic. The infrastructure half rebuilds in
  45 seconds; the half that makes it serve is a manual runbook of unmeasured
  length that has never been timed. It is not "not started", it is **measured and
  failing**, which is a more useful status.
- **Gate 0 still holds.** Its criteria describe a _running_ environment and say
  nothing about recreating one. That is a real limitation of how Gate 0 was
  written, not a loophole being exploited: an environment can satisfy every Gate
  0 assertion and still be unrebuildable.
- **Gate 6 inherits the problem.** A rolling deploy and a replica promotion both
  assume a node can be brought into service without a human.

**The fix is config management, not more Terraform.** The node must converge on
its own from a signed, secret-free artifact, pulling secrets at first boot the
same way `pullfm-deploy` already pulls images. Setting `tailscale_auth_key` would
restore a way in, but a way in for a human is not a rebuild, and treating it as
one is how this gap stayed invisible. Owned by the infrastructure work stream;
this section records the finding, not the fix.

Staging is currently left **DOWN**, which is the correct end state for an
environment that cannot rebuild itself: up and broken is worse than down.

---

## 10e. Personal API tokens shipped, and the one thing they must never serve

A per-user read-only API token surface shipped in commit `fe928f2`
(`POST /v1/tokens`, list, rotate, revoke; `pfm_live_` / `pfm_test_` prefixes;
SHA-256 digest storage; mandatory expiry; per-token rate limiting on the
`noeviction` quota Redis). Design and rationale:
[`api/personal-api-tokens.md`](api/personal-api-tokens.md). A matching gitleaks
detection rule shipped in `afdaa22`.

**SeatGeek event data must never be exposed through it.** SeatGeek API terms
**4.7** (Rules of Conduct; cited as "7.13" here until 2026-07-29, when the real
terms were read and section 7 turned out to be Suspension and Termination)
prohibit making their materials available to "a search engine, directory, or
AI or machine learning application or model", and a general-purpose token surface
is precisely the path by which a third party's integration puts data somewhere
that clause forbids. This is not satisfiable by intending well: the moment a
token holder can retrieve SeatGeek-derived data, we have lost control of where it
goes.

Enforced today by two independent mechanisms, which is the right number for a
contractual restriction:

1. `GET /v1/artists/:mbid/events` declares `allow: ["session"]`, so a `pfm_`
   credential is refused with 403 before the handler runs.
2. The route is unconditionally 501 while no events provider is enabled.

**What is not enforcement:** `EventsProviderMetadata.redistributionRestricted` is
set on the SeatGeek provider and **read nowhere**. It documents the intent at the
integration point; it does not check anything. If the events route is ever
enabled, the session-only restriction is the whole control, and it should be
covered by an explicit test rather than by the route's 501 status.

---

## 11. Open decisions requiring the operator

These cannot be resolved by engineering judgment.

1. ~~**Commercial or non-commercial?**~~ **RESOLVED 2026-07-28: non-commercial.** See §1a.
2. ~~**Last.fm commercial terms**~~ **Not required** under §1a. Last.fm stays a discovery pillar,
   subject to the 100 MB cache cap.
3. ~~**Apple Developer D-U-N-S**~~ **Moot under item 6.** Required only for store distribution,
   which is no longer the plan. Reopen only if the store channel is ever reconsidered.
4. **Cloudflare account separation** - separate account for Pull.fm, or accept shared blast radius?
5. ~~**MusicBrainz mirror** - commit to it for 50k, or cap the service at ~10k and say so?~~
   **RESOLVED 2026-07-29: neither. No Live Data Feed mirror, ever, at any scale.** The mirror was
   never only a cost question - it is a permanent licence change from CC0 to CC BY-NC-SA on the
   whole local database. The scaling answer is a local load of the **CC0 canonical dump** with the
   1 req/s API as fallback; see §3a. **What remains open is narrower and is a product question, not
   an infrastructure one: genre.** A licence-clean import carries no genre associations, so if a
   genre-driven feature is ever wanted, the operator must either source genre from another provider
   or reopen this decision and accept BY-NC-SA in writing.
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

   **These are not softer than Gate S, they are differently shaped.** A store rejects a bad
   build; GitHub Releases does not, so signing and reproducibility are the only things standing
   between a user and a substituted artifact. The signing key inherits `PULLFM-RISK-003` in full:
   losing it means every existing install is stranded on a key nobody can renew, and disclosing it
   means an attacker can publish an update that our own users' clients will accept. Escrow it
   exactly like the KEK, in two places, and write down the "we lost the signing key" procedure
   before it is needed. **None of this is machine-checked yet**, so it is tracked in the scorecard
   as a new gate rather than folded into a retired one.

7. **SeatGeek events are blocked on Gate L, not on engineering.** The events client, the terms
   digest, the personal-data guard and the attribution type all shipped in `9c2bb9e`, and the
   route is still 501. It cannot be enabled until two documents exist at stable URLs, because
   SeatGeek's terms make them contractual preconditions rather than good practice:

   - **4.4** requires a **Privacy Policy** that accurately discloses what we collect, store, use
     and disclose.
   - **4.3** requires an Application EULA that the Application displays and that each End User
     must accept before using it, containing terms - expressly including warranty disclaimers and
     limitations of liability - **at least as protective of the SeatGeek Entities as SeatGeek's own
     API Terms**, complying with any third-party app-store requirements, and **expressly
     designating the SeatGeek Entities as third-party beneficiaries entitled to enforce it against
     End Users directly**; plus (i) all reasonable efforts to enforce it and (ii) no action on
     behalf of, collection of information from or regarding, or device access for any End User
     without that End User's affirmative authorisation.
   - **4.2** lets SeatGeek review the Application and **require changes to it** as a condition of
     continued access, and **12.2** gives us **six months** to bring any cause of action against
     them, under New York law in New York County. Neither has an engineering mitigation; both are
     recorded so a launch decision is made knowing them.

   **The 4.3 wording above is quoted, and until 2026-07-29 it was not.** The terms 403 every
   automated fetch, so every prior analysis worked from a paraphrase in which 4.3 was not marked
   verbatim, and this repository rendered the same requirement three different ways: the full
   standard in `SCORECARD.md`, "naming the SeatGeek Entities as third-party beneficiaries" in the
   Gate L row of this document, and no protectiveness standard at all in the vendor-spec digest.
   The cost was concrete rather than stylistic - `legal/terms-of-service.md` section 13 capped the
   SeatGeek Entities at USD 100 while their own clause 8.2 caps them at USD 50, so the clause
   drafted to satisfy 4.3 breached it. The verbatim text is now at
   [`../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md)
   and this rendering, the Gate L row in §11.6's table, `SCORECARD.md` and the banner of
   `legal/terms-of-service.md` are word-identical. **Edit all four or none.**

   **Duty (ii) is the one nobody had recorded, and we currently fail it.** There is no consent
   step anywhere in the product - distribution is a sideloaded GitHub Release - so information is
   collected from End Users without affirmative authorisation, and the EULA is neither displayed
   nor accepted. That is the same gap as the `[OPEN]` in `legal/terms-of-service.md` section 1,
   arriving from the contract side instead of the contract-formation side, and it is a hard
   blocker on enabling events rather than a drafting note.

   Drafts of both now exist in [`../legal/`](../legal/), unreviewed. The privacy policy carries an
   appendix of `[OPEN]` items where the system does not yet do what a policy would have to claim -
   an unbounded `audit_log` holding post-deletion IP addresses, no configured log retention, no
   deployed backup system and therefore no PITR number, and no DPAs on file. **Those are code and
   paperwork tasks, and each one is a sentence that cannot honestly be published until it is
   closed.** A privacy policy that misdescribes the system is a false statement of fact, which is
   materially worse than not having one.

   **Two of those four closed on 2026-07-29 and 2026-07-30.** There is a PITR number, 7 days, and
   all four processor agreements are in writing and dated. The other two, log retention and the
   `audit_log` IP purge, are still open. The appendix in `legal/privacy-policy.md` is the current
   list; this paragraph is not, and should be read against it rather than instead of it.

8. **Where the legal documents live.** Gate L requires "stable URLs". Serving them from
   `pull.fm/legal/*` versus rendering this directory is undecided, and the commitment that matters
   is that the URL never moves once a user has agreed to it.
