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
5. **Do not connect as the database owner.** Section 5.5 creates a role that can
   read and write rows and can do nothing else, so a leaked runtime credential
   reaches data but not schema. This does not narrow who can reach the endpoint;
   it narrows what reaching it is worth.

Registered as **`PULLFM-RISK-007`** in `security/accepted-risks.md`, with the
paid-plan upgrade as the retirement condition and an expiry of 2026-10-27. That
register is CI-enforced, and an unregistered accepted risk is just an unrecorded
one.

The second thing this migration changed is registered separately as
**`PULLFM-RISK-008`**: Neon returns role passwords through its API, so the owner
password is in Terraform state in plaintext and the R2 state bucket is now the
trust boundary for the production database credential.

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

../lib/tfstate-snapshot.sh snapshot .     # verified state backup, BEFORE the apply

terraform plan -out=tfplan                # READ IT. Expect 0 to destroy.
terraform apply tfplan
```

The snapshot step is not optional and is not ceremony. R2 cannot version objects
(section 7.1), so this is the only rollback that exists for a bad apply. It exits
non-zero if the copy cannot be read back, which stops the apply. On the very
first apply it prints "nothing to snapshot" and succeeds, because there is no
state yet to protect.

`pullfm_load_credentials neon` reads the API key from 1Password by **item ID**
(the item's title contains parentheses, which are not legal in an `op://`
reference) and then runs `pullfm_assert_neon_scope`, which refuses to continue if
the key can see any project other than `pull-fm` or any personal project at all.

The expected plan is in [Appendix A](#appendix-a-the-verified-plan): four
imports, two creates, one in-place change, **zero destroys**. A plan that
proposes destroying or replacing `neon_project.pullfm` is a bug in the
configuration and is blocked by `prevent_destroy`; do not remove that block to
make a plan go through.

### 5.2 Capture the OWNER connection strings into 1Password

These are the migration credentials. The runtime credentials do not exist yet;
they are created in [section 5.5](#55-create-the-least-privilege-application-role)
and the application must not be pointed at these for longer than it takes to get
there.

```bash
terraform output -raw main_database_url_owner_direct     # -> pull-fm/prod/DATABASE_URL_DIRECT
terraform output -raw staging_database_url_owner_direct  # -> pull-fm/staging/DATABASE_URL_DIRECT
```

Store each as the `credential` field of an item with that exact title, because
that is what `infra/lib/secrets.sh` reads. **Do not paste them into a shell that
records history, a chat window, or a file.**

Output names encode the role as well as the endpoint
(`<branch>_database_url_<role>_<endpoint>`). The old names said only which
endpoint a string used, and the role is the half that decides what a leak costs.
`terraform output database_url_assignments` prints the full table.

**`main_database_url_owner_pooled` also exists and is almost never the right
answer.** Until section 5.6 has been done there is no runtime credential, so if
the BFF has to be brought up before then it uses the owner string and that is a
temporary, recorded exposure rather than the intended configuration.

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

### 5.5 Create the least-privilege application role

**This has to come after 5.4, not before it.** `grant-app-role.sql` grants on the
tables that exist, and the tables are created by the migration step that 5.4
runs. Running it against an empty database grants nothing on the schema and only
the `ALTER DEFAULT PRIVILEGES` half takes effect; the result looks successful and
leaves the existing tables unreadable to the application.

**Run all three scripts against every branch that serves traffic.** A Neon
branch is a copy-on-write clone taken at a moment in time: it inherits the roles
and grants that existed when it was cut, and nothing done to `main` afterwards
reaches it. Do `main` and `staging` separately, and repeat after any branch reset
that predates the role.

```bash
cd infra/neon
OWNER="$(terraform output -raw main_database_url_owner_direct)"   # or staging_...

openssl rand -base64 24                       # generate the password, do not invent one

psql -v ON_ERROR_STOP=1 -f sql/create-app-role.sql "$OWNER"   # prompts for it
psql -v ON_ERROR_STOP=1 -f sql/grant-app-role.sql  "$OWNER"
psql -v ON_ERROR_STOP=1 -f sql/verify-app-role.sql "$OWNER"
```

The owner string and the direct endpoint are both required.
`ALTER DEFAULT PRIVILEGES` binds to the role that will create future tables, so
running this as anyone but `neondb_owner` produces default privileges that never
fire; the script refuses rather than trusting the operator to notice.

`verify-app-role.sql` prints a PASS/FAIL table of 34 assertions and exits
non-zero on any failure. **It is the deliverable, not the paperwork.** Every
dangerous outcome here is a privilege that is present when it should be absent,
and re-running the grant script cannot detect one of those because it only adds.

Then assemble `DATABASE_URL` from the template and store it:

```bash
terraform output -raw main_database_url_app_pooled_template
# postgres://pullfm_app:REPLACE_WITH_APP_ROLE_PASSWORD@ep-...-pooler.../neondb?sslmode=require
```

Substitute the password, URL-encoding it first if it contains any of
`: / ? # [ ] @ %`, and store the result as `pull-fm/prod/DATABASE_URL` (or
`pull-fm/staging/DATABASE_URL`). Terraform cannot do this for you and should
not: see [section 10](#10-what-terraform-cannot-express-here-and-why).

Finally, converge so the node picks up the new value:

```bash
./infra/staging-env.sh converge
```

#### Confirming it by hand

Worth doing once, because a privilege you have not seen refused is a privilege
you are assuming:

```bash
APP="$(terraform output -raw main_database_url_app_direct_template)"   # substitute the password
psql "$APP" -c 'drop table users'
# ERROR:  must be owner of table users
psql "$APP" -c 'set role neon_superuser'
# ERROR:  permission denied to set role "neon_superuser"
```

### 5.6 Retire the Hetzner Postgres

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
terraform -chdir=infra/neon output -raw main_database_url_owner_direct

# 3. Re-render and restart. `converge` places the new bff.env and bounces the
#    container; nothing has to be edited on the node by hand.
./infra/staging-env.sh converge
```

**The application role rotates differently, and more cheaply.** It is not a Neon
API object, so `reset_password` does not apply to it and Terraform is not
involved at all. Re-running `create-app-role.sql` with a new password is the
whole procedure, because the script takes the `ALTER ROLE` path when the role
already exists:

```bash
openssl rand -base64 24
psql -v ON_ERROR_STOP=1 -f infra/neon/sql/create-app-role.sql \
     "$(terraform -chdir=infra/neon output -raw main_database_url_owner_direct)"
# then substitute into the template, update 1Password, and converge
```

Grants survive a password change, so `grant-app-role.sql` does not need
re-running; `verify-app-role.sql` is still worth running, because it costs
seconds and it is the only thing that would notice if it did.

**Rotate the two independently.** They are separate credentials with separate
blast radii, and rotating the owner because an application node was rebuilt is a
production DDL outage taken for no reason.

Rotate when: cutover completes (the current credential has been in a browser),
an operator device is lost, a laptop with a rendered `bff.env` is
decommissioned, or anyone leaves. **A rotation is also the correct response to
"I think I pasted the connection string somewhere".** It costs a minute.

Terraform state holds the owner password in plaintext (`PULLFM-RISK-008`), so a
rotation is not complete until no readable object still contains the old one.

R2 cannot version objects, so the live state key holds exactly one version and
overwriting it genuinely destroys the old credential. **The state snapshots
introduced in section 7.1 do not have that property**, and this is the one place
the two mechanisms are in tension. A snapshot is a full copy of state, so every
snapshot taken before a rotation still contains the password that rotation was
meant to kill.

That is acceptable, on one condition that has to actually hold: a rotated
credential is a dead one, so a stale copy of it is inert. It stops being
acceptable the moment a rotation is skipped or half-finished. After rotating,
either let retention age the pre-rotation snapshots out, or delete them
deliberately:

```bash
infra/lib/tfstate-snapshot.sh list infra/neon
# then delete the ones predating the rotation, if the exposure warrants it
```

Deleting them costs the rollback history for those applies, which is the trade.
For a routine rotation, leave them. For a rotation prompted by suspected
disclosure, delete them, because in that case the old credential may not be dead
at all.

---

## 7. Rollback

Three separate failures, three separate answers. They are not interchangeable.

### 7.1 The Terraform apply goes wrong

Because the apply is import-heavy, the most likely bad outcome is resources
adopted into state that should not have been. The fix for that is
`terraform state rm`, which detaches without touching Neon and needs no backup at
all. Reach for it first.

**Earlier revisions of this runbook said to restore the previous version of the
state object. That was never possible and cannot be made possible.** R2 does not
implement object versioning: Cloudflare's S3 compatibility matrix lists
`PutBucketVersioning` and `GetBucketVersioning` as unimplemented and omits
`ListObjectVersions` entirely. The instruction was not describing a switch nobody
had flipped, it was describing a feature that does not exist on this platform.

It is worth knowing why nobody caught it, because the same shape will recur with
other R2 features. Probing the bucket does not produce an error:

```
aws s3api get-bucket-versioning --bucket pull-fm-tfstate   # exit 0, empty body
aws s3api get-bucket-policy     --bucket pull-fm-tfstate   # NotImplemented
```

An empty versioning configuration is exactly what S3 returns for a bucket where
versioning was never enabled. One unsupported API says no by erroring, the other
says no by shrugging, and only the first one gets noticed.

**Take a verified snapshot before every apply instead:**

```bash
source infra/lib/credentials.sh && pullfm_load_credentials neon
infra/lib/tfstate-snapshot.sh snapshot infra/neon

# before an import-heavy or destructive apply, also keep a copy off Cloudflare:
infra/lib/tfstate-snapshot.sh snapshot infra/neon --local ~/tfstate-backups
```

It copies the live state to a timestamped key, **reads it back and compares
digests**, and exits non-zero if it cannot. That ordering is the point: the
snapshot is proved readable before the apply runs, not discovered to be unreadable
during a recovery. A backup nobody has read is not a backup, which is the same
lesson Gate 4 exists to teach about database restores.

To roll back:

```bash
infra/lib/tfstate-snapshot.sh list    infra/neon
infra/lib/tfstate-snapshot.sh restore infra/neon snapshots/neon/terraform.tfstate/<stamp>.tfstate
terraform -chdir=infra/neon plan       # expect no changes
```

`restore` refuses if the snapshot's Terraform `lineage` does not match the live
state, and snapshots the current state before overwriting it, so a restore to the
wrong snapshot is itself reversible.

**What this does not cover.** Snapshots sit in the same bucket, under the same
credential, as the state they protect. They answer "the apply went wrong". They
do not answer "the bucket is gone" or "the Cloudflare account was suspended",
which `PULLFM-RISK-001` says is a live possibility because that account is shared
with an unrelated personal fleet. `--local` is the answer to those, and the copy
it writes contains the production database password in plaintext at mode 0600:
keep it off synced or shared storage and delete it once the apply is confirmed.

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
- **It does not set `allowed_ips`.** Plan-gated; see section 3. This is the
  security regression the migration actually introduces, and the least-privilege
  role in 5.5 narrows its consequences without removing it.
- **It does not put the application role in Terraform.** It cannot; see
  section 10. The role exists and is least-privilege, it is just made by SQL.
- **It does not fix the fact that the database credential is in Terraform
  state.** Neon returns role passwords through its API, so the owner password is
  in `neon/terraform.tfstate` in plaintext and no provider setting changes that.
  The application role's password is not, which is a side benefit of it being a
  SQL role rather than the reason for it. Registered as `PULLFM-RISK-008`.

---

## 10. What Terraform cannot express here, and why

Two things in this migration are operator steps rather than resources. Both were
attempted as Terraform first, and both are recorded here so the next person does
not spend the same afternoon rediscovering them.

### 10a. `GRANT` is not in the provider at all

`kislerdm/neon` v0.14.0 exposes eleven resources (`provider/provider.go`):
`neon_api_key`, `neon_project`, `neon_branch`, `neon_endpoint`, `neon_role`,
`neon_database`, `neon_project_permission`, `neon_jwks_url`,
`neon_vpc_endpoint_assignment`, `neon_vpc_endpoint_restriction` and
`neon_org_api_key`. None of them expresses a privilege. `neon_role` has a
four-attribute schema, read from `provider/resource_role.go` rather than from
the documentation: `project_id`, `branch_id`, `name`, and a computed `password`.
There is no update function either, so every writable attribute is `ForceNew`
and renaming a role is a drop and a create.

That is a fact about the Neon API rather than about the provider. Neon manages
roles and databases; privileges inside a database are Postgres's business.

Reaching for the `cyrilgdn/postgresql` provider or a `null_resource` wrapping
psql was considered and rejected. Either one needs the database password in a
provider block or a `local-exec` environment, both of which are rendered into
the plan file, and plan files get attached to pull requests on a public
repository. The gain would be a `terraform apply` that also runs grants; the cost
would be the production database credential in a CI artifact.

### 10b. A Terraform-created role cannot be least-privilege

This is the sharper one, because the failure is silent.

Neon grants membership in `neon_superuser` to every role created through the
Console, the API or the CLI, and `neon_role` is an API call. That membership
carries `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION`,
`pg_read_all_data`, `pg_write_all_data`, `pg_monitor`, `pg_signal_backend` and
`ALL` on the public schema `WITH GRANT OPTION`. Role attributes are not
inherited through membership, so this looks survivable until you notice that a
member may `SET ROLE neon_superuser` and use every one of them.

Revoking it afterwards does not work. Measured against Postgres 18 on
2026-07-29, with the role created exactly as the Neon API creates it:

```
neondb_owner=> REVOKE neon_superuser FROM pullfm_app;
WARNING:  role "pullfm_app" has not been granted membership in role
          "neon_superuser" by role "neondb_owner"
REVOKE ROLE
```

**A warning, a success code, and nothing revoked.** Postgres 16 made role
membership track its grantor, and a `REVOKE` only removes grants issued by the
revoking role. Neon's control plane issued this one. Naming the grantor is
refused with a hard error instead:

```
ERROR:  permission denied to revoke privileges granted by role "..."
DETAIL:  Only roles with privileges of role "..." may revoke privileges granted by this role.
```

Holding `ADMIN OPTION` on `neon_superuser` does not help, because the restriction
is about the grantor rather than about admin rights. Only the original grantor or
a superuser can revoke, and Neon gives its customers neither.

The consequence worth internalising: **a script that revoked and did not verify
would have exited zero and left production running as an administrator.** That is
why `grant-app-role.sql` asserts the membership is gone in a block separate from
the one that revokes it, and why `verify-app-role.sql` exists at all.

Neon documents the way out, and it is the one this repository takes: roles
"created with SQL from clients like psql, pgAdmin, or the Neon SQL Editor are
only granted the basic public schema privileges granted to newly created roles in
a standalone Postgres installation."

One wrinkle when creating it. `neondb_owner` cannot `CREATE ROLE` on its own:

```
ERROR:  permission denied to create role
DETAIL:  Only roles with the CREATEROLE attribute may create roles.
```

`CREATEROLE` is an attribute and attributes are not inherited, so the script does
`SET ROLE neon_superuser` for exactly the two statements that need it. The role
created that way is **not** a member of `neon_superuser`: creating a role while
acting as one grants the creator admin rights over the new role, it does not
enrol the new role in anything.

### 10c. What the application role can and cannot do

Verified by connecting as it, not by reading the grants back:

| Allowed                                              | Refused                                                |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all tables | `DROP TABLE` (`must be owner of table users`)          |
| `SELECT` on views                                    | `ALTER TABLE` (`must be owner of table users`)         |
| `nextval()` on sequences                             | `CREATE TABLE` (`permission denied for schema public`) |
| `pg_try_advisory_lock()`                             | `TRUNCATE` (`permission denied for table users`)       |
| Everything on tables a FUTURE migration creates      | `SELECT` on `pg_authid` (`permission denied`)          |
|                                                      | `SET ROLE neon_superuser` / `neondb_owner`             |
|                                                      | `CREATE ROLE`, `CREATE DATABASE`, `CREATE EXTENSION`   |
|                                                      | `CREATE INDEX`, `CREATE TEMP TABLE`                    |

The last row of the left column is the one that needs explaining, because it is
the one that breaks production if it is wrong.

`GRANT ... ON ALL TABLES` is not retroactive in the useful direction: it covers
the tables that exist when it runs and says nothing about the next migration's.
`ALTER DEFAULT PRIVILEGES` covers future objects and does nothing for existing
ones. **Both are needed and neither substitutes for the other.** Without the
second, the next `CREATE TABLE` produces a table the application cannot read, the
deploy reports success, and one endpoint starts returning `permission denied for
table ...`, which is a production break introduced by an unrelated change.

A default-ACL entry is keyed on `(creating role, schema, object type)`, so
`FOR ROLE neondb_owner` is load-bearing rather than decorative. Omitting it binds
the entry to whoever ran the script, which is right only by coincidence. The
invariant it rests on, stated so it can be checked: **migrations always run as
`neondb_owner`**, which holds because `migrate.mjs` connects with
`DATABASE_URL_DIRECT` and that is the owner string. A second migration identity
would need its own `ALTER DEFAULT PRIVILEGES` line or its tables would be
invisible to the application.

This was tested rather than reasoned about. Against Postgres 18 with the real
migrations applied, a new table and sequence were created as `neondb_owner` and
the application role could immediately `SELECT`, `INSERT`, `UPDATE`, `DELETE` and
call `nextval()` on them with no further grant, while `TRUNCATE` and `DROP` were
still refused. `verify-app-role.sql` performs that same probe inside a
transaction every time it runs.

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
