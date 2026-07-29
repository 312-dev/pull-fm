# Runbook: disaster recovery (Gates 4 and 6)

> **Gate 4 criterion:** restore from R2 into a fresh node completes **under 30
> minutes wall clock, timed**; row count and checksum match the primary; RPO <= 5
> minutes verified by killing the primary mid-write; the drill re-runs monthly
> and alerts on failure.
>
> **Status: FAILING, and measured.** See section 2. This is not "not started".
> The drill was run, and it did not come back healthy.
>
> **pgBackRest is not deployed and will not be.** The database moved to Neon on
> 2026-07-29 (`PLAN.md` section 1c), which takes its own point-in-time backups,
> so `wal_level`, `archive_command` and a pgBackRest stanza no longer describe
> anything that exists. **Section 5 is superseded** by
> [`runbooks/neon-migration.md`](runbooks/neon-migration.md) and is left in place
> only until it is rewritten against Neon; do not follow it. Sections 6 and 7,
> which are about the application node, are unaffected and are still the parts
> that are failing.

---

## 1. Recovery objectives, and what they are worth today

|                         | Target        | Actual                                                                 |
| ----------------------- | ------------- | ---------------------------------------------------------------------- |
| **RPO** (data loss)     | <= 5 minutes  | **Unbounded. There are no backups.** WAL archiving is not enabled.     |
| **RTO** (time to serve) | <= 30 minutes | **Unknown and untimed.** The manual bootstrap has never been measured. |

Stated plainly because a recovery objective nobody has measured is a wish. The
compensating facts, such as they are:

- Staging holds nothing that is not reproducible, which is why it is destroyed
  routinely.
- **Prod has never been applied**, so there is no production data to lose yet.
- The window in which "we have no backups" is acceptable closes the moment the
  first real user account exists. That is the deadline on this runbook, not a
  phase number.

---

## 2. The finding: an environment that cannot rebuild itself

Measured 2026-07-29, by doing it:

| Step                                       | Result                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `./infra/staging-env.sh down`              | 19 resources destroyed, run rate EUR 0.00/mo, R2 bucket survived |
| `./infra/staging-env.sh up`                | **45 seconds**, 19 resources created, LB reclaimed the same IPv4 |
| `curl https://api-staging.pull.fm/healthz` | **HTTP 525 for five straight minutes**                           |
| Hetzner LB target health                   | **unhealthy on both 80 and 443**                                 |

**Why.** Terraform's job ends at a booted node. nginx, the origin certificate,
the BFF container, the deploy timer, Redis, and Postgres are all applied by a
human over SSH. cloud-init deliberately installs none of it, because that would
put `/etc/pullfm/bff.env` (the KEK, the WorkOS key, `DATABASE_URL`) into
`user_data`, which is persisted in Terraform state and readable from the Hetzner
API for the life of the server. **That decision is correct.** What is missing is
the automated, secret-free path that should have replaced it.

**And there is no way in.** The rebuilt node has no port 22 rule and no
Tailscale, so bootstrapping requires the break-glass procedure in
[`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md) section 7.

**The fix is config management, not more Terraform.** The node must converge on
its own from a signed, secret-free artifact, pulling secrets at first boot the
same way `pullfm-deploy` already pulls images. Setting `tailscale_auth_key` would
restore a way in, but **a way in for a human is not a rebuild**, and treating it
as one is how this gap stayed invisible through a green Gate 0.

Staging is currently left **DOWN**. For an environment that cannot rebuild
itself, up and broken is worse than down.

---

## 3. Scenario index

Find the row that matches, then read that section. Ordered by how bad it is, not
how likely.

| #   | Scenario                                 | Recoverable?                                                         | Section                                           |
| --- | ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | **KEK lost** (both escrow copies)        | **NO.** Every stored third-party credential is permanent ciphertext. | [4](#4-key-loss-the-only-truly-unrecoverable-one) |
| 2   | **KEK disclosed**                        | Yes, by rotation                                                     | [4](#4-key-loss-the-only-truly-unrecoverable-one) |
| 3   | Database corrupted or wrong data written | Yes, PITR                                                            | [5](#5-restoring-postgres)                        |
| 4   | Database node lost entirely              | Yes, restore to a new node                                           | [5](#5-restoring-postgres)                        |
| 5   | Application node lost                    | Yes, rebuild - but see section 2                                     | [6](#6-rebuilding-the-application-node)           |
| 6   | Whole Hetzner project lost               | Yes, in principle                                                    | [7](#7-whole-environment-loss)                    |
| 7   | **Cloudflare account suspended**         | Partially. DNS, TLS, R2 backups and the edge all go at once.         | [8](#8-cloudflare-account-loss-pullfm-risk-001)   |
| 8   | R2 backup repository lost                | Only if Postgres is alive                                            | [5](#5-restoring-postgres)                        |
| 9   | WorkOS unavailable                       | Existing sessions survive; nobody new can sign in                    | [9](#9-vendor-unavailability)                     |
| 10  | Upstream provider revokes us             | **Product-ending, not operational**                                  | [9](#9-vendor-unavailability)                     |
| 11  | **Operator unavailable**                 | Bus factor 1                                                         | [10](#10-bus-factor-1)                            |

---

## 4. Key loss: the only truly unrecoverable one

The KEK is a 256-bit application key that wraps every per-user data key. It lives
in 1Password and in one offline copy, both held by one person
(`PULLFM-RISK-003`).

**If both copies are lost**, every stored ListenBrainz token and Last.fm session
key becomes permanent ciphertext. No backup helps: the backups contain the same
ciphertext. The only recovery is to have every user reconnect every service, and
the honest framing is that this is not a recovery, it is a data loss with a
re-onboarding.

**Prevention, which is the entire control:**

- Two independent escrows, one of them offline and held separately from the
  laptop.
- A printed 1Password Emergency Kit and a nominated account recovery contact.
- **Verify both copies are readable at every risk review.** An untested escrow is
  not an escrow, and this is the single most valuable ten minutes in this
  document.

**If the KEK is disclosed** (as opposed to lost), the answer is rotation, and
this is why `kek_id` exists in the schema from day one. Rotation re-wraps data
keys and never touches token plaintext, so it is an online operation, and the
`user_connections (kek_id)` index drives the backfill.

`[OPEN]` **The rotation drill has never been rehearsed.** `PULLFM-RISK-003`'s
review notes say that if it has not been, the risk should be rated **critical**,
because rotation is the only incident response available for a suspected KEK
disclosure. Rehearse it against staging before it is needed, and record the
elapsed time here.

The same escrow requirement now extends to the **release signing key**
(Gate R): losing it strands every existing install on a key nobody can renew.

---

## 5. Restoring Postgres

> **SUPERSEDED, 2026-07-29. DO NOT FOLLOW THIS SECTION.**
>
> Everything below assumes a self-managed Postgres node with a pgBackRest
> repository in R2. The database is Neon now. The replacement for a
> point-in-time restore is Neon instant restore, which is a control-plane
> operation measured in seconds rather than the 30 minutes budgeted here, and
> its window is `history_retention_seconds` in `infra/neon` (6 hours on the
> current plan). The replacement for "restore into a fresh node" is a branch
> reset. Both are in
> [`runbooks/neon-migration.md`](runbooks/neon-migration.md) sections 7 and 8.
>
> **The 6 hour window is narrower than the retention this section assumed**,
> which is the one respect in which the new position is worse and the reason the
> runbook requires an out-of-band logical dump to R2 before any destructive
> operation. This section is kept unedited rather than deleted so the rewrite is
> a diff against something rather than a blank page.

**This procedure has never been executed and pgBackRest is not deployed.** It is
the intended shape, written from the configuration that exists.

### Prerequisites you must have off the affected machine

|                                              | Where it lives                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 access key pair for the backup repository | 1Password. **Created by hand deliberately**: minting it through the Cloudflare provider would write the secret into Terraform state in plaintext, and a backup credential is the one credential that must survive the loss of everything else. |
| pgBackRest repository cipher key             | 1Password                                                                                                                                                                                                                                      |
| The KEK                                      | 1Password + offline escrow                                                                                                                                                                                                                     |
| Terraform state                              | R2 for `envs/staging`; **local for `shared` and `prod`**                                                                                                                                                                                       |

### Procedure

```bash
# 1. Stand up a fresh database node.
cd infra/terraform/envs/staging && terraform apply

# 2. Bootstrap it. This is the manual step, and it is the one that has never
#    been timed. See section 2.
#    infra/staging/db/bootstrap.sh

# 3. Point pgBackRest at the R2 repository and confirm it can see the stanza.
pgbackrest --stanza=pullfm info

# 4. Restore. Latest:
pgbackrest --stanza=pullfm restore
#    Or to a point in time, which is what you want after a bad migration or a
#    wrong DELETE:
pgbackrest --stanza=pullfm --type=time \
  --target="2026-07-29 14:30:00+00" restore

# 5. Start Postgres and let it replay WAL.

# 6. VERIFY BEFORE SERVING TRAFFIC. See below.
```

### Step 6 is the step, and it has two parts

**Part one, correctness.** Row counts and checksums against what the primary had.
A restore that starts is not a restore that worked.

**Part two, and this one is a legal obligation rather than a technical one:**

```sql
-- Re-apply every erasure the restored snapshot predates.
SELECT deleted_user_id FROM deletion_log;
```

`deletion_log` is the authoritative replay list. **Every user id in it must be
re-deleted before the restored system serves traffic.** It deliberately has no
foreign key to `users`, so those rows survive the deletions they record. This is
what makes an erasure durable across a restore, which is the property GDPR
Article 17 actually cares about, and it is the specific claim
[`../legal/privacy-policy.md`](../legal/privacy-policy.md) section 7 makes to
users. Skipping it un-deletes people who asked to be gone.

### Timing the drill

Gate 4 wants **under 30 minutes, timed**. Time it with a clock, from the decision
to restore to a 200 from `/healthz`, and write the number in `SCORECARD.md`. An
untimed restore does not close this gate no matter how well it goes.

---

## 6. Rebuilding the application node

```bash
./infra/staging-env.sh up      # 45 seconds, and then it serves nothing
```

Then the manual bootstrap, which is the untimed part: nginx, the Cloudflare
origin certificate, the container, `/etc/pullfm/bff.env`, and the deploy timer.
See `infra/staging/README.md` and section 2 above.

**Once `pullfm-deploy.timer` is running, the application recovers itself**: it
polls the registry every 60 seconds and pulls the current build. That part of the
design works and is worth keeping in view, because the gap is narrower than "we
cannot rebuild": it is precisely the secret-bearing configuration layer between a
booted node and a running deploy agent.

**Symptom guide during a rebuild:**

| Symptom                              | Meaning                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **525**                              | Cloudflare cannot complete TLS with the origin. The origin certificate or nginx is missing. This is the signature of the Gate 4 failure. |
| **521**                              | Origin refused the connection. nginx is not running.                                                                                     |
| **522**                              | Origin did not answer. Firewall or the node is not up.                                                                                   |
| **503 with `Retry-After`**           | Maintenance mode, deliberately. Not a fault.                                                                                             |
| **`/healthz` 200 but `/readyz` 503** | The app is up and a dependency is not. `checks` names which.                                                                             |

---

## 7. Whole environment loss

Order matters, because each step depends on the previous one existing:

1. **Terraform state.** Without it, Terraform will try to create resources that
   already exist. `envs/staging` state is in R2. **`shared` and `prod` are local
   and would have to be reconstructed by import**, which is slow and error-prone.
   Migrating them is the single highest-value infrastructure task in this
   document.
2. **Credentials**, from 1Password: Hetzner token, per-environment Cloudflare
   tokens, R2 keys, WorkOS keys, the KEK.
3. `terraform apply` in `envs/shared`, then the environment root.
4. Bootstrap the nodes (section 6).
5. Restore Postgres (section 5).
6. Re-apply `deletion_log`.
7. Verify from the **public URL**, not from the node. That is the only check that
   proves the whole path works.

---

## 8. Cloudflare account loss (`PULLFM-RISK-001`)

The Cloudflare account is **shared with the operator's unrelated personal
fleet**, which is a documented accepted risk rather than an oversight. A
suspension takes down, simultaneously:

- DNS for `pull.fm`
- TLS termination and the edge protections
- **The R2 buckets: Terraform state and the backup repository**
- The maintenance worker, if one ever exists

That is the worst correlated failure in the system, because the thing you would
use to recover (state and backups) is inside the thing that failed.

**Mitigations that exist:** hardware-key MFA; tokens scoped to the minimum zone
and bucket; verified pre-apply state snapshots
(`infra/lib/tfstate-snapshot.sh`); backup objects encrypted by pgBackRest so
bucket access alone yields ciphertext.

**A mitigation that was listed here and never existed:** object versioning on
the state bucket. R2 does not implement it, so it was never a control. The
snapshot script replaces it for the bad-apply case, and only for that case:
snapshots live in the same bucket under the same credential, so they do nothing
about the correlated failure this section is actually about. The off-Cloudflare
gap below therefore covers state as well as backups, not just backups.

**Mitigation that does not exist:** an off-Cloudflare copy of the backup
repository. `[OPEN]` For a service with real user data, backups should not live
solely in the same account as DNS and the edge. This is the concrete reason to
either separate the account or add a second backup destination, and it is more
persuasive than the abstract blast-radius argument in the register entry.

Recovery: the registrar (Porkbun) holds the delegation, so DNS can be re-pointed
elsewhere. Everything else waits on the account.

---

## 9. Vendor unavailability

| Vendor                     | Impact                                                           | Response                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WorkOS**                 | Nobody can sign in. Existing sessions survive until they expire. | Wait. There is no fallback, and none is planned: we hold no password hashes precisely so there is no hostage, but that also means no local auth path. |
| **Hetzner**                | Total outage                                                     | Rebuild elsewhere. The Terraform is Hetzner-specific; a move is days, not hours.                                                                      |
| **Cloudflare**             | See section 8                                                    |                                                                                                                                                       |
| **ListenBrainz / Last.fm** | Recommendations degrade                                          | Circuit breaker opens, the section is omitted, `degraded: true`. Cache-first means this is a degradation, not an outage.                              |
| **MusicBrainz**            | **Existential if it is a revocation rather than an outage**      | See below.                                                                                                                                            |
| **iTunes / Deezer**        | Previews unavailable                                             | Degrade. Do not cache around it: caching preview audio breaches both.                                                                                 |
| **SeatGeek**               | Events unavailable                                               | Their contractual liability is capped at fifty dollars, so nothing user-facing may depend on them being up. Honest empty state.                       |

**A revocation is not an outage.** Last.fm and MusicBrainz revoke without appeal
or SLA, and there is **no second supplier of MBIDs**. Treat any 403 or explicit
revocation notice as SEV-3 in
[`RUNBOOK-INCIDENT.md`](RUNBOOK-INCIDENT.md), outranking a full outage, because an
outage is recoverable and this is not. The documented long-term mitigation is a
local MusicBrainz mirror (`PLAN.md` section 3), which is also the 50k-user
unlock.

---

## 10. Bus factor 1

One person holds 1Password, Cloudflare, Hetzner, GitHub, WorkOS, the registrar,
and the LLC bank. There is no separation-of-duties control available, so the
controls are the ones that survive the person being unavailable:

- **Printed 1Password Emergency Kit**, stored somewhere a successor can reach.
- **A nominated account recovery contact** on 1Password.
- **A one-page successor document**: what Pull.fm is, what it costs, where the
  accounts are, and what to do if it must be shut down. `PLAN.md` section 10
  budgets an hour for this in Phase 0.
- **The shutdown path is a legitimate outcome** and should be written down as
  one. Users can export their own data without operator involvement, which is
  the property that makes an orderly shutdown possible at all.

`[OPEN]` None of the three artifacts above is confirmed to exist. They are the
cheapest items in this entire runbook and the only ones that work when the
operator does not.

---

## 11. Drill schedule

| Drill                        | Frequency                           | Status                                     |
| ---------------------------- | ----------------------------------- | ------------------------------------------ |
| Full restore from R2, timed  | Monthly (Gate 4)                    | **Never run.** pgBackRest is not deployed. |
| Environment rebuild from IaC | Every gate run, implicitly          | **Run 2026-07-29. Failed.** Section 2.     |
| KEK rotation                 | Before Gate 3 closes, then annually | **Never run.** Section 4.                  |
| Replica promotion            | Once, then torn down (Gate 6)       | Not run; no replica exists                 |
| Escrow readability check     | At every risk review                | Unconfirmed                                |

**A drill that has never been run is not a control.** Five of the five rows above
are in that state, which is the honest summary of this document: the recovery
design is sound and almost none of it has been exercised. The mitigating fact,
and the reason this is a plan rather than an emergency, is that **there is no
production data yet**. That stops being true with the first real user.
