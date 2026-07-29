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
    compensating_controls: "The account holds exactly two R2 buckets, both Pull.fm's, re-confirmed on 2026-07-29 by enumerating both the default and the EU jurisdiction endpoints (pull-fm-tfstate and pull-fm-backups-staging), so the reachable blast radius today is Pull.fm's own data rather than the personal fleet's. Terraform state is a separate credential (pull-fm/infra/R2_TFSTATE) so a revoked environment token does not lock the operator out of state. No workflow in this repository holds either token; both live in 1Password and are resolved per invocation. CORRECTION 2026-07-29: this entry previously claimed object versioning was enabled on the state bucket and that a destructive write was therefore recoverable. R2 does not support object versioning at all, so that was never a control rather than a control left switched off. Cloudflare's S3 compatibility matrix lists PutBucketVersioning and GetBucketVersioning as unimplemented and omits ListObjectVersions. A destructive write by a holder of either token is recoverable only from the pre-apply snapshots written by infra/lib/tfstate-snapshot.sh, which live in the same bucket under the same credential and therefore do not survive a hostile holder of that credential. See PULLFM-RISK-008."
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
    title: "Database credential is plaintext in Terraform state, on a store that cannot version"
    status: accepted
    severity: high
    threat_ids:
      - T26
      - T27
      - T09
    description: "Neon returns role passwords through its API and the kislerdm/neon provider stores them. neon_role.password is a computed, sensitive attribute that provider/resource_role.go repopulates on every read, calling GetProjectBranchRolePassword whenever the role listing omits it, so the value lands in state on refresh and not only on create. neon_project.connection_uri and connection_uri_pooler carry the same password inline. No provider setting prevents this and none can: marking outputs sensitive keeps the value out of plan output and CI logs and does nothing about the state file. The Cloudflare R2 bucket pull-fm-tfstate is therefore the trust boundary for the production database owner credential, the identity that can DROP any table in the application database. Compounding this, R2 cannot version objects, so the state object has exactly one version and there is no platform-level undo for a bad or hostile write."
    justification: "Three alternatives were considered rather than assumed away, and the choice is a trade rather than an obvious win. Keeping state on R2 costs nothing, adds no vendor, and keeps state in the same account the rest of the infrastructure already depends on, at the price of no versioning and no server-side encryption with a customer-managed key. Moving to HCP Terraform, whose free tier stores state encrypted at rest with real version history, would genuinely fix both of those and is the strongest alternative on the merits; it is not taken here because it hands a third party the plaintext production database credential, adds a vendor dependency to the one workflow that has to keep working during an incident, and is a migration rather than a fix to apply mid-change. Moving to AWS S3 would give versioning plus SSE-KMS but reintroduces an AWS account and its billing to a project that consolidated away from exactly that. Removing the owner role from Terraform is not an option at all, because the plaintext arrives from the Neon API rather than from any provider choice, so it would relocate the credential without removing it while also defeating the Gate 0 zero-drift assertion. The exposure is therefore accepted and the boundary is hardened instead."
    compensating_controls: "Verified by probing the live bucket on 2026-07-29 rather than by reading documentation. The bucket is private: the R2 managed r2.dev domain reports enabled false, zero custom domains are attached, no CORS configuration exists, and anonymous requests to the S3 endpoint are refused. The state credential is a separate R2 access key pair (1Password pull-fm/infra/R2_TFSTATE) held apart from the per-environment Cloudflare tokens, so state stays readable when an environment credential is revoked mid-incident. No workflow in the repository holds it. The application does not use this credential at runtime: the BFF authenticates as the least-privilege pullfm_app role, whose password is created by SQL and is therefore not in state at all. Pre-apply state snapshots (infra/lib/tfstate-snapshot.sh) replace the versioning that R2 cannot provide, and are verified readable before the apply proceeds rather than after. Rotation is a documented procedure and, because R2 keeps one version of the live key, overwriting it genuinely destroys the old credential."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-10-27
    review_notes: "Owner is Grayson Adams. CORRECTED FINDING, and the correction matters more than the original: object versioning on pull-fm-tfstate is not merely unconfigured, R2 DOES NOT SUPPORT IT. Cloudflare's S3 compatibility matrix lists PutBucketVersioning and GetBucketVersioning as unimplemented and omits ListObjectVersions entirely. The first pass at this entry concluded versioning was switched off and recommended enabling it, which was not actionable. The reason the mistake was available is worth keeping, because it will recur with other R2 features: get-bucket-versioning returns an empty configuration at exit 0 while get-bucket-policy returns an explicit NotImplemented, and an empty versioning configuration is exactly what S3 returns for a bucket where versioning was never enabled. One unsupported API refuses loudly and the other shrugs. CONSEQUENCE THAT WAS FIXED IN THIS CHANGE: three documents described restoring a previous version of the state object as the rollback for a bad apply, a recovery path that had never existed. All three are corrected and infra/lib/tfstate-snapshot.sh now provides a real one, wired into the apply procedure in the runbook. WHAT THE SNAPSHOTS DO NOT COVER: they live in the same bucket under the same credential as the state they protect, so they answer a bad apply and not bucket loss, account suspension (see PULLFM-RISK-001) or a hostile credential holder. The --local flag is the answer for import-heavy applies. RETIREMENT CONDITION: this retires only when the owner password is no longer in state, which realistically requires Neon to offer role creation that does not return a password, or the owner role to leave Terraform management. Neither is likely inside one window, so expect to renew and tighten rather than close. At review, re-run the four bucket probes, confirm snapshots exist and are recent, and revisit the HCP Terraform option in the justification, since the argument against it is about migration cost and that argument weakens every time this is renewed. Related: PULLFM-RISK-009 (the state credential is not bucket-scoped) and PULLFM-RISK-010 (the bucket is not EU-pinned)."
    example: false

  - id: PULLFM-RISK-009
    title: "The Terraform state R2 credential is account-scoped, so it also reaches backups"
    status: accepted
    severity: medium
    threat_ids:
      - T26
      - T27
    description: "The R2 access key pair in 1Password as pull-fm/infra/R2_TFSTATE exists specifically to be a separate failure domain from the per-environment Cloudflare tokens, so that state stays reachable when an environment credential is revoked during an incident. It is not scoped to the state bucket. Proved on 2026-07-29 by using it to list objects in pull-fm-backups-staging through the EU jurisdiction endpoint, a bucket it has no reason to touch. A holder of the state credential can therefore read, overwrite and delete the database backup repository as well as Terraform state, which means the two are not independent failure domains and the separation they were created to provide is narrower than every document describing it implies. The blast radius is the union rather than either half: the plaintext production database password from state, plus the ability to destroy the backups that would otherwise be the recovery path."
    justification: "This is a scoping mistake rather than a platform limitation, which makes it cheap to fix and hard to justify leaving open for long. It is accepted only for the window needed to mint and swap in a bucket-scoped replacement, because rotating the state credential requires updating 1Password and re-running init across four Terraform roots, and doing that in the same change that restructured the database roles and the rollback mechanism would make a bad apply harder to attribute. The exposure while it stands is bounded by the credential never entering CI, never being committed, and living only in 1Password resolved per invocation."
    compensating_controls: "R2 offers bucket-scoped API tokens, so unlike PULLFM-RISK-006 there is no vendor limitation to work around here and the fix is available immediately. Backup objects are encrypted by pgBackRest with a key held outside Cloudflare, so read access to pull-fm-backups-staging yields ciphertext rather than user data; the meaningful harm from this credential is destruction rather than disclosure. The account holds exactly two buckets, both Pull.fm's, re-confirmed on 2026-07-29 by enumerating the default and EU endpoints, so the reachable surface is Pull.fm's own data and not the personal fleet's. The credential is not held by any workflow in this repository."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-10-27
    review_notes: "Owner is Grayson Adams. RECOMMENDED FIX, and it should not wait for the expiry: mint two bucket-scoped R2 API tokens, one for pull-fm-tfstate with object read and write, one for the backup repository, and retire the account-scoped pair. Then re-prove the isolation the way the gap was found, by attempting to list the other bucket with each token and confirming it is refused. An isolation claim that has not been tested by trying to violate it is an assumption. Escalate to high once production backups contain real user data, because at that point the destruction path in the description stops being theoretical. Note the asymmetry with PULLFM-RISK-006, which is NOT fixable this way: that one is account-scoped because cloudflare_r2_bucket needs bucket lifecycle permissions that Cloudflare only grants at account scope, whereas this credential only ever performs object operations and has no such excuse."
    example: false

  - id: PULLFM-RISK-010
    title: "The Terraform state bucket is not in the EU jurisdiction the residency posture claims"
    status: accepted
    severity: low
    threat_ids:
      - T26
    description: "pull-fm-tfstate is not EU-pinned. Verified on 2026-07-29 by enumerating both R2 endpoints with the state credential: the default endpoint returns pull-fm-tfstate and the EU jurisdiction endpoint returns only pull-fm-backups-staging. infra/terraform/README.md documented creating the state bucket with wrangler r2 bucket create pull-fm-tfstate --jurisdiction eu, and every backend.hcl.example pointed at the .eu. endpoint, so the documented configuration was not merely inconsistent with reality, it was broken: an R2 jurisdiction endpoint only sees buckets created in that jurisdiction, so anyone following the runbook failed at terraform init with a missing bucket rather than falling back. The residency question that remains is narrower than the documentation gap: docs/PLAN.md and the privacy posture assume EU-only hosting, and one bucket in the estate is not EU-pinned."
    justification: "Terraform state holds infrastructure identifiers and credentials, not user personal data, so this is not the same question the backups bucket answers and it is not a GDPR data-residency breach on its own. The bucket that does hold user data, pull-fm-backups-staging, is correctly EU-pinned by modules/backup-storage, and that is enforced by Terraform rather than by a runbook step. Recreating the state bucket in the EU jurisdiction cannot be done in place: an R2 bucket's jurisdiction is fixed at creation, so it means creating a second bucket, copying every state object, re-initialising four Terraform roots against the new endpoint, and doing so while the objects being moved contain the production database credential. That is a migration with a real chance of losing or exposing state, undertaken to correct a residency claim about metadata. The documentation half of this finding is fixed rather than accepted."
    compensating_controls: "Every backend.hcl.example and the bootstrap instructions in infra/terraform/README.md now match reality, so the broken-init half of this finding is closed and cannot silently mislead anyone. The bucket is private and access-controlled regardless of jurisdiction, per the probes recorded in PULLFM-RISK-008. Cloudflare R2 without a jurisdiction is not equivalent to non-EU storage, it is unpinned, so this is an absence of a guarantee rather than a positive placement outside the EU. The user-data bucket is EU-pinned and that placement is enforced in Terraform."
    owner: "ope@312.dev"
    accepted_on: 2026-07-29
    expires_on: 2026-10-27
    review_notes: "Owner is Grayson Adams. DO NOT recreate or delete pull-fm-tfstate to close this; it holds live state and the jurisdiction is immutable after creation, so any fix is a copy-and-cutover that needs its own plan and its own verified snapshot. DECISION REQUIRED AT REVIEW, and it is a decision rather than a task: either accept permanently on the grounds that state is metadata and record that in docs/PLAN.md so the EU-only claim is stated precisely rather than broadly, or schedule the bucket migration alongside another change that already requires re-initialising every root. Prefer the first unless a customer or auditor asks the question, because the migration moves plaintext production credentials for a claim that does not concern user data. If a new state bucket is ever created for any other reason, create it EU-pinned and this closes for free. Reviewed together with PULLFM-RISK-008 and PULLFM-RISK-009, which are the same bucket seen from different angles."
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

| ID              | Title                                                            | Severity | Expires    |
| --------------- | ---------------------------------------------------------------- | -------- | ---------- |
| PULLFM-RISK-001 | Shared Cloudflare account                                        | high     | 2026-10-26 |
| PULLFM-RISK-006 | Env Cloudflare tokens hold account-scoped R2 write               | medium   | 2027-01-20 |
| PULLFM-RISK-003 | KEK escrow has no second holder                                  | high     | 2026-10-15 |
| PULLFM-RISK-004 | DAST active scan is nightly, not per-pull-request                | low      | 2026-10-31 |
| PULLFM-RISK-007 | Production Postgres reachable from the internet                  | high     | 2026-10-27 |
| PULLFM-RISK-008 | DB credential plaintext in state, on a store that cannot version | high     | 2026-10-27 |
| PULLFM-RISK-009 | State R2 credential is account-scoped, reaches backups           | medium   | 2026-10-27 |
| PULLFM-RISK-010 | State bucket is not EU-pinned                                    | low      | 2026-10-27 |

### The four entries added on 2026-07-29

`PULLFM-RISK-007` through `010` were all created by the Neon migration and none is an example.
They share an expiry date deliberately, so they are re-argued together with the Phase 6 paid-plan
decision rather than drifting into four separate conversations.

`007` and `008` are the two halves of the migration itself: moving the database to a managed vendor
removed the network control (`007`) and put the production database credential into an object store
(`008`). Read them together, because the compensating control for one is load-bearing for the other.
The least-privilege `pullfm_app` role narrows `007`, and it also means the credential the
application holds at runtime is not the credential sitting in Terraform state.

`009` and `010` are properties of that object store found while checking whether it was a safe place
to put a database credential. Both were found by probing the live bucket rather than by reading the
documentation, and in both cases the documentation was wrong.

**Two findings here were corrections to this register's own first draft**, which is worth recording
because it is the failure mode the register exists to catch:

- `008` originally said object versioning was switched off and recommended enabling it. **R2 does
  not support object versioning at all**, so that recommendation was not actionable and the problem
  was worse than stated: three documents described a rollback that had never been possible. The
  documents are corrected and `infra/lib/tfstate-snapshot.sh` now provides a rollback that works.
- `006` claimed object versioning made a destructive write recoverable. Same correction.

The general lesson is in `008`'s review notes: R2 answers `GetBucketVersioning` with an empty
configuration at exit 0, while answering `GetBucketPolicy` with an explicit `NotImplemented`. An
empty versioning configuration is exactly what S3 returns for a bucket where versioning was never
enabled, so an unsupported feature was indistinguishable from an unconfigured one. **Expect the same
shape from other R2 features, and check the compatibility matrix rather than the API response.**

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
