# Pull.fm - Infrastructure as Code

> ## STAGING IS APPLIED. PROD IS NOT.
>
> `envs/staging` and `envs/shared` are live as of **2026-07-28** and both plan
> with zero drift. `envs/prod` has never been applied and stays that way until
> Phase 6.
>
> State is still **local**, not in R2. Migrating it is the first task of the
> next infrastructure change; until then a lost laptop means an orphaned
> environment, and that is the single largest operational risk in this
> directory.
>
> **Gate $ is still open.** Billing alerts are not configured on any vendor,
> which means staging was applied ahead of its own precondition. Recorded here
> rather than quietly skipped: a solo operator with an attached card and no
> spend cap is a documented failure mode, and it currently applies.

Terraform for the Pull.fm backend: Hetzner Cloud compute and networking,
Cloudflare DNS and TLS posture, and the Cloudflare R2 bucket that holds the
pgBackRest repository.

---

## Layout

```
infra/terraform/
├── modules/                  reusable, environment-agnostic
│   ├── network/              private network + node subnet
│   ├── firewall/             hcloud_firewall for BFF and Postgres roles
│   ├── compute/              SSH keys, servers, volume, placement group, LB
│   ├── dns/                  Cloudflare A/AAAA records
│   ├── backup-storage/       R2 bucket for pgBackRest
│   └── zone-settings/        zone-wide Cloudflare TLS posture
└── envs/                     thin composition roots, one state file each
    ├── shared/               zone-wide settings (owns them for BOTH envs)
    ├── staging/              built in Phase 0
    └── prod/                 written now, applied in Phase 6
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

| Requirement                     | Notes                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Terraform `~> 1.15`             | Pinned by `required_version`. Native S3 state locking (`use_lockfile`) needs >= 1.10.                               |
| Hetzner Cloud project `pull-fm` | Created by hand. A **separate project** from the personal fleet, so a compromised token has a bounded blast radius. |
| Cloudflare zone `pull.fm`       | Already on the account. See the open decision in `docs/PLAN.md` section 10 about the shared Cloudflare account.     |
| An R2 state bucket              | Created once by hand; see [Remote state](#remote-state).                                                            |
| Tailscale tailnet               | The only path to SSH. See [Ingress posture](#ingress-posture).                                                      |
| Billing alerts                  | Gate $. Blocking.                                                                                                   |

### Environment variables

Credentials are **never** Terraform variables. They are read from the
environment by the providers themselves:

```bash
export HCLOUD_TOKEN="$(op read 'op://MCP/hetzner/pull-fm/API_TOKEN')"
export CLOUDFLARE_API_TOKEN="$(op read 'op://MCP/cloudflare/pull-fm/API_TOKEN')"

# Only needed once the R2 remote state backend is enabled:
export AWS_ACCESS_KEY_ID="$(op read 'op://MCP/r2/pull-fm-tfstate/ACCESS_KEY_ID')"
export AWS_SECRET_ACCESS_KEY="$(op read 'op://MCP/r2/pull-fm-tfstate/SECRET_ACCESS_KEY')"
```

**Why no `token` argument on the provider blocks.** Any value assigned to a
provider argument is rendered into the plan file, even when it comes from a
variable marked `sensitive`. Plan files get uploaded as CI artifacts and
attached to pull requests, and this repository is public. Refusing to accept the
value at all is the only version of this that cannot leak. The provider blocks
in `envs/*/providers.tf` are deliberately empty.

**Token scopes.** The Hetzner token needs Read & Write on the `pull-fm` project
only. The Cloudflare token needs `Zone:DNS:Edit` and `Zone:Zone Settings:Edit`
on `pull.fm`, plus `Account:Workers R2 Storage:Edit`. Do not reuse the personal
fleet's global API key.

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

The `backend "s3"` block in each `envs/*/versions.tf` is **commented out and
carries no hardcoded bucket, endpoint or credential.** R2 is S3-compatible, so
the stock S3 backend drives it.

Bootstrapping is a chicken-and-egg problem: the config that creates the state
bucket cannot store its state in that bucket. Order:

1. Create the state bucket once, by hand:
   ```bash
   wrangler r2 bucket create pull-fm-tfstate --jurisdiction eu
   ```
   Turn on **object versioning**. State is the only artifact in this project that
   cannot be rebuilt from this repository.
2. Create an R2 API token scoped to **Object Read & Write on that bucket only**,
   and record it in 1Password.
3. Copy `backend.hcl.example` to `backend.hcl` (gitignored) and fill in the
   account-specific endpoint.
4. Run the first apply on **local state**, then uncomment the `backend "s3"`
   block and run `terraform init -backend-config=backend.hcl -migrate-state`.

R2 has no DynamoDB equivalent, so locking uses Terraform's native S3 lockfile
(`use_lockfile = true`) rather than `dynamodb_table`. The `skip_*` flags in
`backend.hcl.example` are not optional: they disable AWS-specific preflight
calls that fail against R2 before `init` ever reaches the bucket.

---

## Usage

```bash
cd infra/terraform/envs/staging

cp terraform.tfvars.example terraform.tfvars   # then edit
terraform init                                  # add -backend-config=backend.hcl once enabled
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
to EUR 120.49). The sizing here is 2x `cax21` for BFF and 1x `cax31` for
Postgres, about EUR 47/mo. The same shape on CPX would be roughly 6x that.

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

### Postgres is not publicly reachable, by construction

Three independent mechanisms, because a firewall rule alone is one careless edit
from being wrong:

1. The DB server has **no public IPv4 at all** (`db_public_ipv4_enabled = false`).
   Public IPv6 stays on purely for egress - apt mirrors and the R2 endpoint are
   both dual-stack - which avoids standing up a NAT hop for one machine.
2. The firewall has **no inbound rule for 5432**, and adding one would be
   meaningless anyway: Hetzner Cloud Firewalls filter the public interface only
   and never inspect private-network traffic.
3. `listen_addresses` and `pg_hba.conf` restrict Postgres to the private subnet.
   That is config management's job, not Terraform's, and is asserted by Gate 3.

### Egress is allowlisted

Hetzner allows **all** outbound traffic when a firewall declares no `out` rules,
which means a compromised node can freely scan, mine or exfiltrate. Both
firewalls restrict egress to TCP 80/443/53, UDP 53/123, ICMP, and UDP
1024-65535. That last one is wide on purpose: Tailscale dials peers on ephemeral
ports chosen by the far side, and a narrow rule silently degrades every session
to DERP relay. Set `restrict_egress = false` as the first step when debugging a
suspected egress block, and the first thing to set back.

### `prevent_destroy` on stateful resources

Applied to:

- **`hcloud_server.db`** - the single most expensive mistake available in this
  repo. Gate 4 proves a restore works; it does not make one free (30 minutes of
  downtime plus up to 5 minutes of RPO loss).
- **`hcloud_volume.db_data`** - the Postgres data volume, where enabled.
- **`cloudflare_r2_bucket.backups`** - if compute is destroyed the service is
  down; if this is destroyed the service is _gone_.

The DB server and volume carry a **second, independent lock**: Hetzner-side
`delete_protection` / `rebuild_protection`. The two fail differently and that is
the point. `prevent_destroy` catches a bad plan locally, before anything is
sent. `delete_protection` is enforced by the Hetzner API and catches anything
that bypasses this codebase entirely - the console, the CLI, a stale state file,
a `terraform state rm` followed by an apply.

**Consequence:** `terraform destroy` on staging will fail, by design. Tearing
down staging is a three-step, deliberate act: set `db_delete_protection = false`
and apply, remove the `prevent_destroy` blocks in a reviewed commit, then
destroy. If that feels like too much friction for a staging environment, that is
the friction working.

### `ignore_changes = [image]`

`data.hcloud_image` resolves to whatever the newest matching image is, so a
Hetzner base-image refresh would otherwise appear as a plan that replaces every
node - and Gate 0 asserts zero drift on a clean checkout. Rolling onto a new
image is a deliberate act: bump `image_name`, then
`terraform apply -replace=...` one node at a time. The DB node additionally
ignores `user_data`, because replacing a stateless node to pick up a cloud-init
change is routine and replacing the database to do the same never is.

### Backups

Two layers, and they are not redundant:

- **pgBackRest to R2** is the actual backup strategy: full backups plus WAL
  archive, which is what delivers the RPO <= 5 min and restore <= 30 min that
  Gate 4 measures.
- **Hetzner automatic backups** are enabled on the **DB node only**
  (`enable_db_backups = true`, about 20 percent of the server price, roughly EUR
  3.20/mo on a `cax31`). This is not a database backup; it is the cheapest
  available whole-machine rollback when a config change bricks the node. BFF
  nodes have it off: they hold no state and are rebuilt from config management,
  so a snapshot of one is a snapshot of nothing.

**No R2 lifecycle expiry rule is configured, deliberately.** Retention belongs to
pgBackRest (`repo1-retention-full` / `repo1-retention-archive`). An object expiry
rule running underneath it deletes WAL segments the manifest still references and
turns a working repository into an unrestorable one - silently, until the Gate 4
drill.

### Deterministic private addressing

Private IPs are derived from the subnet CIDR (`.5` LB, `.11`+ BFF, `.21` DB)
rather than assigned by DHCP. `pg_hba.conf`, PgBouncer's host list and Nomad's
`retry_join` all reference these addresses; DHCP would turn every node rebuild
into a config change across three other files.

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

| Not managed                                | Why                                                                                                                                                                                                        | Where it lives                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **R2 access key pair** for pgBackRest      | The Cloudflare provider can mint an account API token, but the resulting secret is written to state in plaintext. A backup credential is the one credential that must survive the loss of everything else. | Created by hand, stored in 1Password, injected as a Nomad variable |
| **R2 access key pair** for Terraform state | Same reason, plus circularity.                                                                                                                                                                             | 1Password, exported as `AWS_*` before `init`                       |
| **KEK** for the per-user token vault       | 256-bit app key, escrowed in two places (`docs/PLAN.md` section 5). Losing it makes every user's tokens permanent ciphertext.                                                                              | 1Password + offline escrow, injected as a Nomad variable           |
| **WorkOS credentials**                     | Application secrets, not infrastructure.                                                                                                                                                                   | 1Password -> Nomad variables                                       |
| **Cloudflare Origin CA certificates**      | Issuing them through Terraform puts the private key in state.                                                                                                                                              | Generated per node, delivered by config management                 |
| **TXT records** for domain verification    | Issued out of band by whoever runs the verification; the `dns` module rejects them so the two never fight.                                                                                                 | Cloudflare dashboard                                               |

---

## What this configuration does _not_ cover

Not gaps to fill silently - other tracks own them:

- **Nomad, Postgres, PgBouncer, Redis and the application** are config
  management, not Terraform. Terraform stops at "a booted node with a stable
  private address, an attached firewall, and a mounted volume".
- **Cloudflare WAF rules, rate limiting and the maintenance worker** belong with
  the security track (`security/`).
- **Load-test infrastructure** belongs with the load track (`load/`).
- **Grafana Cloud and the external uptime checker** are deliberately not
  self-hosted (`docs/PLAN.md` section 9).

---

## Verification status

Run from a clean checkout on `darwin_arm64`, Terraform v1.15.8:

| Check                                             | Result                                     |
| ------------------------------------------------- | ------------------------------------------ |
| `terraform fmt -recursive -check`                 | pass                                       |
| `terraform validate` (`envs/staging`)             | pass                                       |
| `terraform validate` (`envs/prod`)                | pass                                       |
| `terraform validate` (`envs/shared`)              | pass                                       |
| `trivy config --severity HIGH,CRITICAL`           | 0 misconfigurations across all three roots |
| `semgrep --config=p/terraform --config=p/secrets` | 0 findings                                 |
| `gitleaks dir --config .gitleaks.toml`            | no leaks found                             |
| `terraform plan` (`envs/staging`)                 | **exit 0, no changes** (2026-07-28)        |
| `terraform plan` (`envs/shared`)                  | **exit 0, no changes** (2026-07-28)        |
| `terraform apply` (`envs/prod`)                   | **NOT RUN.** Phase 6.                      |

What the first real applies settled, none of which `validate` could have:

- **CAX is unavailable**, and so is CX, in every EU location. The allowlist now
  admits the `cpx_1_` series; see the validation block in
  `modules/compute/variables.tf`.
- The Cloudflare **global API key** works for every call made here. A scoped
  token was not tested.
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
