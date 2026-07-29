# Runbook: migrating the database to Neon

> **Status: NOT APPLIED.** `terraform plan` has been run against the live Neon
> control plane and is clean (see [Appendix A](#appendix-a-the-verified-plan)).
> `terraform apply` is gated on operator sign-off and has not been run. Nothing
> in the cutover section below has happened yet.
>
> The other runbooks in this repository live at `docs/RUNBOOK-*.md`. This one is
> under `docs/runbooks/` because it is a one-off migration with a finite life,
> not a standing operational procedure. When the migration is done, the parts of
> it that stay useful (branch reset, credential rotation) should be folded into
> `RUNBOOK-DEPLOY.md` and `RUNBOOK-DR.md` and this file retired.

---

## 0. What is changing, in one table

| Before                                                  | After                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| Postgres 17 on a Hetzner `cax31`/`cpx12` node           | Neon serverless Postgres 18, `aws-eu-central-1`               |
| PgBouncer planned for the same node (never shipped)     | Neon's pooled endpoint, which _is_ PgBouncer transaction mode |
| pgBackRest to R2 for PITR                               | Neon instant restore, 6 h window on the current plan          |
| Staging DB destroyed and rebuilt per gate run           | Staging DB is a Neon branch, reset in seconds                 |
| DB unreachable from the internet by topology            | DB reachable from the internet, guarded by a credential       |
| One Hetzner node for Postgres + Redis (`role=postgres`) | Same node, Redis only, smaller (`role=cache`)                 |

The last two rows are the ones a reviewer should slow down on. One is a real
security regression and one is the reason a second Hetzner node still exists.

### Why PgBouncer stays in `docker-compose.dev.yml`

Neon's pooled endpoint is PgBouncer in transaction mode. Running our own in
front of it in a cloud environment would be a second pooler, a second failure
mode and a second hop for no new capability, so the cloud environments have
none.

Locally there is nothing else providing those semantics, and they are not
transparent. Under transaction pooling a session-level advisory lock does not
survive `COMMIT`, `SET` outside a transaction does not persist, `LISTEN`/`NOTIFY`
does not work, and prepared statements outside a transaction are unavailable.
Every one of those fails **silently**. A laptop talking straight to port 5432
would therefore pass tests that production cannot pass, which is the expensive
kind of difference. So local dev keeps PgBouncer and publishes both ports, under
the same two variable names the Neon outputs use:

| Variable              | Local             | Cloud               | Consumer             |
| --------------------- | ----------------- | ------------------- | -------------------- |
| `DATABASE_URL`        | PgBouncer `:6432` | Neon `-pooler` host | the BFF              |
| `DATABASE_URL_DIRECT` | Postgres `:5432`  | Neon plain host     | the migration runner |

### Why the migration runner must use the direct endpoint

`packages/db/scripts/migrate.mjs` takes `pg_advisory_lock`, a **session-scoped**
lock, so that two BFF nodes deploying at the same moment cannot both decide zero
migrations have been applied. A transaction pooler returns the server connection
to the pool at `COMMIT`, so the session holding the lock is not the session that
continues the migration. Nothing errors. The lock simply stops serialising, and
the failure only becomes visible as two concurrent `CREATE TABLE`s during a
deploy. The runner now prefers `DATABASE_URL_DIRECT` and falls back to
`DATABASE_URL`, so a local run against a plain Postgres needs no extra config.

---

## 1. Facts, verified rather than assumed

Everything below was read from the Neon API (`console.neon.tech/api/v2`) on
2026-07-29, not from documentation or a ticket.

```
org       org-tiny-leaf-89756764   "312.dev LLC", subscription free_v3
project   steep-frost-83698289     "pull-fm", aws-eu-central-1, pg_version 18
branch    br-curly-wave-as91izv6   "main", default, protected false
database  neondb                   owned by neondb_owner
endpoint  ep-red-wave-as1i96ei     read_write, 0.25-2 CU, pooler DISABLED
          direct  ep-red-wave-as1i96ei.c-4.eu-central-1.aws.neon.tech
          pooled  ep-red-wave-as1i96ei-pooler.c-4.eu-central-1.aws.neon.tech
```

Three of those are load-bearing and easy to get wrong:

- **The default branch is `main`, not `production`.** It was created as
  `production` and renamed through the API on 2026-07-29. A branch ID is stable
  across a rename, so `br-curly-wave-as91izv6` and the endpoint host are both
  unchanged; only the name moved. Re-verified after the rename.
- **The database is `neondb` and the role is `neondb_owner`.** These are Neon
  console defaults and they cannot be renamed in place: every field of the
  project's default-branch block is `ForceNew` in the provider, so "fixing" the
  names in Terraform would plan to destroy and recreate the project. They stay.
- **Pooling was off.** Enabling it is the only change this migration makes to
  the already-existing production compute.

### Branch naming convention

`main` is the default branch and is what production connects to. **Every
environment branch is a child of `main` and is named after the environment it
serves.** Today that is exactly one branch, `staging`. Ephemeral branches for a
single experiment take the form `scratch/<what>` and are expected to be deleted;
anything else needs a line in this table before it is created.

| Branch    | Parent | Lifetime  | Purpose                    |
| --------- | ------ | --------- | -------------------------- |
| `main`    | none   | permanent | production                 |
| `staging` | `main` | permanent | gate runs, staging traffic |

---

## 2. Free-plan limits, and where this design runs out of road

The organisation is on `free_v3`. The branch-per-environment design depends on
these numbers, so they are recorded rather than assumed.

| Limit                   | Free plan                           | Confirmed by                                  |
| ----------------------- | ----------------------------------- | --------------------------------------------- |
| Branches per project    | 10                                  | API: `owner.branches_limit: 10`               |
| Storage per project     | 0.5 GB                              | API: `branch_logical_size_limit_bytes` 512 MB |
| Compute                 | 100 CU-hours/project/month          | Neon plans page                               |
| Instant restore (PITR)  | 6 hours                             | API: `history_retention_seconds: 21600`       |
| Autoscaling ceiling     | 2 CU                                | API + plans page                              |
| Scale to zero           | after 5 min, **cannot be disabled** | plans page                                    |
| Public network transfer | 5 GB/month                          | plans page                                    |

**Does staging-as-a-branch fit? Yes, comfortably, and that is the good news.**
Two branches out of ten. A child branch stores only its diff from the parent, so
a fresh `staging` adds roughly nothing to the 0.5 GB. Both computes suspend after
five minutes, so an idle staging branch consumes no compute hours at all. A three
hour gate session at 0.25 CU costs 0.75 CU-hours out of 100.

**Does PRODUCTION fit? No, and this must not be discovered later.** The
arithmetic is unforgiving:

```
100 CU-hours / 0.25 CU  =  400 hours of activity per month
a month is                 730 hours
```

A production compute that is genuinely serving users does not suspend, so it
exhausts the entire monthly allowance in about **17 days**, and that is at the
0.25 CU floor. Add the 0.5 GB storage cap against an architecture whose whole
premise is "every MBID-keyed fact is written to Postgres and served from there
forever" (`docs/PLAN.md` section 3), and the free plan is a development
allowance, not a production one.

**Conclusion, stated plainly:** the free plan is sufficient for this migration,
for staging, and for every gate below Phase 6. It is **not** sufficient to serve
production traffic, and the Phase 6 cutover has a paid-plan upgrade as a
prerequisite rather than an afterthought. Three things unlock at the same time
and all three are wanted: a longer PITR window, IP allowlisting
(`allowed_ips`, currently the missing control), and protected branches.

---

## 3. Security: what got worse

Say it before somebody finds it in a review.

The Hetzner Postgres node had **no public IPv4 at all**, sat on a private
network, and was additionally covered by a firewall with no inbound `5432` rule.
Three independent mechanisms, none of which relied on a credential.

A Neon endpoint is **reachable from the public internet by anyone holding the
connection string**. On the free plan `allowed_ips` is not available, so the
credential is not the primary control, it is the only one. Compensating
measures, in the order they should be applied:

1. **Rotate the connection strings on cutover** (section 6). The current ones
   were created in a browser and have been through a console clipboard.
2. **The credential never lands in git.** It is copied from `terraform output`
   into 1Password and rendered onto nodes at 0600 by `infra/lib/secrets.sh`,
   exactly like every other secret here.
3. **Set `allowed_ips` to the BFF egress addresses** the moment the plan permits
   it. The addresses are already published as the `app_egress_ipv4` output of
   the environment roots, so this is a one-line change plus an apply.
4. **`sslmode=require` on every connection string**, which Neon enforces anyway.

Track this as a new entry in `security/accepted-risks.md` with an owner and an
expiry date, because that register is CI-enforced and an unregistered accepted
risk is just an unrecorded one.

---

## 4. Schema migration (`packages/db/migrations`)

There are four migrations (`0001_initial` through `0004_preview_store_url`) and
they are dbmate-style files with `-- migrate:up` and `-- migrate:down` markers.
Nothing about them changes for Neon. Two things about the environment do.

**Postgres 17 to 18.** The Hetzner node ran `postgres:17.10-alpine`; Neon reports
`pg_version 18`. `docker-compose.dev.yml` was already moved to `postgres:18-alpine`
in commit `efdf588`, so local, staging and production now agree. Verify before
cutover rather than after:

```bash
pnpm --filter @pull-fm/db verify        # Gate 1 harness: up AND down, in CI
```

**Extensions.** `infra/local/postgres-init/00-extensions.sql` creates whatever
the schema needs on a local cluster. Neon has no init-script hook, so anything in
that file must also be created by a migration or by hand on each branch. Check
before cutover:

```bash
psql "$DATABASE_URL_DIRECT" -c '\dx'
```

`gen_random_uuid()` (used by `user_oauth_connections` in `docs/PLAN.md` section 5) is built into `pgcrypto`, which Neon ships enabled. Confirm rather than
assume; an extension missing on `main` is also missing on every branch cut from
it.

**Run migrations against the DIRECT endpoint.** See section 0. The deploy path
already does the right thing because `pullfm-deploy` passes the whole
`/etc/pullfm/bff.env` to the migration container and that file now carries both
URLs.

---

## 5. Cutover

Ordered so that every step is reversible until the last one.

### 5.1 Authorise and apply the Terraform

```bash
cd infra/neon
source ../lib/credentials.sh && pullfm_load_credentials neon
cp backend.hcl.example backend.hcl        # fill in the R2 endpoint
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan                # READ IT. Expect 0 to destroy.
terraform apply tfplan
```

`pullfm_load_credentials neon` reads the API key from 1Password by **item ID**
(the item's title contains parentheses, which are not legal in an `op://`
reference) and then runs `pullfm_assert_neon_scope`, which refuses to continue if
the key can see any project other than `pull-fm` or any personal project at all.

The expected plan is in [Appendix A](#appendix-a-the-verified-plan): four
imports, two creates, one in-place change, **zero destroys**. A plan that
proposes destroying or replacing `neon_project.pullfm` is a bug in the
configuration and is blocked by `prevent_destroy`; do not remove that block to
make a plan go through.

### 5.2 Capture the connection strings into 1Password

Terraform outputs them; 1Password stores them; nothing else ever sees them.

```bash
terraform output -raw main_database_url_pooled       # -> pull-fm/prod/DATABASE_URL
terraform output -raw main_database_url_direct       # -> pull-fm/prod/DATABASE_URL_DIRECT
terraform output -raw staging_database_url_pooled    # -> pull-fm/staging/DATABASE_URL
terraform output -raw staging_database_url_direct    # -> pull-fm/staging/DATABASE_URL_DIRECT
```

Store each as the `credential` field of an item with that exact title, because
that is what `infra/lib/secrets.sh` reads. **Do not paste them into a shell that
records history, a chat window, or a file.**

### 5.3 Move the data

Staging has no data worth moving; it is rebuilt every gate run. Production has
never been applied, so at the time of writing **there is no production data to
migrate at all**, which makes this the cheapest possible moment to do this
migration. If that changes before cutover, the procedure is:

```bash
# From the operator's laptop, over the tailnet. Never from the node itself:
# the dump would then exist on a disk we are about to destroy.
pg_dump --format=custom --no-owner --no-acl \
        "postgres://pullfm@10.20.1.21:5432/pullfm" > pullfm-$(date +%F).dump

pg_restore --no-owner --no-acl --single-transaction \
           --dbname "$(terraform -chdir=infra/neon output -raw main_database_url_direct)" \
           pullfm-$(date +%F).dump
```

`--no-owner --no-acl` because the roles differ: the Hetzner cluster owned objects
as `pullfm`, Neon owns them as `neondb_owner`. `--single-transaction` so a
partial restore is not a possible outcome. `pg_restore` goes through the
**direct** endpoint: it is one long session doing DDL, which is the exact shape
a transaction pooler handles worst.

Then verify, rather than trusting the exit code:

```bash
psql "$DIRECT" -c "select relname, n_live_tup from pg_stat_user_tables order by 1"
```

Compare row counts against the source before continuing.

### 5.4 Converge staging and prove it serves

```bash
./infra/staging-env.sh up
```

That now provisions an app node and a **cache** node (Redis only), renders
`bff.env` with the Neon URLs and `cache.env` with the Redis passwords, and polls
`https://api-staging.pull.fm/healthz` until it reports the commit being deployed.
The database is not built by this script any more and is not torn down by it.

### 5.5 Retire the Hetzner Postgres

Only after 5.4 is green:

```bash
terraform -chdir=infra/terraform/envs/staging plan
```

The plan will replace `hcloud_server.db` with `hcloud_server.cache` and drop the
`hcloud_volume.db_data` resources. **This destroys the old Postgres node and its
data.** Do not run it until the dump in 5.3 is restored, verified, and backed up
somewhere that is not that node.

---

## 6. Connection-string rotation

Neon has no "rotate password" API verb; the operation is a role password reset,
which returns a new password and invalidates the old one immediately. There is
no overlap window, so this is a brief outage rather than a rolling change. Plan
for a minute of 500s, or put the maintenance flag on first.

```bash
# 1. Reset. This invalidates the current credential the moment it returns.
curl -sS -X POST \
  -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/steep-frost-83698289/branches/br-curly-wave-as91izv6/roles/neondb_owner/reset_password"

# 2. Re-read what Terraform now sees, and update 1Password from it.
terraform -chdir=infra/neon refresh
terraform -chdir=infra/neon output -raw main_database_url_pooled
terraform -chdir=infra/neon output -raw main_database_url_direct

# 3. Re-render and restart. `converge` places the new bff.env and bounces the
#    container; nothing has to be edited on the node by hand.
./infra/staging-env.sh converge
```

Rotate when: cutover completes (the current credential has been in a browser),
an operator device is lost, a laptop with a rendered `bff.env` is
decommissioned, or anyone leaves. **A rotation is also the correct response to
"I think I pasted the connection string somewhere".** It costs a minute.

Terraform state holds the password in plaintext, so a rotation is not complete
until the old state version is gone. Object versioning is on for
`pull-fm-tfstate`, which is deliberate and helpful for recovery but does mean an
old state object still contains the old credential. That is acceptable precisely
because the credential is dead; it would not be if the rotation had been skipped.

---

## 7. Rollback

Three separate failures, three separate answers. They are not interchangeable.

### 7.1 The Terraform apply goes wrong

State is in R2 with object versioning on. Restore the previous state object and
re-plan. Because the apply is import-heavy, the most likely bad outcome is
resources adopted into state that should not have been; the fix is
`terraform state rm`, which detaches without touching Neon.

### 7.2 The schema or the data is wrong, but Neon is fine

**Use instant restore, not a dump.** The PITR window is 6 hours on this plan.
Restoring `main` to a timestamp is a control-plane operation measured in seconds,
because Neon's storage is copy-on-write. This is strictly better than the
pgBackRest path it replaces, which Gate 4 budgets at 30 minutes.

The window is the constraint: **a mistake noticed 7 hours later cannot be undone
this way.** Until the plan is upgraded, an out-of-band logical dump to R2 before
any destructive operation is the compensating control, and the operation is not
authorised without one.

### 7.3 Neon itself is the problem, and we want the Hetzner node back

This is the expensive one, and it has a shelf life.

- **Within the retention of the pre-cutover dump:** rebuild a Hetzner Postgres
  node from the commit immediately before this migration
  (`git revert` the Terraform commit, apply, restore the dump). The old node
  definition is in git history, which is why it is being deleted rather than
  commented out.
- **After production has taken writes on Neon:** `pg_dump` from Neon into the
  rebuilt node. Neon is stock Postgres 18 with no proprietary wire format, so
  this works, but it costs a full dump-and-restore outage.

The window in which reverting is cheap closes as soon as production writes to
Neon. That is the moment to be confident, not later.

---

## 8. Branching replaces the ephemeral-teardown pattern

`docs/PLAN.md` section 10c decided staging is destroyed after every gate run
because a standing Hetzner environment costs about EUR 35/mo to sit idle. That
reasoning was correct **for servers billed by the hour**. It does not transfer to
a Neon branch, and continuing to apply it would be cargo-culting the mechanism
after its justification has gone.

| Property             | Hetzner teardown                                  | Neon branch                           |
| -------------------- | ------------------------------------------------- | ------------------------------------- |
| Cost while idle      | EUR ~35/mo, hence the teardown                    | storage of the diff; compute suspends |
| Time to a usable env | 45 s of Terraform, then an untimed manual runbook | seconds, control-plane only           |
| Data after a rebuild | empty; every gate starts from nothing             | a copy-on-write clone of production   |
| Failure mode         | half-destroyed environment that still bills       | none; nothing is destroyed            |

The last two rows matter more than the cost. A torn-down staging environment
comes back **empty**, so every gate that needs realistic data has to synthesise
it. A branch comes back as a copy of production at a point in time, which is both
faster and a better test.

**So: do not destroy the staging branch.** When staging data needs discarding,
reset the branch from its parent instead. This is the replacement operation and
it should end up in `RUNBOOK-DEPLOY.md`:

```bash
# Reset `staging` to the current state of `main`. Seconds, not minutes.
curl -sS -X POST \
  -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/steep-frost-83698289/branches/<staging-branch-id>/restore" \
  -H 'Content-Type: application/json' \
  --data '{"source_branch_id":"br-curly-wave-as91izv6"}'
```

Get `<staging-branch-id>` from `terraform -chdir=infra/neon output -raw staging_branch_id`.

Two consequences worth stating:

- **A reset does not change the endpoint host**, so no connection string has to
  be rotated afterwards. A branch's compute survives the reset of its data.
- **`./infra/staging-env.sh down` still exists and is still correct**, because
  the Hetzner compute it destroys is still billed by the hour. It just no longer
  destroys any database. The header of that script now says so.

What this does **not** change: `docs/PLAN.md` section 10d, the finding that a
rebuilt staging environment does not come back healthy because config management
is a manual SSH runbook. That gap is about the application node and is untouched
by this migration. Gate 4 still cannot pass.

---

## 9. What this migration does not do

- **It does not fix Gate 4.** See section 8. The database half of a restore
  drill gets dramatically better; the node half is unchanged.
- **It does not remove the R2 backup bucket.** `pgBackRest` no longer writes to
  it, but a bucket outside the database vendor is exactly where the logical
  dumps from sections 5.3 and 7.2 belong. It is free at this size.
- **It does not create a least-privilege application role.** `create_app_role`
  exists and defaults to `false`. Terraform can create a role but cannot `GRANT`
  to it, so switching it on before the matching migration exists produces a role
  that authenticates and then reads nothing. Do both in one change.
- **It does not set `allowed_ips`.** Plan-gated; see section 3.

---

## Appendix A: the verified plan

Run 2026-07-29 against the live Neon control plane with a read-only intent.
`terraform apply` has **not** been run.

```
Plan: 4 to import, 2 to add, 1 to change, 0 to destroy.

  neon_project.pullfm       import  steep-frost-83698289
  neon_database.main        import  steep-frost-83698289/br-curly-wave-as91izv6/neondb
  neon_role.owner           import  steep-frost-83698289/br-curly-wave-as91izv6/neondb_owner
  neon_endpoint.main        import  steep-frost-83698289/ep-red-wave-as1i96ei
                            change  pooler_enabled false -> true
  neon_branch.staging       create  name "staging", parent br-curly-wave-as91izv6
  neon_endpoint.staging     create  read_write, pooled, 0.25-1 CU
```

Zero destroys is the assertion that matters. The adopted project reads back with
`branch { name = "main", database_name = "neondb", role_name = "neondb_owner" }`
and no diff, which is the check that the rename in section 1 is reflected in the
configuration rather than fought by it.

## Appendix B: provider choice

`kislerdm/neon` v0.14.0, and it is not a preference. **Neon publishes no official
Terraform provider.** Their own documentation says they sponsor this
community-developed one and that it "is not maintained or officially supported
by Neon". `registry.terraform.io` returns 404 for both `neondatabase/neon` and
`neondatabase-labs/neon`, checked 2026-07-29.

Currency was checked rather than assumed, because Neon's API now requires
`org_id` when listing an organisation's projects and a provider pinned to the
older personal-account shape would fail on this project specifically. v0.14.0 was
released 2026-07-14, carries `org_id` on `neon_project`, and adopted this
org-owned project cleanly in the plan above.

The residual risk is a single-maintainer dependency on the control plane for the
database. It is bounded: nothing in the data path depends on the provider, every
resource is importable by a stable Neon identifier, and the lock file pins exact
versions and checksums for `linux_amd64`, `linux_arm64` and `darwin_arm64`.
