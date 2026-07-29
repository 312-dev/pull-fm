# Pull.fm - Neon serverless Postgres

> ## NOT APPLIED. THE PLAN IS CLEAN AND SIGN-OFF IS PENDING.
>
> `terraform plan` has been run against the live Neon control plane and reports
> **4 to import, 2 to add, 1 to change, 0 to destroy**. `terraform apply` has
> not been run and is gated on operator authorisation.
>
> This root **adopts an existing project**. The Neon project, its default
> branch, its database, its owner role and its read-write endpoint were created
> in the Neon console on 2026-07-29. `imports.tf` brings them under management.
> **There must never be a second Neon project.**

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

That exports `NEON_API_KEY` plus the R2 state pair, and nothing else. It reads
the key from 1Password **by item ID**, because the item's title contains
parentheses and an `op://` reference cannot address it by title. It then calls
`pullfm_assert_neon_scope`, which lists projects with the key and refuses to
continue if it can see any project other than `pull-fm`, or any personal project
at all.

`provider "neon" {}` is deliberately empty. A value assigned to a provider
argument is rendered into the plan file even when it comes from a `sensitive`
variable, plan files get attached to pull requests, and this repository is
public.

## Usage

```bash
cd infra/neon
source ../lib/credentials.sh && pullfm_load_credentials neon
cp backend.hcl.example backend.hcl        # gitignored; fill in the R2 endpoint
terraform init -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan                # READ THE PLAN
terraform apply tfplan
```

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
- Object versioning is on, which is right for recovery and does mean an old
  state object still holds an old credential. That is only acceptable because a
  rotated credential is a dead one. See the rotation section of the runbook.
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
"leave it alone". It is set explicitly to the live value, 21600.

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

### Pooled and direct are both exposed, and they are not interchangeable

| Output                  | Host      | Consumer                                     |
| ----------------------- | --------- | -------------------------------------------- |
| `*_database_url_pooled` | `-pooler` | the BFF's connection pool                    |
| `*_database_url_direct` | plain     | `packages/db/scripts/migrate.mjs`, psql, DDL |

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
`delete_protection` equivalent, and protected branches are a paid-plan feature.
So `prevent_destroy` is the only lock, which is a weaker position than the
Hetzner nodes were in and is stated rather than glossed.

### The free plan is a development allowance, not a production one

`org-tiny-leaf-89756764` is on `free_v3`: 0.5 GB storage per project, 100
CU-hours per project per month, 10 branches, and a 6 hour restore window.
Staging-as-a-branch fits comfortably. **Production does not** - 100 CU-hours at
the 0.25 CU floor is 400 hours of activity, and a month is 730. A paid plan is a
Phase 6 prerequisite, and it is what unlocks `allowed_ips`, a longer PITR window
and protected branches. Arithmetic and sources are in the runbook.

### The security regression, named

A Neon endpoint is reachable from the public internet by anyone holding the
credential. The Hetzner Postgres node had no public IPv4 at all. `allowed_ips` is
the fix and requires a Scale plan; until then the credential is not the primary
control, it is the only one. This belongs in `security/accepted-risks.md` with an
owner and an expiry, not only in a comment.

## What this configuration does not manage

| Not managed                         | Why                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| The schema                          | `packages/db/migrations`, applied by the deploy path through the direct endpoint |
| `GRANT`s for a least-privilege role | SQL, not Terraform. `create_app_role` is gated on the matching migration         |
| Connection strings in 1Password     | Copied from `terraform output` by the runbook; Terraform never writes to a vault |
| Branch resets                       | A control-plane call, not a resource. See the runbook                            |
