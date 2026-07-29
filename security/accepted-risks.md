---
# =============================================================================
# Pull.fm - accepted risk register (MACHINE-READABLE SOURCE OF TRUTH)
#
# Gate 8 (docs/PLAN.md §7): "every accepted risk in security/accepted-risks.md
# has an owner and expiry date, and CI fails on an expired entry."
#
# Everything below the closing --- is human commentary. THIS BLOCK is the data.
# Validated by:  node security/scripts/check-accepted-risks.mjs
# Schema, enums, and validation rules: see "Schema" further down this file.
#
# Format is a restricted YAML subset so the validator can run on plain Node 22
# with zero dependencies. Rules: 2-space indent, `key: value` scalars, and
# `- value` scalar lists. No anchors, block scalars, flow collections, or
# multi-line strings. The validator FAILS on anything outside the subset rather
# than guessing, so an unparseable register can never silently pass.
# =============================================================================
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "Cloudflare account shared with the operator's personal fleet"
    status: accepted
    severity: high
    threat_ids:
      - T31
      - T01
    description: "Pull.fm's DNS, WAF, rate limiting, R2 backups, and the maintenance worker live in the same Cloudflare account as the operator's unrelated personal services. A suspension of that account, or a compromise of any token issued from it, takes down Pull.fm and the personal fleet together, and grants an attacker edit rights over the DNS records and origin-pull configuration that Pull.fm's entire edge trust boundary (TB1/TB2) depends on."
    justification: "Separating the account is a multi-day migration touching DNS delegation, R2 buckets, tunnel credentials, and the maintenance worker, on a service with zero users. Doing it now would consume the pre-launch budget for a blast radius that currently contains no production data. docs/PLAN.md open decision 4 records this as an explicit operator choice rather than an oversight, and PLAN.md §10 already states the blast-radius isolation claim is only partially true."
    compensating_controls: "Hardware-key MFA on the Cloudflare account; API tokens scoped to the minimum zone and R2 bucket rather than the Global API Key; Terraform state is the source of truth so a hostile edit is detectable as drift by the Gate 0 zero-drift plan check; R2 backup objects are encrypted by pgBackRest so bucket access alone yields ciphertext."
    owner: "ope@312.dev"
    accepted_on: 2026-07-28
    expires_on: 2026-10-26
    review_notes: "EXAMPLE SEED. Decide at review: separate the account before Gate 6 (prod cutover), or re-accept with a documented recovery procedure for account suspension. Re-accepting a third time should be treated as a signal that the migration is being avoided rather than deferred."
    example: true

  - id: PULLFM-RISK-005
    title: "Cloudflare automation still depends on the account-wide global API key"
    status: retired
    severity: high
    threat_ids:
      - T27
      - T30
    description: "Terraform's Cloudflare provider ran with CLOUDFLARE_API_KEY, the legacy global key. That credential cannot be scoped: it granted full control of every zone on the personal account, plus R2, plus billing, and could not be restricted to pull.fm. It was not isolated by environment either, so the same key served staging and would have served production. The scoped token that existed at the time held read-only DNS and no R2 permission, so terraform plan failed against it with 'failed to make http request' on the r2_bucket."
    justification: "Retired on 2026-07-29, not renewed. While it was open the justification was that the scoped token lacked two permissions it had not been granted, so the global key was the only credential that could apply, with exposure bounded by the key never being committed, never reaching CI, and living only in a local shell resolved from 1Password at call time."
    compensating_controls: "Now structural rather than procedural: infra/lib/credentials.sh refuses to run when CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL are present, so the failure mode where the provider silently prefers the global key over the scoped token cannot recur unnoticed. Both env tokens are also checked at load time against the zones they can actually enumerate, and the Hetzner token against the servers it can see."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-09-12
    review_notes: "CLOSED 2026-07-29 with evidence, not renewed. Permission group bf7481a1826f439697cb59a20b22293e (Workers R2 Storage Write) was added at account scope to both per-environment tokens (staging 70c4836b01fa594b01922103debfe3bd, prod 2bec8e1d09c9f5f3eaf5dbb8c83a4cac) using the global key purely as bootstrap. Proof: terraform plan in envs/staging and envs/shared both report 'No changes' at exit code 0 with CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL absent from the environment entirely, and the staging token enumerates exactly one zone (pull.fm). The superseded 1Password item 'Cloudflare API - fast.fm' held a token that no longer verifies and has been archived. What remains is narrower and is tracked separately as PULLFM-RISK-006."
    example: false

  - id: PULLFM-RISK-006
    title: "Environment Cloudflare tokens hold account-scoped R2 write"
    status: accepted
    severity: medium
    threat_ids:
      - T27
      - T30
    description: "Each per-environment Cloudflare token is zone-scoped for DNS and TLS but holds Workers R2 Storage Write at ACCOUNT scope, because cloudflare_r2_bucket is an account-scoped resource. The consequence is that the staging token can create, modify and delete any R2 bucket on the account, including pull-fm-tfstate (Terraform state) and any future production backup bucket, and the production token can do the same to staging's. R2 write is therefore the one dimension in which staging and production are not isolated from each other, and it reaches the backup repository that Gate 4's restore drill depends on."
    justification: "Cloudflare publishes no narrower permission that covers bucket create and delete. The two bucket-scoped groups (Workers R2 Storage Bucket Item Read and Write, scope com.cloudflare.edge.r2.bucket) grant object operations only, so a token holding them cannot manage the bucket resource itself and terraform plan fails with 'failed to make http request'. The alternatives are worse: taking R2 out of Terraform means the backup bucket stops being described by IaC and Gate 0's zero-drift assertion no longer covers it, and a separate bucket-only token per environment cannot create the bucket in the first place, so it does not remove the account-scoped credential, only adds a second one."
    compensating_controls: "The account holds exactly two R2 buckets, both Pull.fm's, re-confirmed on 2026-07-29 by enumerating both the default and the EU jurisdiction endpoints (pull-fm-tfstate and pull-fm-backups-staging), so the reachable blast radius today is Pull.fm's own data rather than the personal fleet's. Terraform state is a separate credential (pull-fm/infra/R2_TFSTATE) so a revoked environment token does not lock the operator out of state. No workflow in this repository holds either token; both live in 1Password and are resolved per invocation. CORRECTION 2026-07-29: this entry previously claimed object versioning was enabled on the state bucket and that a destructive write was therefore recoverable. It is not enabled and a destructive write is NOT recoverable. See PULLFM-RISK-008 for the evidence."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2027-01-20
    review_notes: "At review, first re-check whether Cloudflare has shipped a bucket-scoped permission group covering bucket create and delete; if it has, split the R2 policy per environment and close this. Otherwise confirm the account still holds no unrelated R2 buckets, since this acceptance rests on that being true, and it is a fact about the account rather than a property the token enforces. Escalate to high before production carries real user backups if nothing has changed. Related: PULLFM-RISK-001 covers the shared account itself."
    example: false

  - id: PULLFM-RISK-003
    title: "KEK escrow has no second holder (bus factor 1)"
    status: accepted
    severity: high
    threat_ids:
      - T30
      - T27
    description: "The 256-bit key encryption key that wraps every per-user data key exists in 1Password and in one offline copy, both controlled by a single person. Loss of both makes every stored ListenBrainz token and Last.fm session key permanently undecryptable, which docs/PLAN.md §5 correctly identifies as unrecoverable. Disclosure of either copy, combined with any database or backup access, collapses the entire envelope-encryption trust boundary (TB3)."
    justification: "Pull.fm is a solo, non-commercial project with no second engineer and no legal entity structure that would make a custodial escrow meaningful. A shared-secret scheme (for example Shamir splitting across trusted parties) adds a recovery path but also adds N new holders to the disclosure surface, and there is no realistic candidate set today. PLAN.md §10 already names bus factor 1 as a known, accepted property of the whole project rather than a property of this key alone."
    compensating_controls: "Two independent escrows (1Password vault plus an offline copy held separately from the laptop); printed 1Password Emergency Kit and a nominated account recovery contact per PLAN.md §10; kek_id column present from day one so a suspected disclosure can be answered by rotation rather than by mass re-authorisation; hardware-key MFA on the 1Password account."
    owner: "ope@312.dev"
    accepted_on: 2026-07-28
    expires_on: 2026-10-15
    review_notes: "EXAMPLE SEED. At review, confirm both escrow copies still exist and are readable (an untested escrow is not an escrow), and confirm the KEK rotation runbook has been rehearsed at least once. If the rotation drill has not happened, this risk should be re-rated critical, because rotation is the only incident response available for a suspected KEK disclosure."
    example: true

  - id: PULLFM-RISK-004
    title: "DAST active scanning runs nightly against staging, not on every pull request"
    status: accepted
    severity: low
    threat_ids:
      - T05
      - T15
    description: "Pull requests get only the ZAP passive baseline scan (security/zap/plans/baseline.yaml). The active scan, which is what actually exercises injection, SSRF, and traversal payloads, runs on a nightly schedule against api-staging.pull.fm. A vulnerability introduced by a pull request is therefore detectable up to roughly 24 hours after merge rather than before it."
    justification: "An active scan against a full staging deployment takes tens of minutes and needs a deployed environment, which does not exist during a pull request check. Running it per-PR would either require an ephemeral environment per branch (disproportionate for a solo project) or point the active scan at shared staging from concurrent PRs, which produces unattributable alerts and mutates shared state. The passive baseline still runs per-PR and catches the misconfiguration and information-disclosure classes; SAST (Semgrep, including project-specific injection and BOLA rules) runs per-PR and covers the injection classes statically."
    compensating_controls: "Per-PR Semgrep with p/owasp-top-ten plus the project rules in .semgrep/pullfm.yml; per-PR ZAP passive baseline; the BOLA suite (Gate 3) runs per-PR and is the primary authorization control rather than DAST; main is protected so nothing reaches production without passing the nightly active scan first."
    owner: "ope@312.dev"
    accepted_on: 2026-07-28
    expires_on: 2026-10-31
    review_notes: "EXAMPLE SEED. Revisit if per-branch ephemeral environments become cheap, or if the nightly scan ever finds something the per-PR Semgrep rules should have caught, which would be evidence that the static-versus-dynamic split is not holding."
    example: true

  - id: PULLFM-RISK-007
    title: "Production Postgres is reachable from the public internet"
    status: accepted
    severity: high
    threat_ids:
      - T27
      - T09
      - T08
    description: "Migrating the database to Neon moved it from a Hetzner node with no public IPv4, on a private network, behind a firewall with no inbound 5432 rule, onto an endpoint that accepts connections from any address on the internet. Three independent network controls became zero. Anyone holding the connection string can reach the database directly from anywhere, so the credential is no longer the primary control, it is the only one. The practical consequence is that every credential-disclosure path in the threat model gets shorter: a supply-chain package reading process.env (T27), a leaked backup or dump, or a rendered bff.env on a decommissioned node now yields data access immediately rather than data access conditional on already having network position inside the private network."
    justification: "Neon IP allowlisting (allowed_ips) first appears on the Scale plan. For an always-on 0.25 CU compute that is roughly 41 USD a month at the Scale rate of 0.222 USD per CU-hour against roughly 19 USD at the Launch rate of 0.106, before the difference in plan fees, so buying the control today means paying Scale prices for a service with no users in order to allowlist egress addresses that will change when the application nodes are rebuilt. The alternative of staying on Hetzner was rejected for reasons recorded in docs/runbooks/neon-migration.md, chiefly that branch-based staging and instant restore fix Gate 4 problems that the private network never addressed. Accepting a wider network surface in exchange for a materially better recovery story is the trade being made, and it is a trade rather than an oversight."
    compensating_controls: "The application no longer connects as the database owner. A dedicated pullfm_app role created by infra/neon/sql/create-app-role.sql holds SELECT, INSERT, UPDATE and DELETE on application tables plus USAGE on sequences, and is verified by infra/neon/sql/verify-app-role.sql to be unable to DROP, ALTER, CREATE, TRUNCATE, read pg_authid, or SET ROLE to any administrative role, so a leaked runtime credential reaches data but not schema. TLS is mandatory: Neon terminates TLS at its proxy and refuses plaintext, and every connection string carries sslmode=require explicitly rather than relying on a driver default. Authentication is SCRAM-SHA-256. Per-user secrets in the database are envelope-encrypted under a KEK held outside it, so read access yields ciphertext for the highest-value column family. Owner and application credentials are separate and rotate independently. Statement and idle-in-transaction timeouts are set on the application role so a stolen credential cannot pin pooled connections indefinitely."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-10-27
    review_notes: "Owner is Grayson Adams; ope@312.dev is the operator address the register keys on. RETIREMENT CONDITION, concrete: allowed_ips is populated with the app_egress_ipv4 outputs of the environment roots and a terraform plan confirms it applied. That requires the Scale plan, so this risk is coupled to the Phase 6 paid-plan decision and should be re-argued at the same meeting rather than separately. At review, check three things. First, whether Neon has moved IP allowlisting to a cheaper tier, since the pricing is the entire justification and it is the vendor variable most likely to change. Second, whether production has begun holding real user data, because this severity assumes it has not; escalate to critical if it has and the allowlist is still absent. Third, whether the verify-app-role.sql assertions still pass on every branch, since the least-privilege role is the compensating control doing the most work here and a branch reset can silently predate it."
    example: false

  - id: PULLFM-RISK-008
    title: "Neon role passwords are stored in Terraform state in plaintext"
    status: accepted
    severity: high
    threat_ids:
      - T26
      - T27
      - T09
    description: "Neon returns role passwords through its API, and the kislerdm/neon provider stores them. neon_role.password is a computed, sensitive attribute that provider/resource_role.go populates on every read, calling GetProjectBranchRolePassword whenever the role listing omits it, so the value lands in state on refresh and not only on create. neon_project.connection_uri and connection_uri_pooler carry the same password inline. No provider setting prevents this and none can: marking the outputs sensitive keeps the value out of plan output and CI logs, and does nothing about the state file. The effect is that the Cloudflare R2 bucket pull-fm-tfstate is the trust boundary for the production database owner credential, which is the identity that can DROP any table and ALTER any schema in the application database."
    justification: "The alternatives are all worse or unavailable. Removing the owner role from Terraform would mean the production database role is not described by infrastructure as code, which defeats the Gate 0 zero-drift assertion and moves the credential from one store to another rather than removing it. Encrypting state at rest with a customer-managed key is not supported by the S3 backend against R2. Using a different Terraform provider does not help, because the plaintext arrives from the Neon API rather than from the provider's choices. The exposure is therefore accepted and the boundary is hardened instead, which is the honest shape of the problem: the credential has to live somewhere, and a private versioned object store guarded by a separate credential is a defensible somewhere."
    compensating_controls: "Verified on 2026-07-29 rather than assumed. The bucket is private: the R2 managed r2.dev public domain reports enabled false, there are zero custom domains attached, no CORS configuration exists, and anonymous requests to the S3 endpoint are refused. The state credential is a separate R2 access key pair (1Password pull-fm/infra/R2_TFSTATE) held apart from the per-environment Cloudflare tokens, so state stays readable when an environment credential is revoked mid-incident. The credential never enters CI: no workflow in the repository holds it. The application no longer uses this credential at runtime, because the BFF authenticates as the least-privilege pullfm_app role whose password is not in state at all, having been created by SQL rather than through the Neon API. Rotation is a documented one-minute procedure. THE VERSIONING CONTROL DOES NOT EXIST DESPITE BEING DOCUMENTED: see review notes."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-10-27
    review_notes: "Owner is Grayson Adams. FINDING THAT MUST BE FIXED BEFORE THIS IS RENEWED: object versioning is NOT enabled on pull-fm-tfstate, contradicting infra/terraform/README.md, infra/neon/README.md and neon-migration.md sections 6 and 7.1, all of which state that it is on and one of which makes it the rollback procedure for a bad apply. Two independent probes agree: GetBucketVersioning returns an empty configuration at exit 0, which in S3 semantics means never enabled, and head-object on the live state object returns no VersionId. A third cross-check was unavailable because R2 does not implement ListObjectVersions. Consequence: a corrupted or truncated state write is unrecoverable and the documented rollback path does not work. Enabling it is a dashboard toggle and was NOT performed here because bucket configuration was out of scope for this change. Second finding: the R2_TFSTATE key pair is account-scoped rather than bucket-scoped, confirmed by using it to list objects in pull-fm-backups-staging in the EU jurisdiction, so the state credential also reaches the backup bucket and the isolation claim is narrower than it reads. Third finding, lower severity: pull-fm-tfstate is NOT in the EU jurisdiction, although infra/terraform/README.md documents creating it with --jurisdiction eu and every backend.hcl.example points at the .eu. endpoint while the live backend.hcl uses the non-EU one; the backups bucket is correctly EU. RETIREMENT CONDITION: this risk is retired only when the owner password is no longer in state, which realistically means Neon shipping a way to create a role without returning its password, or the owner role leaving Terraform management. Neither is likely inside one window, so expect to renew and to tighten the boundary instead. At review, re-run the four probes above and confirm each compensating control still holds rather than assuming it does."
    example: false
---

# Accepted risk register

> **The block above is the register.** Everything below is documentation of the schema and the
> process. If the two ever disagree, the block above wins, because it is what CI reads.

## What this file is for

Gate 8 requires that every consciously accepted security risk carries an owner and an expiry date,
and that CI fails when one expires. The point is not the paperwork. The point is that a solo
operator's "I will deal with that later" has no natural expiry, and a public repository makes
undocumented deferrals look like ignorance rather than judgement. An entry here says: we looked at
this, we know what it costs, we chose the exposure, and here is the date on which that choice stops
being valid without a fresh decision.

An expired entry is not a vulnerability. It is a **decision that has gone stale**, which is why the
failure mode is a red build rather than an alert.

## How it is enforced

```bash
node security/scripts/check-accepted-risks.mjs          # exit 0 = every entry valid and unexpired
node security/scripts/check-accepted-risks.mjs --json   # machine-readable findings
```

The validator exits non-zero when any entry is expired **or malformed**. Malformed matters as much
as expired: an entry that fails to parse, is missing an owner, or has an expiry 40 years out would
otherwise be an easy way to make the gate pass while defeating its purpose. See
[`README.md`](README.md) for how it is wired into CI.

## Schema

One entry per accepted risk. All fields are required.

| Field                   | Type              | Rule                                                                                                               |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                    | string            | `PULLFM-RISK-NNN`, three digits, unique across the register. Never reused, even after retirement.                  |
| `title`                 | string            | One line, 10 to 120 characters. Names the exposure, not the fix.                                                   |
| `status`                | enum              | `accepted` (subject to expiry) or `retired` (closed, exempt from expiry, kept for history).                        |
| `severity`              | enum              | `critical`, `high`, `medium`, `low`. Drives the maximum acceptance window, see below.                              |
| `threat_ids`            | list of strings   | At least one. References a threat ID from [`THREAT-MODEL.md`](THREAT-MODEL.md) §4, for example `T31`.              |
| `description`           | string            | >= 80 characters. What is exposed and how an attacker would reach it. Not "we did not do X".                       |
| `justification`         | string            | >= 80 characters. Why accepting beats fixing **right now**. "No time" is not a justification; opportunity cost is. |
| `compensating_controls` | string            | >= 40 characters. What reduces the likelihood or blast radius today. `"none"` is permitted but must be literal.    |
| `owner`                 | string            | An email address or a `@handle`. The person who must make the renew-or-fix call.                                   |
| `accepted_on`           | date `YYYY-MM-DD` | Must be a real calendar date, not in the future.                                                                   |
| `expires_on`            | date `YYYY-MM-DD` | Must be after `accepted_on`, and within the severity's maximum window.                                             |
| `review_notes`          | string            | >= 20 characters. What the reviewer must check to decide renew, escalate, or close.                                |
| `example`               | boolean           | `true` marks a seeded template entry. Purely informational; the validator treats it like any other entry.          |

### Maximum acceptance window by severity

| Severity   | Maximum days from `accepted_on` to `expires_on` |
| ---------- | ----------------------------------------------- |
| `critical` | 30                                              |
| `high`     | 90                                              |
| `medium`   | 180                                             |
| `low`      | 366                                             |

Without this rule the expiry field is trivially defeated by writing `2099-01-01`, and the gate
becomes a formality. Scaling the ceiling by severity means a critical acceptance has to be
re-argued monthly, which is roughly the point at which fixing it becomes cheaper than renewing it.

### Why YAML frontmatter rather than a table or a separate data file

Three formats were viable. The trade-offs, since the choice was explicitly left open:

- **A markdown table** keeps everything in one readable artifact and needs no parser, but
  `justification` and `compensating_controls` are the fields that make an entry honest, and both
  are paragraphs. Forcing paragraphs into table cells produces either unreadable rows or truncated
  reasoning, and pipe characters inside prose become an escaping hazard for the parser.
- **A separate `accepted-risks.yaml`** is the cleanest to parse, but it splits the register from
  its explanation. In practice the data file gets updated and the prose rots, which is the exact
  failure this gate exists to prevent.
- **YAML frontmatter (chosen)** keeps a single file that is both the data and the document. The
  register is unambiguously machine-readable, GitHub renders the prose, and the frontmatter
  convention already signals "this block is structured data" to any reader.

The cost of the choice is that the validator needs a YAML parser, and the constraint is zero
dependencies on plain Node 22. Rather than take a dependency or hand-roll a general YAML parser
(the interesting failure mode being a parser that silently mis-reads a valid document), the file is
restricted to the documented subset above and the validator **rejects anything outside it**. A
register that cannot be parsed exactly fails the build. That is strictly safer than a lenient
parser, and the subset is comfortably expressive enough for this schema.

## Lifecycle

1. **Add.** Open a pull request adding an entry. The description and justification are written for a
   future reader who has forgotten the context, because that reader is the author in three months.
2. **Renew.** Before expiry, edit `expires_on` and append to `review_notes` explaining what changed.
   A renewal with no new reasoning is a signal, not a formality.
3. **Close.** Fix the underlying issue, set `status: retired`, and leave the entry in place. The
   history of what was accepted and for how long is evidence, and deleting it destroys the audit
   trail this register exists to create.
4. **Escalate.** If a renewal is being written for the third time, raise the severity. Repeated
   deferral is itself evidence that the original severity was underestimated or the fix is being
   avoided.

## Current entries

Three of the entries below are **seeded examples**, marked `example: true`. Each describes a
condition that is genuinely true of this repository today, so they are usable as-is, but the owner
and the dates need operator confirmation before they should be treated as real accepted risks
rather than templates. `PULLFM-RISK-006` is not an example: it is a live acceptance created when
`PULLFM-RISK-005` was closed.

| ID              | Title                                                | Severity | Expires    |
| --------------- | ---------------------------------------------------- | -------- | ---------- |
| PULLFM-RISK-001 | Shared Cloudflare account                            | high     | 2026-10-26 |
| PULLFM-RISK-006 | Env Cloudflare tokens hold account-scoped R2 write   | medium   | 2027-01-20 |
| PULLFM-RISK-003 | KEK escrow has no second holder                      | high     | 2026-10-15 |
| PULLFM-RISK-004 | DAST active scan is nightly, not per-pull-request    | low      | 2026-10-31 |
| PULLFM-RISK-007 | Production Postgres reachable from the internet      | high     | 2026-10-27 |
| PULLFM-RISK-008 | Neon role passwords are plaintext in Terraform state | high     | 2026-10-27 |

`PULLFM-RISK-007` and `PULLFM-RISK-008` were both created by the Neon migration
and neither is an example. They are the two halves of the same change: moving
the database to a managed vendor removed the network control (007) and put the
production database credential into an object store (008). Read them together,
because the compensating control for one is load-bearing for the other. The
least-privilege `pullfm_app` role narrows 007, and it also means the credential
the application holds is not the credential sitting in Terraform state.

**`PULLFM-RISK-008` carries an unfixed finding rather than only an acceptance.**
Object versioning on `pull-fm-tfstate` is documented in three places as being
enabled and is not. That was found by probing the bucket rather than by reading
the documentation, the documented rollback procedure for a bad apply depends on
it, and turning it on is a dashboard toggle. It is recorded rather than fixed
because bucket configuration was out of scope for the change that found it.

### Retired

`PULLFM-RISK-002` (CI security tooling not version-pinned) was **closed on 2026-07-28**, not
renewed. It recorded that Gate 8's own tooling did not satisfy Gate 8's own wording, which is
exactly what a register is for and why it carried the shortest expiry.

The fix was the mechanical one its review notes described: every `uses:` reference in
`.github/workflows/` is now pinned to a commit SHA with the version in a trailing comment, and
the Semgrep container is pinned to `1.171.0` rather than `latest`. A tag can be repointed by
whoever controls the upstream namespace; a SHA cannot.

A CI lint rejecting any unpinned `uses:` reference guards against regression, so the risk cannot
silently return.

`PULLFM-RISK-005` (Cloudflare automation depends on the global API key) was **closed on
2026-07-29**, one day after it was opened, and it is worth saying why it took a day rather than
the six weeks its expiry allowed.

The register entry claimed the scoped token needed `Zone -> DNS -> Edit` and
`Workers R2 Storage -> Edit`. The first half was already true of the replacement tokens. The
second half was the whole blocker, and the reason it looked like something else is that
Cloudflare answers a missing account-scoped permission with `failed to make http request` - an
error that reads like a network fault, not an authorization one. Adding permission group
`bf7481a1826f439697cb59a20b22293e` to both per-environment tokens, using the global key purely to
make that one edit, was the entire fix.

**The evidence that closed it** is `terraform plan` reporting `No changes` at exit code 0 in both
`envs/staging` and `envs/shared` with `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` absent from the
environment entirely, plus the staging token enumerating exactly one zone when asked for all of
them.

**What did not close** is recorded as `PULLFM-RISK-006` rather than folded into the closure
notice. The R2 permission is account-scoped because Cloudflare offers nothing narrower for bucket
lifecycle, so staging and production are still not isolated from each other on that one axis.
Retiring 005 without opening 006 would have turned a real residual into a green tick.

The lasting control is not the token edit, which a future shell profile could undo by exporting
the global key again. It is that `infra/lib/credentials.sh` **refuses to run** when
`CLOUDFLARE_API_KEY` or `CLOUDFLARE_EMAIL` are set. The Cloudflare provider prefers the global key
when both are present, so without that guard the regression would be silent and every artifact in
the repository would still look correct.
