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

The four entries above are **seeded examples**, marked `example: true`. Each describes a condition
that is genuinely true of this repository today, so they are usable as-is, but the owner and the
dates need operator confirmation before they should be treated as real accepted risks rather than
templates.

| ID              | Title                                             | Severity | Expires    |
| --------------- | ------------------------------------------------- | -------- | ---------- |
| PULLFM-RISK-001 | Shared Cloudflare account                         | high     | 2026-10-26 |
| PULLFM-RISK-003 | KEK escrow has no second holder                   | high     | 2026-10-15 |
| PULLFM-RISK-004 | DAST active scan is nightly, not per-pull-request | low      | 2026-10-31 |

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
