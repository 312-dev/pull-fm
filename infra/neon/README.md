# Pull.fm - Neon serverless Postgres

> ## REPOINTED TO THE US PROJECT ON 2026-07-29. PLAN IS CLEAN, AND THAT CLAIM IS CHECKABLE.
>
> This root manages `cold-brook-02833828` (`pull-fm-us`, `aws-us-east-1`,
> Postgres 18, `launch_v3`, PITR 7 days). The EU project `steep-frost-83698289`
> was the rollback for the cutover and **was deleted on 2026-07-29** once the US
> side was verified. There is one Neon project again.
>
> **All six resources are adopted by import. This root creates nothing.** That is
> a change: on the EU project, `neon_branch.staging` and `neon_endpoint.staging`
> were created by Terraform. On the US project they already existed, so they have
> import blocks of their own. Read `imports.tf` before touching anything here -
> it explains that without those two blocks a repointed apply reads as "2 to
> add", applies cleanly, and cuts a SECOND `staging` branch on the US project
> while the live one goes unmanaged. Neon does not require branch names to be
> unique.
>
> **What the repoint actually consisted of**, because "we changed a variable" is
> not what happened:
>
> - A verified pre-apply snapshot from `infra/lib/tfstate-snapshot.sh --local`.
>   R2 cannot version objects, so that is the only rollback.
> - `terraform state rm` on all six resources. `state rm` forgets an object
>   without touching it, so nothing in either project was destroyed by it.
> - Six import blocks against the US project, its database, its owner role, its
>   staging branch and BOTH endpoints.
> - `variable "region_id"` relaxed from `aws-eu-*` to `aws-us-*`. That validation
>   was a stated GDPR control; the residency posture moved to United States only
>   and `legal/privacy-policy.md` now states the database as `aws-us-east-1`, so
>   the check changed sides rather than being deleted. Read the comment above it.
> - `history_retention_seconds` 21600 -> 604800 and `staging_max_cu` 1 -> 8. Both
>   are properties of the new project and plan, not carried-over values. Leaving
>   the first would have planned a REDUCTION of the restore window from seven days
>   to six hours, which applies cleanly and is only noticed by somebody trying to
>   restore.
>
> The applied plan was **6 imported, 0 added, 3 changed, 0 destroyed**. The three
> changes were `pooler_enabled false -> true` on both endpoints and `protected =
"no"` written onto the adopted staging branch. `terraform plan` now reports no
> changes, with no `-var` overrides.
>
> **THIS ROOT NOW REQUIRES A GITIGNORED `terraform.tfvars`, WHICH IT DID NOT
> BEFORE.** The six import blocks used to carry the live branch and endpoint ids as
> literals in a tracked file, which is what `tools/check-public-identifiers.mjs`
> exists to prevent, and eleven of its baseline findings came from `imports.tf`
> alone. Those ids moved into four variables with no defaults, supplied from
> `terraform.tfvars`. Consequences: `plan` without that file fails with "No value
> for required variable", which is a safe stop rather than a wrong plan;
> `terraform init -backend=false && terraform validate` is unaffected; and the
> values are always re-derivable from the control plane with the commands in
> `terraform.tfvars.example`. Deleting the import blocks was the alternative and
> was rejected - they are inert while state is intact and they are the RESCUE if
> state is lost, where the failure is not an error but a plan to create a second
> Neon project.
>
> **THE PERMANENT PLAN DIFF IS GONE, AND IT WAS THE MOST IMPORTANT THING HERE.**
> An earlier revision of this banner said the plan was clean while
> `terraform plan` reported `neon_endpoint.staging autoscaling_limit_max_cu
8 -> 1` on every run: the live endpoint was 8 and the configuration said 1,
> because 1 was `free_v3` arithmetic. Nobody applied it, because nobody believed
> it. A root whose plan is never clean teaches everyone reading it to skip the
> plan, which is worse than the drift it was hiding. See the long block above
> `staging_max_cu` in `variables.tf` for what was given up by matching 8.
>
> **One earlier claim was measured and turned out to be false.** This module said
> that with `pooler_enabled` false "the pooled host resolves but refuses
> connections". On 2026-07-29, with the API reporting false on both US endpoints,
> the `-pooler` hostname accepted connections and reported the pooled-path role
> default. So the flag and the served behaviour had already diverged, and setting
> it true corrected what Neon REPORTS rather than switching a working path on.
> Neon still ignores `pooler_enabled` at creation and honours it on update, which
> is why an endpoint created outside Terraform arrives as drift.
>
> The `pullfm_app` role and its grants are not resources here, so none of the
> state surgery touched them. They were applied with `sql/*.sql` per branch and
> verified; see below.
>
> **THE LIVE 1PASSWORD ITEMS STILL CARRY A `_US` SUFFIX, AND THAT IS AN OPEN
> ITEM RATHER THAN A DECISION.** The connection strings the application, the
> backup tooling and the verifiers actually use are
> `pull-fm/{staging,prod}/DATABASE_URL_US` and `..._DIRECT_US`, plus
> `pull-fm/staging/R2_CREDENTIALS_US`, `..._LEDGER_CREDENTIALS_US` and
> `..._DRILL_LEDGER_CREDENTIALS_US`. The plain-named EU originals were **archived
> and retitled `(RETIRED 2026-07-29)`** when the EU estate was retired, so the
> plain titles no longer resolve.
>
> The suffix is a migration artifact and should be dropped, but dropping it is a
> two-sided change: the titles are referenced by `infra/lib/secrets.sh`,
> `infra/lib/backup-common.sh`, `infra/backup/restore-drill.sh`,
> `infra/backup/README.md`, `infra/mb-loader/systemd/README.md` and
> `packages/db/scripts/verify-query-ceilings.mjs`. Renaming the items without
> those edits breaks the backup path and the restore drill, so the rename and the
> edits go in one change. Every `PGURL_ITEM=` example below therefore names the
> `_US` item, because that is the one that resolves today.

The full migration procedure, the free-plan analysis and the rollback paths live
in [`docs/runbooks/neon-migration.md`](../../docs/runbooks/neon-migration.md).
This file covers the Terraform only.

---

## Why this is a fourth root

`envs/staging` and `envs/prod` call an identical module graph and differ only by
variables. The database does not fit that shape, because **one Neon project holds
both environments**: `main` serves production and `staging` is a child branch of
it. Splitting ownership of one project across two roots would mean every apply of
one fought the other, which is the same problem `envs/shared` was created to
solve for zone-wide TLS settings. So the Neon project has exactly one owner, and
this is it.

```
infra/
├── neon/          <- this root. One Neon project, both environments.
└── terraform/
    ├── modules/
    └── envs/{shared,staging,prod}
```

## Provider

`kislerdm/neon ~> 0.14`. **There is no official Neon provider**; Neon's own
documentation says they sponsor this community one and that it "is not
maintained or officially supported by Neon", and the registry returns 404 for
both `neondatabase/neon` and `neondatabase-labs/neon` (checked 2026-07-29).
Reasoning and the bounded-risk argument are in `versions.tf`.

## Credentials

Same rule as every other root: **credentials are never Terraform variables.**

```bash
source infra/lib/credentials.sh
pullfm_load_credentials neon
```

That exports `NEON_API_KEY` plus the R2 state pair, and nothing else. It then
calls `pullfm_assert_neon_scope`, which lists projects with the key and refuses to
continue if it can see any project other than **`pull-fm-us`**, or any personal
project at all.

That accepted set was two names for the length of the cutover, because a Neon
region is immutable and the US project had to exist alongside the EU one. It is
back to one: `pull-fm` came off the list in the same change that deleted the
project, on the principle its own comment states - a second accepted project that
no longer exists is a standing exemption nobody reads.

`provider "neon" {}` is deliberately empty. A value assigned to a provider
argument is rendered into the plan file even when it comes from a `sensitive`
variable, plan files get attached to pull requests, and this repository is
public.

**OPEN ITEM: the key is fetched from 1Password by ITEM ID, and it does not have
to be.** `pullfm_load_credentials neon` runs
`op read "op://MCP/<item-id>/password"`, and this file used to justify that by
saying the item's title contains parentheses so an `op://` reference cannot
address it by title. **The first half is true and the conclusion is not.**
Measured 2026-07-30:

```
$ op read "op://MCP/Neon API Key (pull.fm)/password"
[ERROR] invalid secret reference: invalid character in secret reference: '('

$ op item get "Neon API Key (pull.fm)" --vault MCP --fields label=password --reveal
<the same value; sha256 of both outputs matches>
```

So only the `op://` _reference syntax_ rejects the parenthesis. `op item get`
addresses the same item **by title** and returns the identical secret, and
`credentials.sh` already uses `op item get` elsewhere in the same file. That
matters because `tools/check-public-identifiers.mjs` carries a detector for vault
item ids whose stated reason is that "a vault item id is a direct object
reference to a specific credential; it turns any vault access from a search
problem into a fetch" - and one is currently hardcoded in a tracked file in a
public repository. The fix belongs in `infra/lib/credentials.sh`, which this root
does not own; the diff is written up rather than applied.

## Usage

```bash
cd infra/neon
source ../lib/credentials.sh && pullfm_load_credentials neon
cp backend.hcl.example backend.hcl        # gitignored; fill in the R2 endpoint
cp terraform.tfvars.example terraform.tfvars   # gitignored; REQUIRED, see below
terraform init -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan                # READ THE PLAN
terraform apply tfplan
```

`terraform.tfvars` is **not optional any more**. The four adoption identifiers at
the bottom of `terraform.tfvars.example` have no defaults because they are live
branch and endpoint ids; the example file carries the two `curl` commands that
read them out of the Neon API, and nothing should be transcribed by hand.

To validate with no credentials at all, which is what CI can do and what
provisions nothing:

```bash
terraform init -backend=false && terraform validate
```

`.terraform.lock.hcl` is committed and locked for `linux_amd64`, `linux_arm64`
and `darwin_arm64`, matching the other roots.

## What is in the state file

**This state is more sensitive than the Hetzner roots and must be treated that
way.** Neon returns role passwords through its API, so `neon_role.password`,
`neon_project.connection_uri` and `neon_project.connection_uri_pooler` are all
stored in plaintext in state. Marking the outputs `sensitive` keeps them out of
plan output and CI logs; it does nothing about the state file, and no provider
setting can.

Consequences that follow from that, rather than opinions about it:

- The R2 state bucket is the trust boundary for the production database
  credential. It uses a **separate** R2 token from the environment credentials so
  state stays readable if an environment credential is revoked mid-incident.
  That token turns out to be account-scoped rather than bucket-scoped, so it also
  reaches the backups bucket; tracked as `PULLFM-RISK-009`.
- **R2 DOES NOT SUPPORT OBJECT VERSIONING, and earlier revisions of this file
  said it was enabled.** This is a platform limitation, not a setting nobody
  turned on. Cloudflare's S3 compatibility matrix lists `PutBucketVersioning` and
  `GetBucketVersioning` as unimplemented, and does not list `ListObjectVersions`
  at all.

  The reason the earlier claim survived review is worth keeping, because it is
  the trap: `aws s3api get-bucket-versioning` against R2 returns an **empty
  configuration at exit 0**, whereas `get-bucket-policy` returns an explicit
  `NotImplemented`. In S3 an empty versioning configuration means "never
  enabled", so one unsupported API says no by erroring and the other says no by
  shrugging. Only the first is noticeable.

  Two consequences, and they pull in opposite directions. Recovery is worse:
  restoring a previous version of the state object was documented in three places
  as the rollback for a bad apply and has never been possible. Credential hygiene
  is better: there is no historical state object quietly holding a superseded
  database password, so a rotation genuinely retires the old credential.

  The rollback is replaced by verified pre-apply snapshots
  (`infra/lib/tfstate-snapshot.sh`), which are the same idea implemented with
  APIs R2 actually has. Tracked in `PULLFM-RISK-008`.

- A plan file must never be committed or attached to a public pull request.
  `tfplan` and `*.tfplan` are gitignored.

## Design decisions worth knowing before reviewing

### Adoption, and the blocks that are deliberately absent

`neon_project` omits `branch`, `default_endpoint_settings`, `maintenance_window`
and `store_password`. All four are `Optional+Computed` in the provider, so
omitting them adopts whatever the console already set and plans no change.

Declaring them would be actively dangerous. **Every field of the `branch` block
is `ForceNew`**, and the live values are the Neon console defaults: branch
`main`, database `neondb`, role `neondb_owner`. Writing prettier names there
would not rename anything; it would plan to destroy and recreate the project,
which for this resource means deleting the production database. The names are
surfaced as variables and outputs instead, and the database and role are adopted
as resources in their own right.

`history_retention_seconds` is the exception. It carries a **static** provider
default of 86400, so omitting it means "plan a change to 24 hours" rather than
"leave it alone". It is set explicitly to the live value, which is **604800**
(seven days) on the US project. It was 21600 on the EU project, and that number
survived in three places in this repository longer than the project did.

### The default branch is `main`, and nothing here declares its name

The branch was created as `production` and renamed to `main` through the API on
2026-07-29. Branch IDs are stable across a rename, so the import identifier and
the endpoint host are unchanged, and both were re-verified against the live API
afterwards rather than assumed.

Because this configuration never declares the default branch's name, a
console-side rename produces **no plan diff**. The `main_branch_name` output
exists so that such a rename is at least visible in `terraform output`.

Naming convention: `main` is the default branch, and every environment branch is
a child of `main` named after its environment. The table lives in the runbook.

### Two roles, and every output name says which one it uses

The application does not connect as the database owner. There are two identities
and the split is the point:

| Identity             | Role           | May                                                                   | Used by                              |
| -------------------- | -------------- | --------------------------------------------------------------------- | ------------------------------------ |
| Migration / operator | `neondb_owner` | everything, including `DROP`, `ALTER`, `CREATE`                       | `migrate.mjs`, psql, the SQL scripts |
| Runtime              | `pullfm_app`   | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, sequence `USAGE`, and no more | `apps/bff`                           |

Outputs are named `<branch>_database_url_<role>_<endpoint>` so a reviewer can
see which privilege level a string carries without opening anything else. The
previous names said only which endpoint was in use, and the role is the half
that decides what a leaked string can do.

| Env var               | Output                               | Role           | Endpoint |
| --------------------- | ------------------------------------ | -------------- | -------- |
| `DATABASE_URL`        | `*_database_url_app_pooled_template` | `pullfm_app`   | pooled   |
| `DATABASE_URL_DIRECT` | `*_database_url_owner_direct`        | `neondb_owner` | direct   |

The `database_url_assignments` output publishes that same table from Terraform,
so it cannot drift away from the configuration it describes.

**The app-role outputs are templates, not connection strings.** They carry
`REPLACE_WITH_APP_ROLE_PASSWORD` where the password goes, because Terraform does
not create that role and must not learn its password. They are not marked
`sensitive` for the same reason: there is no secret in them.

### The application role is created by SQL, and it is not a Terraform resource

This is the one place the configuration deliberately stops short, so it is worth
reading before assuming it is an omission.

`neon_role` creates a role through the Neon API, and **Neon grants
`neon_superuser` to every role created through the Console, API or CLI.** That
membership carries `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION`,
`pg_read_all_data`, `pg_write_all_data`, `pg_monitor` and `ALL` on the public
schema `WITH GRANT OPTION`. Role attributes are not inherited through
membership, which makes it look survivable, but a member may `SET ROLE
neon_superuser` and use all of it.

Revoking it afterwards does not work, and it fails silently. Measured against
Postgres 18 on 2026-07-29:

```
neondb_owner=> REVOKE neon_superuser FROM pullfm_app;
WARNING:  role "pullfm_app" has not been granted membership in role
          "neon_superuser" by role "neondb_owner"
REVOKE ROLE
```

A warning, a success code, and nothing revoked. Postgres 16 made role membership
track its grantor, and a `REVOKE` only removes grants issued by the revoking
role; Neon's control plane issued this one. Naming the grantor explicitly is
refused with an error, and holding `ADMIN OPTION` does not help, because the
restriction is about the grantor rather than about admin rights. Only the
original grantor or a superuser can revoke, and Neon gives customers neither.

So the role is created with SQL, which Neon documents as the way to get a role
with only "the basic public schema privileges granted to newly created roles in
a standalone Postgres installation":

| Script                      | Does                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `sql/create-app-role.sql`   | creates (or rotates the password of) `pullfm_app`                        |
| `sql/grant-app-role.sql`    | grants exactly the runtime privileges, including future tables           |
| `sql/set-role-timeouts.sql` | sets the query ceilings as **role defaults**, the only form Neon honours |
| `sql/verify-app-role.sql`   | asserts what it can do **and what it must not be able to do**            |

All four are idempotent and are run **per branch**, against the direct endpoint,
as the owner. A Neon branch inherits the roles, grants and role settings that
existed when it was cut, so none of them propagates to a branch that already
exists.

### Query ceilings, and why they are here rather than in the application

`apps/bff/src/lib/db.ts` sets `statement_timeout` and
`idle_in_transaction_session_timeout` on the `pg.Pool`, and node-postgres sends
both in the libpq StartupMessage. **Neon's proxy discards them**, on the pooled
endpoint _and_ on the direct one. Measured on 2026-07-29 against the live
staging branch, with the pool asking for 3000 ms:

| Endpoint | Backend reported                      | `SELECT pg_sleep(6)` |
| -------- | ------------------------------------- | -------------------- |
| pooled   | `30s` (the `pullfm_app` role default) | completed in 6168 ms |
| direct   | `15min` (the owner's role default)    | completed in 6150 ms |

Sending it the other legal way is refused outright on both endpoints:

```
$ PGOPTIONS='-c statement_timeout=3s' psql "$DIRECT_URL"
ERROR:  unsupported startup parameter in options: statement_timeout.
        Please use unpooled connection or remove this parameter ...
```

Note that following that advice does not work; the unpooled endpoint produces
the identical error. So there is **no connection-time way** for the application
to bound a query on Neon, `DATABASE_STATEMENT_TIMEOUT_MS` has no effect in any
deployed environment, and `sql/set-role-timeouts.sql` is the entire mitigation
for THREAT-MODEL T10.

Proving it is a separate step from applying it, because a role default that is
recorded and does not fire passes every catalog check:

```bash
# Applies. Once per branch, as the owner, on the DIRECT endpoint.
psql -v ON_ERROR_STOP=1 -f sql/set-role-timeouts.sql "$OWNER_DIRECT_URL"

# Proves. Over the POOLED endpoint as pullfm_app: reads the catalog, fans out
# to defeat parked backends, then exceeds the ceiling and checks it is killed.
PGURL_ITEM=pull-fm/<env>/DATABASE_URL_US \
  node ../../packages/db/scripts/verify-query-ceilings.mjs
```

Measured with the second command on 2026-07-29, both branches: 20 of 20 sessions
reported 30000 ms / 60000 ms, `pg_sleep(35)` was cancelled after 31045 ms
(staging) and 31099 ms (main), and a session left idle in a transaction for 70 s
was terminated on both.

#### On a brand new, empty Neon project

Nothing in `sql/set-role-timeouts.sql` names a project, region, endpoint, branch
or connection string, so it runs verbatim. Neon regions are immutable at
creation, so replacing a region means a new project, and a bootstrap step that
needs hand-editing on the way is a bootstrap step that gets skipped.

Run this **per branch**, in this order, as `neondb_owner` on the **direct**
endpoint of the branch being provisioned:

```bash
OWNER="<owner connection string, DIRECT endpoint, this branch>"

psql -v ON_ERROR_STOP=1 -f sql/create-app-role.sql   "$OWNER"   # roles first
psql -v ON_ERROR_STOP=1 -f sql/grant-app-role.sql    "$OWNER"   # after migrations
psql -v ON_ERROR_STOP=1 -f sql/set-role-timeouts.sql "$OWNER"   # the ceilings
psql -v ON_ERROR_STOP=1 -f sql/verify-app-role.sql   "$OWNER"   # 40 assertions

# Then, over the POOLED endpoint as pullfm_app, prove the ceilings FIRE.
# ~110 seconds: it waits out both timeouts on purpose.
PGURL_ITEM=pull-fm/<env>/DATABASE_URL_US \
  node ../../packages/db/scripts/verify-query-ceilings.mjs
```

`set-role-timeouts.sql` requires `neondb_owner` and `pullfm_app` to exist and
refuses to run with a message naming `create-app-role.sql` if they do not, so
running it too early fails loudly rather than half-applying. The database name
defaults to Neon's `neondb` and is overridable with `-v expect_database=<name>`.

Both verifiers fail closed. A ceiling that is absent, or recorded as `0`, is a
FAIL and not a skipped row: an unconfigured database must never pass. Gate 1
(`packages/db/scripts/verify-migrations.mjs`) additionally refuses a `0` written
into either SQL file, which is the one way a consistent-looking edit could
neutralise the control everywhere at once.

`create_app_role` was **removed** rather than defaulted to `false`. A boolean
that can only choose between "no app role" and "an app role that is secretly an
administrator" reads in review as a hardening switch waiting to be flipped.

### Pooled and direct are both exposed, and they are not interchangeable

The direct endpoint is a **correctness** requirement for migrations, not a
performance preference. The runner takes a session-scoped `pg_advisory_lock`;
a transaction pooler returns the connection at `COMMIT`, so the lock silently
stops serialising and two concurrent deploys can both run `CREATE TABLE`. It
fails by corrupting a deploy, not by raising an error.

Neon's pooled endpoint **is** PgBouncer in transaction mode, which is why no
PgBouncer is deployed in staging or production any more. It stays in
`docker-compose.dev.yml` so local development meets the same semantics; the
reasoning is written there.

The pooled hostname is derived by appending `-pooler` to the first label of the
direct host. That is not inferred from the naming convention: it is the algorithm
the provider itself uses, and it matches what the live API returns.

### `prevent_destroy` on the objects whose loss is unrecoverable

Applied to `neon_project.pullfm`, `neon_database.main`, `neon_role.owner` and
`neon_endpoint.main`. The project because Neon cannot change a project's region
and `pg_version` is `ForceNew`, so both would be expressed as
destroy-and-recreate. The role because dropping the owner of the application
database orphans every object in it.

Unlike the Hetzner roots there is no second, vendor-side lock here: Neon has no
`delete_protection` equivalent. So `prevent_destroy` is the only lock, which is a
weaker position than the Hetzner nodes were in and is stated rather than glossed.

This paragraph used to add "and protected branches are a paid-plan feature",
offered as a second reason no vendor lock was available. That half is no longer
true on `launch_v3`, and it was never quite the same thing anyway: a protected
branch is not a protected PROJECT, and it is the project whose loss is
unrecoverable. Turning branch protection on would not give this resource a second
lock. See `default_branch_protected` in `variables.tf`.

### The plan changed with the project, and most of this section expired

**What this section used to say, because the arithmetic is still worth having.**
`org-tiny-leaf-89756764` was on `free_v3`: 0.5 GB storage per project, 100
CU-hours per project per month, an autoscaling ceiling of 2 CU, 10 branches, and
a 6 hour restore window. Staging-as-a-branch fitted comfortably. **Production did
not** - 100 CU-hours at the 0.25 CU floor is 400 hours of activity against 730 in
a month. A paid plan was recorded as a Phase 6 prerequisite.

**That prerequisite has been met, and it is the reason several numbers in this
repository changed at once.** `cold-brook-02833828` is on `launch_v3`. Read back
from the API on 2026-07-29: `branches_limit` 5000,
`branch_logical_size_limit_bytes` 16 TiB, `default_endpoint_settings` of 0.25 to
8 CU with the platform-default suspend, and `history_retention_seconds` 604800.
Every free-plan figure written elsewhere in this repository is now historical, and
`docs/runbooks/mb-canonical-data.md` already carries the general form of the
lesson: **a plan limit is a per-project property and it does not travel, so read
it rather than assuming it.**

**What the paid plan did NOT unlock.** `allowed_ips` is a Scale feature, so
`launch_v3` is still below it and `PULLFM-RISK-007` stands unchanged. Protected
branches ARE now available; the default branch is still unprotected, and the
reason is no longer the plan - see `default_branch_protected` in `variables.tf`.

**What replaced the allowance as the spend control, and it is now ARMED.** A
fixed monthly allowance that simply stops is a crude cap, but it is a cap. On a
paid plan, overspend is money. The mechanism for bounding it is `var.quota`,
enforced server-side across the project, and as of 2026-07-30 it holds real
numbers. See the next section.

### The spend cap, and how to see it coming

**`var.quota` is armed to a USD 35 per month budget, and the owner accepted the
outage risk.** Exceeding a quota suspends every active compute in the project and
Neon refuses to start them again until the billing period rolls over, which on
`main` means **production is down**. That is the accepted trade: an outage rather
than a surprise bill. The full derivation from USD 35 to each number, and the
pricing it was computed from, is in the comment block above `variable "quota"` in
`variables.tf`. The live values:

| Dimension              | Value          | Means                                                                    |
| ---------------------- | -------------- | ------------------------------------------------------------------------ |
| `compute_time_seconds` | `720000`       | 200 CU-hours, USD 21.20 at USD 0.106/CU-hour. **The cap that matters.**  |
| `data_transfer_bytes`  | `520000000000` | 520 GB. 500 GB is included, so USD 2.00 of overage worst case.           |
| `active_time_seconds`  | `0`            | Unlimited. Not a billed metric; capping it can cost an outage for USD 0. |
| `written_data_bytes`   | `0`            | Unlimited. Not populated on `launch_v3` and not in the price list.       |
| `logical_size_bytes`   | `0`            | Unlimited. **See the warning below before you change this one.**         |

Worst case is USD 21.20 compute + USD 2.00 egress (both hard-capped) + USD 9.00
reserved for branch storage and instant restore (**neither of which any quota
dimension can bound**) = **USD 32.20**, or 8.0% under budget.

**`compute_time_seconds` is CU-seconds, not wall-clock seconds.** One active
second costs 0.25 of it at the autoscaling floor and 8 at the ceiling, so on this
project the two differ by up to **32x**. `active_time_seconds` is the wall-clock
one. Sizing a spend cap off the wrong one is the single easiest way to be wrong
here by a factor of thirty-two.

**DO NOT set `logical_size_bytes` to anything between 1 and 25 GB.** It caps a
**single branch** for that branch's **lifetime**, not per billing period, so
tripping it does not clear at the rollover. `infra/mb-loader/mb-canonical-load.sh`
is stage-then-swap: it builds a complete second copy of the 11.05 GB canonical
table with all its indexes and only then drops the first, so the staging branch
peaks near **22 GB** every time `pullfm-mb-canonical.timer` finds a new dump. A
cap sized to the steady state suspends staging on a scheduled job. A `validation`
in `variables.tf` refuses such a value.

**`launch_v3` has no base fee and no included compute hours.** Older comments in
this repository said "compute past the included hours is billed". That described
the retired Launch plan. The current one is pure consumption at USD 0.106 per
CU-hour from the first CU-second, so there is no allowance to budget against.

**Watch consumption, because with a hard quota the first signal is an outage.**
Every number needed is on the free `GET /projects/{id}` call:

```bash
source infra/lib/credentials.sh && pullfm_load_credentials neon
curl -sS -H "Authorization: Bearer ${NEON_API_KEY}" \
  https://console.neon.tech/api/v2/projects/cold-brook-02833828 |
  jq '.project | {
        period_start: .consumption_period_start,
        period_end:   .consumption_period_end,
        compute_used: .compute_time_seconds,
        compute_cap:  .settings.quota.compute_time_seconds,
        compute_pct:  (.compute_time_seconds / .settings.quota.compute_time_seconds * 100),
        egress_used:  .data_transfer_bytes,
        egress_cap:   .settings.quota.data_transfer_bytes,
        storage_gb:   (.synthetic_storage_size / 1e9),
        suspended:    (.compute_time_seconds >= .settings.quota.compute_time_seconds)
      }'
```

Note that Neon **omits zero-valued dimensions** from `settings.quota`, so the
response carries only the two that are set. An absent key means unlimited, not
missing.

`GET /consumption_history/projects` is **not** available on `launch_v3` (it
answers `"This endpoint is not available. It is included with Scale plans and
above."`), so there is no per-hour history to trend from at this plan level. The
project object's running totals for the current period are the signal.

**The quota is per project; the invoice is per organisation.** `settings.quota`
bounds `cold-brook-02833828` and nothing else, so a second project in this
organisation would be entirely outside the cap. The compensating control is
`pullfm_assert_neon_scope` in `infra/lib/credentials.sh`, which refuses to run if
the key can see any project other than `pull-fm-us`.

### The security regression, named

A Neon endpoint is reachable from the public internet by anyone holding the
credential. The Hetzner Postgres node had no public IPv4 at all. `allowed_ips` is
the fix and requires a Scale plan; until then the credential is not the primary
control, it is the only one.

Registered as **`PULLFM-RISK-007`**, expiring 2026-10-27, with the paid-plan
upgrade as the retirement condition. The least-privilege `pullfm_app` role is the
main compensating control: it does not narrow who can reach the endpoint, it
narrows what reaching it is worth.

Three further risks come from where the state lives rather than from Neon:

| Risk              | What                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULLFM-RISK-008` | The database password is plaintext in state, and R2 cannot version objects                                                                                                                                                                                                                                                                                      |
| `PULLFM-RISK-009` | The state R2 key is account-scoped, so it also reaches the backups bucket                                                                                                                                                                                                                                                                                       |
| `PULLFM-RISK-010` | Retired by the posture change, not by the bucket moving. The residency posture is United States only and R2 has no `us` jurisdiction, so `pull-fm-tfstate` being in the default jurisdiction is now the intended shape rather than a gap. Re-read it in `security/accepted-risks.md` before relying on either reading; that file is not updated by this change. |

## What this configuration does not manage

| Not managed                     | Why                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The schema                      | `packages/db/migrations`, applied by the deploy path through the direct endpoint                                                                                                 |
| The `pullfm_app` role           | A role created through the Neon API is an irrevocable member of `neon_superuser`. `sql/create-app-role.sql`, run per branch                                                      |
| `GRANT`s of any kind            | The provider has eleven resources and no grant primitive (checked in `provider/provider.go`). `sql/grant-app-role.sql`, run per branch                                           |
| The query ceilings              | `ALTER ROLE ... SET` is a catalog write with no provider resource, and it is the only form of the ceiling Neon honours. `sql/set-role-timeouts.sql`, run per branch              |
| The app role's password         | Terraform must not learn it: a value assigned to a variable is rendered into the plan file even when the variable is `sensitive`, and plans get attached to public pull requests |
| Connection strings in 1Password | Copied from `terraform output` by the runbook; Terraform never writes to a vault                                                                                                 |
| Branch resets                   | A control-plane call, not a resource. See the runbook                                                                                                                            |
