# Pull.fm - Infrastructure as Code

> ## STAGING IS TORN DOWN. PROD HAS NEVER BEEN APPLIED.
>
> As of **2026-07-29** staging is deliberately **DOWN** and the Hetzner run rate
> is **EUR 0.00/mo**. It is ephemeral by design (`docs/PLAN.md` section 10c);
> bring it up for a gate run with `./infra/staging-env.sh up` and take it back
> down afterwards. `envs/shared` (zone TLS posture) stays applied because a zone
> setting has no hourly cost. `envs/prod` stays unapplied until Phase 6.
>
> **The rebuild does not come back healthy, and that is a real gap, not a
> teething problem.** Terraform recreates the whole environment in 45 seconds,
> but the node then serves nothing: config management is a manual SSH runbook,
> so `/healthz` returns Cloudflare 525 and both load balancer targets report
> unhealthy. Measured by doing it. See
> [`../staging/README.md`](../staging/README.md).
>
> **`envs/staging` and `infra/neon` state lives in R2** (`pull-fm-tfstate`)
> since 2026-07-29.
> Backend wiring is per-root `backend.hcl` (gitignored); the credentials come
> from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
>
> **`envs/shared` and `envs/prod` still have the backend block commented out, so
> their state is local.** That matters most for `shared`, which is the root that
> is actually applied: losing this laptop orphans the zone TLS posture. Migrating
> both is the next infrastructure task.
>
> **Applies run on a per-environment scoped Cloudflare token.** The account-wide
> global API key is bootstrap-only and `infra/lib/credentials.sh` refuses to run
> when it is present. See [Environment variables](#environment-variables).
>
> **Gate $ is partially closed.** Cloudflare billing alerts are armed and
> machine-verified by `make cost`; the Hetzner cost limit has no API and remains
> a manual console step. Full detail and the click path:
> [`docs/RUNBOOK-COST.md`](../../docs/RUNBOOK-COST.md).

Terraform for the Pull.fm backend: Hetzner Cloud compute and networking,
Cloudflare DNS and TLS posture, and the Cloudflare R2 bucket that holds
out-of-band database dumps.

> **THE DATABASE IS NOT HERE ANY MORE.** Postgres moved to Neon on 2026-07-29
> and is managed by a fourth root at [`infra/neon/`](../neon/), because one Neon
> project holds both environments (`main` for production, a `staging` branch
> under it) and therefore needs exactly one Terraform owner. What is left on
> Hetzner is the BFF tier and a small shared-Redis node. See
> [`docs/PLAN.md` section 1c](../../docs/PLAN.md) and
> [`docs/runbooks/neon-migration.md`](../../docs/runbooks/neon-migration.md).

---

## Layout

```
infra/terraform/
├── modules/                  reusable, environment-agnostic
│   ├── network/              private network + node subnet
│   ├── firewall/             hcloud_firewall for BFF and cache roles
│   ├── compute/              SSH keys, servers, placement group, LB
│   ├── dns/                  Cloudflare A/AAAA records
│   ├── backup-storage/       R2 bucket for out-of-band database dumps
│   └── zone-settings/        zone-wide Cloudflare TLS posture
└── envs/                     thin composition roots, one state file each
    ├── shared/               zone-wide settings (owns them for BOTH envs)
    ├── staging/              built in Phase 0
    └── prod/                 written now, applied in Phase 6

infra/neon/                   the database. A fourth root, one Neon project,
                              BOTH environments as branches of it.
```

`envs/staging` and `envs/prod` call an **identical module graph**. The only
differences between them are variable values. Promoting a change to prod is
`terraform apply` in a second directory, never a copy-paste. If a difference
between environments cannot be expressed as a variable, the fix belongs in the
module.

### Why `envs/shared` exists

TLS mode, minimum TLS version and HSTS are properties of the **pull.fm zone**,
not of an environment. If both `staging` and `prod` managed them, every apply of
one would silently revert the other, and the last apply would win. Splitting
them into a third root gives each setting exactly one owner. Per-environment DNS
records stay in the environment roots.

---

## Prerequisites

| Requirement                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform `~> 1.15`             | Pinned by `required_version`. Native S3 state locking (`use_lockfile`) needs >= 1.10.                                                                                                                                                                                                                                                                                                                 |
| Hetzner Cloud project `pull-fm` | Created by hand. A **separate project** from the personal fleet, so a compromised token has a bounded blast radius.                                                                                                                                                                                                                                                                                   |
| Cloudflare zone `pull.fm`       | Already on the account. See the open decision in `docs/PLAN.md` section 10 about the shared Cloudflare account.                                                                                                                                                                                                                                                                                       |
| An R2 state bucket              | Created once by hand; see [Remote state](#remote-state).                                                                                                                                                                                                                                                                                                                                              |
| A Neon project                  | `cold-brook-02833828` (`pull-fm-us`, `aws-us-east-1`), created by hand and adopted by [`infra/neon`](../neon/) via import blocks. The EU project `steep-frost-83698289` was the cutover rollback and **was deleted on 2026-07-29**; there is one project again. That root now adopts all six of its resources and creates nothing, and it needs a gitignored `terraform.tfvars` for the branch and endpoint ids. See the head of [`infra/neon/README.md`](../neon/README.md). |
| Tailscale tailnet               | The only path to SSH. See [Ingress posture](#ingress-posture).                                                                                                                                                                                                                                                                                                                                        |
| Billing alerts                  | Gate $. Cloudflare armed, Hetzner manual. [`docs/RUNBOOK-COST.md`](../../docs/RUNBOOK-COST.md).                                                                                                                                                                                                                                                                                                       |

### Environment variables

Credentials are **never** Terraform variables. They are read from the
environment by the providers themselves, and loaded from 1Password by one
helper rather than by hand:

```bash
source infra/lib/credentials.sh
pullfm_load_credentials staging     # or prod, or shared
```

That exports exactly four values:

| Variable                | Source (1Password vault `MCP`)       | Consumed by           |
| ----------------------- | ------------------------------------ | --------------------- |
| `HCLOUD_TOKEN`          | `Hetzner pull.fm API Token`          | `hcloud` provider     |
| `CLOUDFLARE_API_TOKEN`  | `pull-fm/<env>/CLOUDFLARE_API_TOKEN` | `cloudflare` provider |
| `AWS_ACCESS_KEY_ID`     | `pull-fm/infra/R2_TFSTATE`           | S3 state backend      |
| `AWS_SECRET_ACCESS_KEY` | `pull-fm/infra/R2_TFSTATE`           | S3 state backend      |

Note the item titles contain `/`, which is also the `op://` secret-reference
separator, so `op read` cannot address them. The helper uses
`op item get <title> --fields label=<field> --reveal` instead.

**`CLOUDFLARE_API_TOKEN` is the documented and only supported auth path.**

**The global API key is bootstrap-only.** `CLOUDFLARE_API_KEY` +
`CLOUDFLARE_EMAIL` are the legacy account-wide credential. The Cloudflare
provider accepts them and **prefers them when both are set**, which means a
stray export in a shell profile silently returns every apply to an unscoped
credential while the code still looks correct. The key exists for exactly one
purpose - minting and editing the scoped tokens - and
`pullfm_load_credentials` **refuses to run** when either variable is present:

```
REFUSING TO RUN: CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL are set.
```

**Why no `token` argument on the provider blocks.** Any value assigned to a
provider argument is rendered into the plan file, even when it comes from a
variable marked `sensitive`. Plan files get uploaded as CI artifacts and
attached to pull requests, and this repository is public. Refusing to accept the
value at all is the only version of this that cannot leak. The provider blocks
in `envs/*/providers.tf` are deliberately empty.

**Token scopes.** The Hetzner token needs Read & Write on the `pull-fm` project
only. Each Cloudflare environment token holds:

| Resource       | Permission groups                                                     |
| -------------- | --------------------------------------------------------------------- |
| zone `pull.fm` | DNS Write, Zone Read, Zone Settings Write, SSL and Certificates Write |
| account        | Workers R2 Storage Write                                              |

The account-level R2 grant is the one place the scope is wider than a zone, and
it is not avoidable: R2 buckets are account-scoped resources, and Cloudflare
publishes no zone-level or per-bucket permission group covering bucket
create/delete (`Workers R2 Storage Bucket Item Read/Write` scope to objects,
not to buckets). Without it, `terraform plan` fails with `failed to make http
request` on `cloudflare_r2_bucket`. The residual exposure is every R2 bucket on
the account; today that set is exactly the two Pull.fm buckets, but that is a
fact about the account, not a property enforced by the token.

**The helper verifies scope rather than trusting it.** Before any apply,
`pullfm_assert_cloudflare_scope` lists zones with the token and aborts if
anything other than `pull.fm` comes back, and `pullfm_assert_hetzner_project`
aborts if the Hetzner token can see the operator's personal fleet.

### Non-secret variables

Two values must be supplied per root, via `terraform.tfvars` (gitignored) or
`TF_VAR_*`:

- `cloudflare_account_id`
- `cloudflare_zone_id`

Both are public identifiers shown in the Cloudflare dashboard, not credentials.
Copy `terraform.tfvars.example` in the relevant `envs/` directory and fill in the
placeholders. **`*.tfvars` is gitignored and `*.tfvars.example` contains only
placeholders.** There must never be a secret in either.

---

## Remote state

**Enabled since 2026-07-29.** The `backend "s3"` block in `envs/*/versions.tf`
carries only the state key; the bucket, endpoint and credentials are supplied at
`init` time and **none of them are hardcoded**. R2 is S3-compatible, so the
stock S3 backend drives it.

Bootstrapping was a chicken-and-egg problem: the config that creates the state
bucket cannot store its state in that bucket. The order that was followed, and
that a fresh environment would repeat:

1. Create the state bucket once, by hand:

   ```bash
   wrangler r2 bucket create pull-fm-tfstate
   ```

   **Do not add `--jurisdiction eu` here, and do not believe an older revision of
   this file that did.** The live `pull-fm-tfstate` is not in the EU
   jurisdiction, verified on 2026-07-29 by enumerating both endpoints. A
   jurisdiction endpoint only lists buckets created in that jurisdiction, so the
   two forms are not interchangeable and the wrong one fails at `terraform init`
   rather than falling back. As of 2026-07-29 the default endpoint returns
   `pull-fm-tfstate`, `pull-fm-backups-staging-us`, `pull-fm-ledger-staging-us`
   and `pull-fm-ledger-drill-us`, and **the EU endpoint returns nothing** - the
   three EU buckets that used to be there were deleted with the rest of the EU
   estate.

   `PULLFM-RISK-010` recorded the open decision about recreating the state
   bucket in the EU jurisdiction. **The US cutover answers it from the other
   direction**: the replacement data buckets are default jurisdiction with an
   ENAM location hint, because R2 has no `us` jurisdiction to pin to, so state
   and data share one endpoint again and the `.eu.` form is now the odd one out.

   **The jurisdiction wiring was finished on 2026-07-29 and this paragraph used
   to describe the half-finished state.** It said `modules/backup-storage` still
   defaults `jurisdiction = "eu"` and `envs/staging` still names the EU backups
   bucket. Both are now done, and neither was a variable edit, because
   `bucket_name` and `jurisdiction` are ForceNew and the bucket carries
   `prevent_destroy`:

   - `envs/staging` `state rm`'d the EU bucket and imported
     `pull-fm-backups-staging-us` (see `envs/staging/imports.tf`).
   - **`modules/backup-storage` no longer has a default for `jurisdiction` at
     all.** It is required, so a call site that omits it fails at plan time
     instead of silently inheriting somebody else's residency decision. Both
     `envs/staging` and `envs/prod` state it explicitly. The reasoning is in that
     module's `variables.tf`.

   `default` is not a claim that objects are in the United States: R2 offers only
   `eu` and `fedramp`, a location hint is a preference, and the control doing the
   work is client-side encryption. `legal/privacy-policy.md` states it that way.

   **There is no object versioning to turn on.** R2 does not implement it.
   Cloudflare's S3 compatibility matrix lists `PutBucketVersioning` and
   `GetBucketVersioning` as unimplemented and does not list `ListObjectVersions`
   at all. State is still the only artifact in this project that cannot be
   rebuilt from this repository, so it is protected by explicit pre-apply
   snapshots instead:

   ```bash
   infra/lib/tfstate-snapshot.sh snapshot infra/neon      # before every apply
   ```

   That copies the live state to a timestamped key, reads it back, compares
   digests, and exits non-zero if the copy cannot be verified, so a failed
   snapshot stops the apply rather than being discovered during a recovery. See
   the header of that script and `PULLFM-RISK-008`.

2. Create an R2 API token for the state bucket and record it in 1Password as
   `pull-fm/infra/R2_TFSTATE`. Kept separate from the environment tokens on
   purpose: state must stay readable even if an environment credential is
   revoked mid-incident.
3. Copy `backend.hcl.example` to `backend.hcl` (gitignored) and fill in the
   account-specific endpoint.
4. Run the first apply on **local state**, then add the `backend "s3"` block and
   run `terraform init -backend-config=backend.hcl -migrate-state`.

R2 has no DynamoDB equivalent, so locking uses Terraform's native S3 lockfile
(`use_lockfile = true`) rather than `dynamodb_table`. The `skip_*` flags in
`backend.hcl.example` are not optional: they disable AWS-specific preflight
calls that fail against R2 before `init` ever reaches the bucket.

---

## Usage

```bash
cd infra/terraform/envs/staging

source ../../../lib/credentials.sh && pullfm_load_credentials staging

cp terraform.tfvars.example terraform.tfvars   # then edit
terraform init -backend-config=backend.hcl
terraform fmt -recursive -check
terraform validate
terraform plan -out=tfplan                      # READ THE PLAN
terraform apply tfplan
```

Order of first build:

1. `envs/shared` - zone TLS posture. Leave `ssl_mode = "full"` until origin
   certificates exist.
2. `envs/staging` - network, firewalls, compute, LB, DNS, R2.
3. Install Cloudflare Origin CA certificates on the BFF nodes, then flip
   `envs/shared` to `ssl_mode = "strict"`.

To validate without any credentials at all (this is what CI does, and it
provisions nothing):

```bash
terraform init -backend=false
terraform validate
```

`.terraform.lock.hcl` is committed and locked for `linux_amd64`, `linux_arm64`
and `darwin_arm64`, so CI and a Mac laptop resolve byte-identical providers.
Regenerate with `terraform providers lock -platform=...` after a version bump.

---

## Design decisions worth knowing before reviewing

### CAX (ARM64) only, enforced by a validation block

Hetzner raised **CPX/CCX pricing by 150-210 percent on 2026-06-15** while CAX
rose about 30 percent (`docs/PLAN.md` section 2; the US CPX41 went from EUR 38.99
to EUR 120.49). The sizing here is 2x `cax21` for BFF and 1x `cax11` for
the shared Redis node, about EUR 40/mo. The Postgres node it replaced was a
`cax31`; the workload is now two Redis instances capped at 256 MB and 128 MB, not
a database page cache. The same shape on CPX would be roughly 6x that.

`modules/compute` rejects any `server_type` that does not start with `cax`. That
is a deliberate guardrail, not a typo check: switching families is a cost
decision worth several hundred dollars a year and should require editing the
validation with an explanatory commit.

The consequence is that everything must be ARM64: container images, the Nomad
binary, Postgres extensions. `modules/compute` resolves the base image through
`data.hcloud_image` with `with_architecture = "arm"`, because passing
`"ubuntu-24.04"` straight through picks the x86 build and the server never boots.

### EU-only placement

`location` is validated against `fsn1`, `nbg1`, `hel1`. Pull.fm processes EU
personal data; the GDPR posture in the plan assumes EU-only hosting, and so does
the R2 bucket's `jurisdiction = "eu"`. A US or APAC location would break that
silently.

### Ingress posture

**SSH is Tailscale-only. There is no inbound rule for port 22 in any committed
configuration.** Tailscale arrives as WireGuard-encapsulated UDP, so the only
public rule needed is inbound UDP 41641 for direct peer connections; without it
the tailnet still works but every session relays through DERP. Opening 22 would
add public attack surface while adding no access the operator actually uses.
cloud-init additionally sets `PasswordAuthentication no` and
`PermitRootLogin no`, so the tailnet-side listener is hardened too.

**Break-glass.** That posture has a genuine chicken-and-egg problem: a node
that has never joined the tailnet cannot be reached to install Tailscale on it.
`ssh_allowlist_cidrs` exists for that one case. It defaults to an empty list,
rejects a default route outright, and renders no rule at all when empty, so a
fresh checkout is byte-identical to having no such variable. A single operator
`/32` goes into a local `terraform.tfvars` for the duration of a bootstrap and
comes straight back out.

It was used exactly once, on 2026-07-28, to bootstrap both staging nodes, and
was removed the same session. **Tailscale is not yet installed on the staging
nodes**, so break-glass is currently the only interactive path in. That is
tolerable because the deploy loop is a pull and needs no inbound access at all,
but it is an open item rather than the intended end state.

**Only Cloudflare reaches HTTP.** One caveat a reviewer must know: **Hetzner
Cloud Firewalls cannot be attached to a Load Balancer**, and Hetzner LBs have no
source-IP allowlist of their own. The "Cloudflare ranges only" rule therefore
cannot be enforced at the LB. It is enforced in the three places that are
available:

1. **Origin firewall.** Ports 80 and 443 accept traffic only from the live
   `cloudflare_ip_ranges` data source. A node is unreachable even if DNS is ever
   pointed straight at it, or the LB is bypassed.
2. **PROXY protocol** on the LB services, so the origin sees the true L3 peer and
   can reject anything that is not a Cloudflare edge address. This is also what
   makes the per-IP quotas in `docs/PLAN.md` section 6 meaningful. The origin
   **must** be configured to parse PROXY protocol before
   `enable_proxy_protocol = true` is applied, or every connection fails.
3. **Authenticated Origin Pulls** (mTLS), configured at the Cloudflare layer.

**All DNS records are proxied.** An unproxied record publishes the Hetzner origin
IP in public DNS, which defeats point 1 entirely and hands an attacker a path
around WAF and rate limiting.

**The LB terminates nothing.** Both services are TCP passthrough. Hetzner managed
certificates require the hostname to resolve to the LB, and it resolves to
Cloudflare instead. TLS is terminated at the origin with a Cloudflare Origin CA
certificate, which is what permits SSL mode `strict` end to end.

### Redis is not publicly reachable, by construction

The same three mechanisms that used to protect Postgres, unchanged, because none
of them depended on which daemon was listening:

1. The cache node has **no public IPv4 at all**
   (`cache_public_ipv4_enabled = false`). Public IPv6 stays on purely for egress
   - apt mirrors and the Tailscale coordination server are both dual-stack -
     which avoids standing up a NAT hop for one machine.
2. The firewall has **no inbound rule for 6379 or 6380**, and adding one would be
   meaningless anyway: Hetzner Cloud Firewalls filter the public interface only
   and never inspect private-network traffic.
3. The compose port bindings publish to the private address only, and both
   instances set `requirepass`. That is config management's job, not
   Terraform's.

**The database no longer benefits from any of this.** Neon endpoints are on the
public internet, guarded by a credential. That is the security cost of the
migration and it is recorded in `docs/PLAN.md` section 1c rather than left for a
reviewer to notice.

### Egress is allowlisted

Hetzner allows **all** outbound traffic when a firewall declares no `out` rules,
which means a compromised node can freely scan, mine or exfiltrate. Both
firewalls restrict egress to TCP 80/443/53, UDP 53/123, ICMP, and UDP
1024-65535. That last one is wide on purpose: Tailscale dials peers on ephemeral
ports chosen by the far side, and a narrow rule silently degrades every session
to DERP relay. Set `restrict_egress = false` as the first step when debugging a
suspected egress block, and the first thing to set back.

### `prevent_destroy`, and where it went

It used to guard `hcloud_server.db`, `hcloud_volume.db_data` and
`cloudflare_r2_bucket.backups`. The first two are gone with the database, and so
is the three-step teardown ceremony they imposed on staging.

**It moved rather than disappearing.** `infra/neon` applies `prevent_destroy` to
`neon_project.pullfm`, `neon_database.main`, `neon_role.owner` and
`neon_endpoint.main`, which is where the unrecoverable loss now lives. One thing
got weaker in the move and is worth knowing: the Hetzner nodes carried a
**second, vendor-side lock** (`delete_protection`, enforced by the Hetzner API,
so it also caught a console click or a stale state file). Neon has no equivalent,
and protected branches are a paid-plan feature, so `prevent_destroy` is the only
lock on the database today.

`cloudflare_r2_bucket.backups` keeps its `prevent_destroy`. pgBackRest no longer
writes to it, but a bucket outside the database vendor is exactly where the
out-of-band logical dumps belong.

What remains on Hetzner is `lb_delete_protection` and
`network_delete_protection`, both variable-driven, both true in prod and false in
staging. `cache_delete_protection` defaults to **false** even in the module,
because destroying the cache node costs a cold cache and a reset rate-limit
window rather than data.

### `ignore_changes = [image]`

`data.hcloud_image` resolves to whatever the newest matching image is, so a
Hetzner base-image refresh would otherwise appear as a plan that replaces every
node - and Gate 0 asserts zero drift on a clean checkout. Rolling onto a new
image is a deliberate act: bump `image_name`, then
`terraform apply -replace=...` one node at a time. The DB node additionally
ignores `user_data`, because replacing a stateless node to pick up a cloud-init
change is routine and replacing the database to do the same never is.

### Backups

The database's backups are Neon's now: instant restore from a copy-on-write
history, with the window set by `history_retention_seconds` in `infra/neon` (6
hours on the current plan, which is the Free ceiling). That replaces pgBackRest
entirely and is dramatically faster than the 30 minutes Gate 4 budgets.

Two things this repository still owns:

- **The R2 bucket**, which now holds out-of-band logical dumps rather than a
  pgBackRest repository. It exists because a backup inside the database vendor is
  not a backup against the database vendor, and because a mistake noticed after
  the 6 hour restore window has no other recovery path. The runbook requires a
  dump before any destructive operation for exactly that reason.
- **Hetzner automatic backups are now off everywhere** (`enable_cache_backups`
  and `enable_app_backups` both false). They were on for the DB node because a
  whole-machine snapshot was the cheap rollback for state that could not be
  rebuilt. Neither remaining node holds such state.

**No R2 lifecycle expiry rule is configured, deliberately.** It was previously
because an object expiry rule running underneath pgBackRest deletes WAL segments
the manifest still references. The reason is now simpler and still binding: a
dump taken before a destructive operation must outlive the operation, and an
expiry rule is a good way to discover that it did not.

### Deterministic private addressing

Private IPs are derived from the subnet CIDR (`.5` LB, `.11`+ BFF, `.21` cache)
rather than assigned by DHCP. The BFF's `REDIS_URL` and `REDIS_QUOTA_URL` and
Nomad's `retry_join` all reference these addresses; DHCP would turn every node
rebuild into a config change across three other files. The `.21` slot kept its
address across the Neon migration even though its role changed, because
renumbering would have invalidated every runbook quoting it while changing
nothing about what is reachable.

### Live Cloudflare IP ranges

`data.cloudflare_ip_ranges` is read at plan time rather than pinned to a static
list, so a newly published Cloudflare range does not silently become packet loss
at the origin. The trade is that a genuine upstream change shows up as plan
drift. That is the correct trade: Gate 0's zero-drift assertion runs against a
fresh checkout, and this drift is real and should be applied. The
`cloudflare_allowlist_size` output exists as the canary.

---

## Credentials that Terraform does not manage

Deliberate omissions, each for a reason:

| Not managed                                | Why                                                                                                                                                                                                                                     | Where it lives                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **R2 access key pair** for database dumps  | The Cloudflare provider can mint an account API token, but the resulting secret is written to state in plaintext. A backup credential is the one credential that must survive the loss of everything else.                              | Created by hand, stored in 1Password, injected as a Nomad variable |
| **Neon connection strings**                | Terraform PRODUCES these (as sensitive outputs of `infra/neon`) but does not distribute them. Note that Neon returns role passwords through its API, so they are in that root's state in plaintext and no provider setting prevents it. | Copied from `terraform output` into 1Password by the runbook       |
| **R2 access key pair** for Terraform state | Same reason, plus circularity.                                                                                                                                                                                                          | 1Password, exported as `AWS_*` before `init`                       |
| **KEK** for the per-user token vault       | 256-bit app key, escrowed in two places (`docs/PLAN.md` section 5). Losing it makes every user's tokens permanent ciphertext.                                                                                                           | 1Password + offline escrow, injected as a Nomad variable           |
| **WorkOS credentials**                     | Application secrets, not infrastructure.                                                                                                                                                                                                | 1Password -> Nomad variables                                       |
| **Cloudflare Origin CA certificates**      | Issuing them through Terraform puts the private key in state.                                                                                                                                                                           | Generated per node, delivered by config management                 |
| **TXT records** for domain verification    | Issued out of band by whoever runs the verification; the `dns` module rejects them so the two never fight.                                                                                                                              | Cloudflare dashboard                                               |

---

## What this configuration does _not_ cover

Not gaps to fill silently - other tracks own them:

- **Nomad, Redis and the application** are config management, not Terraform.
  Terraform stops at "a booted node with a stable private address and an attached
  firewall".
- **Postgres** is not config management either any more. It is Neon, and it is
  Terraform, but in [`infra/neon`](../neon/) rather than here.
- **PgBouncer** is neither, in a cloud environment: Neon's pooled endpoint is a
  transaction-mode pooler already. It survives in `docker-compose.dev.yml` so
  local development meets the same connection semantics.
- **Cloudflare WAF rules, rate limiting and the maintenance worker** belong with
  the security track (`security/`).
- **Load-test infrastructure** belongs with the load track (`load/`).
- **Grafana Cloud and the external uptime checker** are deliberately not
  self-hosted (`docs/PLAN.md` section 9).

---

## Verification status

Run from a clean checkout on `darwin_arm64`, Terraform v1.15.8:

| Check                                               | Result                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `terraform fmt -recursive -check`                   | pass                                                                                     |
| `terraform validate` (`envs/staging`)               | pass                                                                                     |
| `terraform validate` (`envs/prod`)                  | pass                                                                                     |
| `terraform validate` (`envs/shared`)                | pass                                                                                     |
| `terraform validate` (`infra/neon`)                 | pass                                                                                     |
| `terraform plan` (`infra/neon`, live control plane) | **4 to import, 2 to add, 1 to change, 0 to destroy** (2026-07-29)                        |
| `terraform apply` (`infra/neon`)                    | **NOT RUN.** Gated on operator sign-off.                                                 |
| `trivy config --severity HIGH,CRITICAL`             | 0 misconfigurations across all three roots                                               |
| `semgrep --config=p/terraform --config=p/secrets`   | 0 findings                                                                               |
| `gitleaks dir --config .gitleaks.toml`              | no leaks found                                                                           |
| `terraform plan` (`envs/staging`)                   | **exit 0, no changes** (2026-07-29), with the global API key absent from the environment |
| `terraform plan` (`envs/shared`)                    | **exit 0, no changes** (2026-07-29), same                                                |
| `terraform destroy` (staging, keep-list)            | **19 destroyed, run rate EUR 0.00/mo** (2026-07-29)                                      |
| `terraform apply` (staging, from nothing)           | **19 created in 45 seconds** (2026-07-29)                                                |
| staging serving after that rebuild                  | **NO.** HTTP 525, both LB targets unhealthy. See `../staging/README.md`.                 |
| `terraform apply` (`envs/prod`)                     | **NOT RUN.** Phase 6.                                                                    |

What the first real applies settled, none of which `validate` could have:

- **CAX is unavailable**, and so is CX, in every EU location. The allowlist now
  admits the `cpx_1_` series; see the validation block in
  `modules/compute/variables.tf`.
- **A keep-list cannot save a dependent.** `terraform destroy -target` destroys
  the targets and everything downstream of them, so the DNS records went with
  the load balancer whose address they publish, no matter that
  `staging-env.sh`'s `KEEP` array named `module.dns`. The header promised
  something the mechanism could not deliver. DNS is now documented as rebuilt by
  `up`, and only the R2 bucket - which depends on nothing - is kept.
- **`delete_protection` defaulted to true everywhere and nothing overrode it.**
  `docs/PLAN.md` section 10c says "Production sets it true; staging false", but
  the env roots never passed the variable at all, so the module defaults applied
  to both. The first teardown failed **halfway**: the app node, firewalls and
  DNS were gone while the database node and load balancer stayed up and kept
  billing, which is the worst of both states. The roots now set it explicitly
  (staging false, prod true), and `staging-env.sh` clears the flag over the
  Hetzner API before destroying, because by the time a targeted destroy reaches
  a protected resource the graph that would flip it is already half gone. A
  documented decision that is not wired to anything is indistinguishable from
  not having made it.
- **A zone-scoped Cloudflare token is not sufficient on its own**, and the way
  it fails is unhelpful. `cloudflare_r2_bucket` is an account-scoped resource,
  so a token holding only zone permissions returns `failed to make http
request` - a transport-shaped error for what is actually an authorization
  problem. Adding `Workers R2 Storage Write` at the account level fixes it. The
  global API key masked this because it holds everything.
- Hetzner **load balancer health checks carry the PROXY protocol header** when
  `proxyprotocol` is enabled on the service. This is not documented by Hetzner
  and is the difference between a working origin and every target being marked
  down; it was settled by observation, with both targets reporting healthy
  against an nginx listener that requires the header.
- **Cloudflare Universal SSL covers one label below the apex and no more.**
  `api.staging.pull.fm` has no edge certificate and never completes a
  handshake. The staging hostnames are therefore `api-staging.pull.fm` and
  `app-staging.pull.fm`; the alternative is Advanced Certificate Manager at
  10 USD/month per zone. Production is unaffected, since `api.pull.fm` is one
  label.
