# Runbook: migrating the database to Neon

> **Status: APPLIED 2026-07-29. SCHEMA AND ROLES MIGRATED 2026-07-29.** The
> Terraform in section 5.1 has been applied against the live Neon control
> plane: 4 imported, 2 added, 1 changed, 0 destroyed, matching
> [Appendix A](#appendix-a-the-verified-plan). The staging branch is
> `<neon-staging-branch-id>` and its endpoint is `<neon-staging-endpoint-id>`.
>
> Since then, and recorded in full in
> [section 11](#11-what-actually-happened-on-the-schema-and-role-cutover):
> all six migrations are applied to **both** branches, `pullfm_app` exists on
> both with 34 of 34 privilege assertions passing, its least privilege has been
> proved by connecting as it rather than by reading grants back, Gate 1 passes
> against Neon, and all four connection strings are in 1Password. A re-plan
> still reports no changes, and both endpoints report
> `pooler_enabled=True, mode=transaction` from the API.
>
> **The rest of the cutover has not happened.** No data has moved (there is
> none), the application has not been pointed at Neon and not converged, and
> the Hetzner Postgres node has not been retired. Two apply-time defects were
> found and are written up in
> [section 10d](#10d-two-defects-that-only-appeared-against-real-infrastructure);
> both are fixed. Four further defects, all in this repository's own scripts
> rather than in Neon, were found by running them against Neon: three in the
> Gate 1 harness
> ([section 11c](#11c-three-harness-defects-that-only-a-real-credential-exposes))
> and one in `verify-app-role.sql`, which was not idempotent on Neon because
> **Neon parks an idle backend and hands its session state to the next client**
> ([section 11f](#11f-neon-parks-idle-backends-and-session-state-survives-the-client)).
> All four are fixed. 11f also describes an unfixed hazard for the migration
> runner's advisory lock.
>
> **One action is outstanding and it is a credential one:** the STAGING owner
> password was printed to a terminal by the Gate 1 harness before that defect
> was fixed, so it should be rotated per [section 6](#6-connection-string-rotation).
> The production owner password was not exposed.
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
org       <neon-org-id>   "312.dev LLC", subscription free_v3
project   <neon-project-id>     "pull-fm", aws-eu-central-1, pg_version 18
branch    <neon-main-branch-id>   "main", default, protected false
database  neondb                   owned by neondb_owner
endpoint  <neon-main-endpoint-id>     read_write, 0.25-2 CU, pooler DISABLED
          direct  <neon-main-endpoint-id>.c-4.eu-central-1.aws.neon.tech
          pooled  <neon-main-endpoint-id>-pooler.c-4.eu-central-1.aws.neon.tech
```

Three of those are load-bearing and easy to get wrong:

- **The default branch is `main`, not `production`.** It was created as
  `production` and renamed through the API on 2026-07-29. A branch ID is stable
  across a rename, so `<neon-main-branch-id>` and the endpoint host are both
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

There are six migrations (`0001_initial` through `0006_audit_log_retention`) and
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

**Two claims that used to be in this section were wrong, and the pre-cutover
check is what found them.** Measured against both live branches on 2026-07-29:

> `gen_random_uuid()` is built into `pgcrypto`, which Neon ships enabled.

Both halves are false, and they are false in opposite directions, which is why
the net effect looked fine.

- **Neon ships none of them enabled.** `pg_extension` on a fresh branch contains
  `plpgsql` and nothing else. `pgcrypto`, `pg_trgm`, `unaccent` and `citext` were
  all `installed_version = NULL` on `main` and on `staging`.
- **`gen_random_uuid()` does not come from `pgcrypto` any more.** It has been a
  core function since Postgres 13, and this project runs 18. Confirmed by asking
  the catalog which extension owns it rather than by reading release notes:

  ```sql
  SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
   WHERE d.objid = 'gen_random_uuid'::regproc AND d.deptype = 'e';
  -- 0 rows: the function is core, owned by no extension
  ```

So the thing the old text said was guaranteed was in fact absent, and the
function it was worried about would have worked regardless. **Neither is a
reason to relax.** `citext` is load-bearing for `users.email`, `pg_trgm` for the
`gin_trgm_ops` index in 0001, and `unaccent` for the crosswalk, and all three
were genuinely missing.

**Nothing had to be created by hand, because migration 0001 creates all four
itself** (`CREATE EXTENSION IF NOT EXISTS`), and that turns out to be the load
bearing design decision in this whole section: the local init script is a
convenience, and the migration is the source of truth. What had to be verified
was that the OWNER is permitted to run those statements on Neon, since
`neondb_owner` is not a superuser:

```
citext | trusted=true | superuser_required=true
pg_trgm | trusted=true | superuser_required=true
pgcrypto | trusted=true | superuser_required=true
unaccent | trusted=true | superuser_required=true
```

`trusted = true` is the column that decides it: a trusted extension may be
installed by any role holding `CREATE` on the database, which `neondb_owner`
has. Rehearsed inside a transaction and rolled back before anything was
committed, on both branches, and all four created cleanly. An extension outside
that set (`hstore`, say) is refused even to the owner, which the app-role probe
in [section 11b](#11b-least-privilege-proved-by-connecting-as-the-role) shows
incidentally.

The general rule this leaves behind: **check every extension the migrations
reference, and check whether the owner may create it, rather than checking the
one extension somebody remembered.** An extension missing on `main` is also
missing on every branch cut from it.

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

#### Two credential traps that both look like something else

**`NEON_API_KEY` must be in the environment. `TF_VAR_neon_api_key` is not a
substitute.** `provider "neon" {}` takes no arguments deliberately (a value
assigned to a provider argument is rendered into the plan file, and this
repository is public), so the provider reads the environment variable directly.
There is no variable for it to pick up. With only the `TF_VAR_` form set, the
provider authenticates as nobody and the failure is an authorisation error
against Neon rather than anything mentioning the variable.

**The 1Password R2 item uses custom field labels, not `username`/`password`.**
`pull-fm/infra/R2_TFSTATE` stores `access key id`, `secret access key` and
`s3 endpoint`. So this returns empty and does not error:

```bash
op read "op://MCP/pull-fm/infra/R2_TFSTATE/username"      # empty, exit 0
```

and Terraform then fails with **`No valid credential sources found`**, which
reads like a missing AWS profile rather than an empty variable. Labels with
spaces cannot be addressed by `op read` at all, which is why
`infra/lib/credentials.sh` uses `op item get --fields "label=..."` and why
`pullfm_load_credentials neon` is the supported path rather than a convenience.

### 5.1a Verify the pooler AGAINST THE API, not against Terraform

**Do this after every apply that creates an endpoint. Neon ignores
`pooler_enabled` when an endpoint is created.**

Observed on the first real apply, 2026-07-29: `neon_endpoint.staging` declared
`pooler_enabled = true`, the provider sent it in the create request, and Neon
created the endpoint with pooling **off**. The attribute works correctly on
update, so the next plan detected the drift and a second apply fixed it.

The consequence if nobody looks: a single apply leaves an endpoint that every
output, connection string and document here calls pooled, while it is not. The
application would open one server connection per client connection against a
compute that scales to zero, which is the exact failure the pooled endpoint
exists to prevent.

**Terraform cannot be trusted to tell you this, and that is the point of the
step.** State was written from the create response and agreed with the
configuration, so `terraform plan` was clean immediately after the apply. Only
the API disagreed. Ask the API:

```bash
curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/<neon-project-id>/endpoints" |
  python3 -c 'import json,sys; [print(e["id"], e["pooler_enabled"], e["pooler_mode"]) for e in json.load(sys.stdin)["endpoints"]]'
```

Every endpoint must report `True transaction`. If one reports `False`, re-run
`terraform plan` (it will now show the drift, because refresh reads the API) and
apply again.

A `postcondition` on `pooler_enabled` would not catch this, because state is not
where the lie is. The durable guard is the one Gate 0 already asks for:
**re-plan after applying and require zero drift.**

Note that the API's `host` field is the DIRECT host even when pooling is on. Do
not read pooler status off the hostname.

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
        "postgres://pullfm@<retired-db-node-private-ip>:5432/pullfm" > pullfm-$(date +%F).dump

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

**This has to come after the MIGRATIONS, not after 5.4 specifically.**
`grant-app-role.sql` grants on the tables that exist, and the tables are created
by the migration step. Running it against an empty database grants nothing on
the schema and only the `ALTER DEFAULT PRIVILEGES` half takes effect; the result
looks successful and leaves the existing tables unreadable to the application.

Earlier revisions of this section said "after 5.4", because 5.4 is what happened
to run the migrations. That is the wrong dependency to write down: on 2026-07-29
the migrations were run directly with `migrate.mjs` against
`DATABASE_URL_DIRECT` and 5.4 was not run at all, which satisfies the real
constraint perfectly well. See
[section 11](#11-what-actually-happened-on-the-schema-and-role-cutover).

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
  "https://console.neon.tech/api/v2/projects/<neon-project-id>/branches/<neon-main-branch-id>/roles/neondb_owner/reset_password"

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
aws s3api get-bucket-versioning --bucket <tfstate-bucket>   # exit 0, empty body
aws s3api get-bucket-policy     --bucket <tfstate-bucket>   # NotImplemented
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
  "https://console.neon.tech/api/v2/projects/<neon-project-id>/branches/<staging-branch-id>/restore" \
  -H 'Content-Type: application/json' \
  --data '{"source_branch_id":"<neon-main-branch-id>"}'
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

### 10d. Two defects that only appeared against real infrastructure

Both were invisible to `terraform validate`, to `terraform plan` against an
empty state, and to review. Both needed real resources to exist. That is the
lesson worth keeping from this apply: a clean plan against nothing is not
evidence.

#### Neon ignores `pooler_enabled` on endpoint creation

Covered as an operational step in [5.1a](#51a-verify-the-pooler-against-the-api-not-against-terraform).
The mechanism, for the record: the provider does send it. Its create path builds
`EndpointCreateRequestEndpoint.PoolerEnabled` from the attribute, so the request
is correct and **the API drops it**. The same attribute is honoured on update,
which is why a second apply fixed it.

There is no Terraform-side guard for this and it is worth being precise about
why, because the obvious ones look like they would work:

- A `postcondition` on `self.pooler_enabled` reads **state**, and state was
  written from the create response and agreed with the configuration.
- The `neon_branch_endpoints` data source would re-read from the API, but it
  exposes only `id`, `host`, `type`, `region_id` and `proxy_host`. It does not
  expose `pooler_enabled`, so it cannot see the discrepancy either.
- The hostname cannot be used as a proxy for pooler status, because the API's
  `host` field is the direct host whether pooling is on or off.

So the guard is procedural: verify against the API after an apply, and require a
clean re-plan, which Gate 0 already asks for.

#### The pooled hostname was derived from an attribute that changes meaning

This one was a bug in this module rather than in Neon.

`neon_endpoint` exposes a single `host` attribute, unlike `neon_project` which
exposes `database_host` and `database_host_pooler` separately. The staging
pooled host was therefore derived by appending `-pooler` to
`neon_endpoint.staging.host`.

**That attribute is the direct host while pooling is off and the pooled host
once it is on.** The Neon API always returns the direct host; the provider
rewrites it in `provider/resource_endpoint.go`:

```go
host := v.Host
if v.PoolerEnabled {
    host = newPooledHost(host)
}
d.Set("host", host)
```

So once the second apply enabled pooling, the module wanted to publish:

```
staging_host_direct   <neon-staging-endpoint-id>-pooler.c-4...          the POOLED host, labelled direct
staging_host_pooled   <neon-staging-endpoint-id>-pooler-pooler.c-4...   resolves to nothing
```

Neither is an error at plan time. The first would silently run migrations
through a transaction pooler, breaking the session advisory lock in exactly the
way section 0 warns about; the second fails at connect time.

The fix is to stop deriving from a mutable-meaning attribute and build both
hostnames from `id` and `proxy_host`, neither of which the provider rewrites and
neither of which changes when pooling is toggled:

```hcl
staging_direct_host = "${neon_endpoint.staging.id}.${neon_endpoint.staging.proxy_host}"
staging_pooled_host = "${neon_endpoint.staging.id}-pooler.${neon_endpoint.staging.proxy_host}"
```

That is correct in both states, which matters because the two-step apply means
both genuinely occur. It also reuses the provider's own composition rule rather
than guessing one: `newPooledHost` splits the host at its first `.` and appends
`-pooler` to the left part, and that left part is exactly the endpoint id while
the right part is exactly `proxy_host`.

`checks.tf` now asserts the invariant permanently, with the hard failures on the
outputs so a hostname that does not resolve cannot be read out of
`terraform output` at all. One detail there is worth reading before simplifying
it: **the relative assertion alone does not catch this bug.** Both hostnames were
shifted by one `-pooler`, so their relationship to each other still held while
both values were wrong. Only the absolute assertions (the direct host contains no
`-pooler`, the pooled host contains no `-pooler-pooler`) detect it.

## 11. What actually happened on the schema and role cutover

Run 2026-07-29, against both live branches, in the order below. Everything in
sections 11a and 11b succeeded. Everything that differed from what the rest of
this runbook predicted is called out rather than quietly corrected.

**One deviation from the written order, stated up front.** Section 5.5 says the
role work must come after 5.4, and 5.4 is `./infra/staging-env.sh up`. That was
not run: the application nodes are not part of this step, and the only reason
5.5 depends on 5.4 is that `grant-app-role.sql` needs the tables to exist.
`migrate.mjs` was run directly against `DATABASE_URL_DIRECT` instead, which
satisfies the real dependency. **The constraint is "tables before grants", not
"staging-env.sh before grants",** and 5.5 should say so.

`staging` was done first in every step, as a rehearsal for `main`. That is worth
keeping as the rule: the two branches are the same engine and the same schema,
so a mistake on staging is the same mistake, discovered for free.

### 11a. Migrations

Six migrations, both branches, through the direct endpoint as `neondb_owner`.
Applied cleanly on the first attempt with no manual pre-step of any kind, which
is the payoff for 0001 creating its own extensions (see section 4).

```
applying 0001_initial.sql ... 0006_audit_log_retention.sql
6 migration(s) applied
```

Re-running immediately reports `schema is up to date (6 migrations applied)`, so
the checksum and `schema_migrations` paths both work against Neon.

The two branches finished byte-for-byte comparable:

|                      | `main`                                         | `staging`      |
| -------------------- | ---------------------------------------------- | -------------- |
| tables in `public`   | 13                                             | 13             |
| views                | 1 (`cache_size_by_provider`)                   | 1              |
| sequences            | 1 (`audit_log_id_seq`)                         | 1              |
| extensions           | `citext, pg_trgm, pgcrypto, plpgsql, unaccent` | same           |
| owner of every table | `neondb_owner`                                 | `neondb_owner` |

### 11b. Least privilege proved by connecting as the role

`create-app-role.sql`, `grant-app-role.sql` and `verify-app-role.sql` were run
per branch, as the owner, through the direct endpoint. **34 of 34 assertions
passed on both branches, including the unconditional `GUARANTEE` row.** The role
was created with SQL, so it was never a member of `neon_superuser` and the
drop-and-recreate path in section 10b was not needed. Worth stating plainly
because it is the claim the whole design rests on:

```
PASS | GUARANTEE | pullfm_app is NOT a member of neon_superuser | false | false
NOTICE:  all 34 privilege assertions passed for pullfm_app on database neondb
```

Then, separately, the thing that actually settles it: **a psql session opened as
`pullfm_app`**, on the direct endpoint, on both branches. 34 probes per branch,
zero failures. The session reports what the role scripts intended:

```
identity: pullfm_app @ neondb | statement_timeout=30s
        | idle_in_transaction=1min | is_superuser=off
```

| Allowed, and verified by doing it              | Refused, with the error Postgres actually gave                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `users` | `DROP TABLE users` (`must be owner of table users`)                                     |
| `citext` case-insensitive match on `email`     | `ALTER TABLE users` (`must be owner of table users`)                                    |
| `SELECT` on the `cache_size_by_provider` view  | `TRUNCATE users` (`permission denied for table users`)                                  |
| `nextval('audit_log_id_seq')`                  | `CREATE TABLE` (`permission denied for schema public`)                                  |
| `INSERT` into `audit_log` (identity column)    | `CREATE TEMP TABLE` (`permission denied to create temporary tables`)                    |
| `unaccent('Björk')` and `similarity()`         | `CREATE INDEX` (`must be owner of table users`)                                         |
| `gen_random_uuid()`                            | `SET ROLE neon_superuser` (`permission denied to set role`)                             |
| `pg_try_advisory_lock()`                       | `SET ROLE neondb_owner` (`permission denied to set role`)                               |
|                                                | `CREATE ROLE` / `CREATE DATABASE` / `CREATE EXTENSION`                                  |
|                                                | `SELECT` on `pg_authid` (`permission denied for table pg_authid`)                       |
|                                                | `setval()` **and** `SELECT last_value` on a sequence (`permission denied for sequence`) |

The last row is the one section 10c did not list and is worth keeping: `USAGE`
on a sequence really is only `nextval`, so neither rewinding a sequence nor
reading its current value is available. That was an intended property of the
grant script and it had never been checked.

**The `ALTER DEFAULT PRIVILEGES` mechanism was proved live, not inferred.** This
is the half that silently breaks production if it is wrong, so it was exercised
the way a future migration will exercise it: as the owner, **after** all the
grants had already been made, a brand new table and its `bigserial` sequence
were created, and **no grant of any kind was issued for them**. The app role
could immediately `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `nextval()` on
them, and was still refused `TRUNCATE` (`permission denied for table`) and
`DROP` (`must be owner of table`). The owner then dropped the probe table. Both
branches, same result, and a residue check afterwards confirmed zero probe rows,
zero probe tables and zero probe roles left behind.

That is the mechanism that stops every future migration silently breaking the
app, and it now has evidence behind it rather than a `pg_default_acl` row.

One small thing the grant script expected to be harder than it was: section 6 of
`grant-app-role.sql` treats `ALTER ROLE pullfm_app SET ...` as best-effort,
because it is not documented whether the owner holds admin rights over the role.
It does, and the script took the first branch on both databases
(`NOTICE: set session guards on pullfm_app as the owner`). The
`SET ROLE neon_superuser` fallback was never needed and was not exercised.

### 11c. Three harness defects that only a real credential exposes

Gate 1 (`packages/db/scripts/verify-migrations.mjs`) was run against the Neon
staging branch. **Every assertion passed on the first attempt**: both up/down
cycles, the deletion cascade, all twelve defensive constraints, both retention
assertions and the licence-compliance view. Nothing about the SCHEMA behaves
differently on Neon than on local Postgres 18.

The harness around it, however, failed three separate ways, and all three are
invisible locally. They are recorded here because the shape recurs: **a test
harness that has only ever run against a local throwaway database has never had
its failure paths tested with anything that matters.**

1. **It printed the production-grade credential to stdout.** `execFileSync` puts
   the entire command line into `err.message`, and the command line is a
   connection string. Locally that discloses
   `pullfm_local_dev_not_a_secret`, which is why it survived review; against Neon
   it printed the staging owner's password in full, at the top of a stack trace.
   Fixed with a `scrub()` applied to every message the script emits.
   **This is why the staging owner credential is flagged for rotation at the top
   of this file.** Section 6 already says a rotation is the correct response to
   "I think I pasted the connection string somewhere", and this is that.

2. **`DROP DATABASE` cannot drop the scratch database on Neon.** The teardown in
   the `finally` block failed with

   ```
   ERROR:  database "pullfm_migration_verify" is being accessed by other users
   DETAIL:  There is 1 other session using the database.
   ```

   **Neon does not reap a server backend when the client disconnects.** The
   lingering session was `state=idle`, `application_name=psql`,
   `backend_type=client backend`, owned by `neondb_owner`, and it was still
   there three minutes later; polling did not clear it and it had to be
   `pg_terminate_backend`ed by hand. A local docker Postgres closes the backend
   the instant psql exits, so the drop has always succeeded there. The
   consequence is worse than a failed exit code: **the harness left the scratch
   database behind**, which is precisely the residue it exists to promise it
   never leaves. Fixed with `DROP DATABASE ... WITH (FORCE)`, which is Postgres
   13 or newer and a no-op locally.

3. **The database-swap silently dropped `?sslmode=require`.** The old expression
   was `ADMIN_URL.replace(/\/[^/]*$/, "/" + db)`, and the query string is not
   part of the path, so it was eaten along with the database name. Locally the
   URL has no query string and nothing changed; against Neon every one of these
   connections was downgraded from `require` to libpq's default `prefer`. Nothing
   errors, because `prefer` still negotiates TLS. Fixed by splitting on `?` and
   rewriting only the path.

After all three fixes, Gate 1 passes end to end against Neon, exits zero, and
leaves the branch with exactly `neondb`, `postgres`, `template0` and
`template1`. It still passes locally.

**One difference that is not a defect but is worth budgeting for:** Gate 1 takes
**1.3 seconds locally and about 70 seconds against Neon**, roughly fifty times
longer. The work is identical; the harness shells out to `psql` per statement
and each invocation is a fresh TLS connection through Neon's proxy from another
continent. If Gate 1 ever moves into a per-commit CI job pointed at Neon, that
is the number to plan around, and batching statements per connection is the
lever.

### 11d. Where the connection strings live now

All four items are in the **MCP** vault, as `Login` items with the secret in a
concealed field labelled `credential`, which is what `infra/lib/secrets.sh`
reads. They also carry `role` and `endpoint` fields, so which privilege level an
item holds is visible without opening it.

| Item                                  | Role           | Endpoint |
| ------------------------------------- | -------------- | -------- |
| `pull-fm/prod/DATABASE_URL`           | `pullfm_app`   | pooled   |
| `pull-fm/prod/DATABASE_URL_DIRECT`    | `neondb_owner` | direct   |
| `pull-fm/staging/DATABASE_URL`        | `pullfm_app`   | pooled   |
| `pull-fm/staging/DATABASE_URL_DIRECT` | `neondb_owner` | direct   |

The two app roles have **different passwords**, both from `openssl rand -base64 24`,
and each was used exactly once and never written to disk. Both pooled strings
were confirmed to connect as `pullfm_app`.

**Percent-encoding is not optional and is not always needed, which is the trap.**
`openssl rand -base64 24` draws from an alphabet containing `+` and `/`. Of the
two passwords generated here, **one needed percent-encoding in the URL and the
other did not.** A procedure that skips the encoding step therefore works most
of the time and fails intermittently, on a fresh password, at deploy time. Encode
unconditionally; it is a no-op when there is nothing to encode.

### 11e. Two smaller facts that contradicted an assumption

- **`neondb_owner` has `rolcreatedb = true`.** Section 10b is about `CREATEROLE`,
  which the owner genuinely lacks, and it is easy to read across from that to
  "the owner can do nothing administrative". It can create databases, and that
  is load-bearing: it is the only reason Gate 1 can create its scratch database
  on Neon at all, with no `SET ROLE` and no elevation.
- **Every branch has a `postgres` database**, owned by `cloud_admin`, and
  `neondb_owner` may connect to it. Gate 1 hardcodes `postgres` as the database
  it issues `CREATE DATABASE` from, so this was a real prerequisite and not an
  obvious one.

### 11f. Neon parks idle backends, and session state survives the client

This is the most surprising thing found on the whole cutover, it is not
documented anywhere in this repository, and it invalidates an assumption that
every Postgres user is entitled to make everywhere else.

**A server backend on Neon is not torn down when its client disconnects. It is
parked, with its session state intact, and handed to a later client.** Measured
on the staging branch, on the **DIRECT** endpoint, so this is not the pooler:

```
session A  CREATE TEMP TABLE _reuse_probe (x int);   -- then disconnect
session B  (new psql process)  sees _reuse_probe: true
session C  (new psql process)  sees _reuse_probe: true
```

and later, from a completely fresh connection after everything had disconnected:

```
temp relations inherited: pg_temp_9._pullfm_privcheck,
                          pg_temp_9._pullfm_privcheck_seq_seq,
                          pg_temp_9._reuse_probe
advisory locks inherited: 2
```

Two things it is important NOT to conclude from that, because both were checked:

- **It is not multiplexing, and concurrency is not broken.** Three
  simultaneously live clients occupied three distinct backends (`pid` 634, 4179
  and 4180 all present in `pg_stat_activity` at once). The reuse is of an IDLE
  backend, forward in time, not of a busy one.
- **Advisory locks still serialise correctly between concurrent runners.** With
  one client holding `pg_advisory_lock(987654)` and a second client live at the
  same moment, the second was refused: `pg_try_advisory_lock -> false`. That is
  the property `migrate.mjs` depends on and it holds.

**What it broke immediately.** `verify-app-role.sql` opens with
`CREATE TEMP TABLE _pullfm_privcheck`, and its SECOND run against a branch failed
with `ERROR: relation "_pullfm_privcheck" already exists`, because the temp table
from the first run was still parked in the backend the second run was given. The
file was therefore **not idempotent on Neon** while being perfectly idempotent
locally, and re-running it is the documented answer to "I am not sure what state
this role is in". Fixed by dropping the table before creating it; the reasoning
is written into the file. Now verified by running it three times in a row against
each branch: 34 of 34 assertions, exit 0, every time.

**The hazard this leaves open, stated because it is not fixed.** A session-scoped
advisory lock was observed surviving its client's disconnect. `migrate.mjs` takes
exactly such a lock and relies on `client.end()` releasing it. Nothing went wrong
during this cutover, every migration run completed, and no hang was observed. But
the two ingredients were both observed directly: the lock outlives the client,
and a concurrent client on a different backend is genuinely blocked by it. So
**a deploy that dies uncleanly could leave a lock parked on an idle backend, and
the next deploy would block on `pg_advisory_lock` rather than fail**, which
presents as a migration step that hangs instead of erroring.

Three things reduce it and none of them removes it: Neon eventually reaps parked
backends, the compute suspends after five minutes of inactivity (which
necessarily drops them), and deploys are not concurrent today. If a migration
step ever hangs, this is the first thing to check, and the remedy is the one used
during this cutover:

```sql
SELECT pid, state, now() - backend_start AS age
  FROM pg_stat_activity
 WHERE datname = 'neondb' AND backend_type = 'client backend';

SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = 'neondb' AND backend_type = 'client backend'
   AND pid <> pg_backend_pid();
```

The durable fix, if this ever bites, is `pg_try_advisory_lock` with a timeout and
a loud failure instead of `pg_advisory_lock`'s unbounded wait. That is a change
to the deploy path and was deliberately not made as part of a database
migration.

**The general lesson, which is the same one as
[section 11c](#11c-three-harness-defects-that-only-a-real-credential-exposes):**
"a temp table dies with the session" is a Postgres guarantee, and Neon is
Postgres, so nobody thinks to test it. Anything in this repository that relies on
a session ending when a client disconnects should be assumed suspect until it has
been run twice in a row against Neon.

## Appendix A: the verified plan

Predicted 2026-07-29, then **applied the same day with exactly this result**.

```
Plan: 4 to import, 2 to add, 1 to change, 0 to destroy.

  neon_project.pullfm       import  <neon-project-id>
  neon_database.main        import  <neon-project-id>/<neon-main-branch-id>/neondb
  neon_role.owner           import  <neon-project-id>/<neon-main-branch-id>/neondb_owner
  neon_endpoint.main        import  <neon-project-id>/<neon-main-endpoint-id>
                            change  pooler_enabled false -> true
  neon_branch.staging       create  name "staging", parent <neon-main-branch-id>
  neon_endpoint.staging     create  read_write, pooled, 0.25-1 CU
```

What it actually created:

```
branch    <neon-staging-branch-id>   "staging", parent <neon-main-branch-id>
endpoint  <neon-staging-endpoint-id>     read_write, 0.25-1 CU
          direct  <neon-staging-endpoint-id>.c-4.eu-central-1.aws.neon.tech
          pooled  <neon-staging-endpoint-id>-pooler.c-4.eu-central-1.aws.neon.tech
```

**The last line of the predicted plan was wrong, and Terraform was not lying.**
`neon_endpoint.staging` was created with pooling **off**, because Neon ignores
`pooler_enabled` on create. A second apply turned it on. See
[section 10d](#10d-two-defects-that-only-appeared-against-real-infrastructure)
and verify with [5.1a](#51a-verify-the-pooler-against-the-api-not-against-terraform)
rather than trusting this appendix.

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
