# No variable in this root holds a credential. NEON_API_KEY is consumed directly
# by the provider from the environment; see providers.tf.
#
# Every default below was READ BACK FROM THE LIVE PROJECT on 2026-07-29 rather
# than chosen. This root ADOPTS an existing Neon project (see imports.tf), so a
# default that disagrees with reality is not a preference, it is a plan that
# changes production. Where an attribute is ForceNew, a disagreement is a plan
# that DESTROYS production. Read the comment on each one before editing it.
#
# ---------------------------------------------------------------------------
# THE PROJECT THESE DEFAULTS DESCRIBE CHANGED ON 2026-07-29. THEY WERE RE-READ,
# NOT EDITED BY HAND.
# ---------------------------------------------------------------------------
#
# This root used to adopt `steep-frost-83698289` (`pull-fm`, aws-eu-central-1).
# It now adopts `cold-brook-02833828` (`pull-fm-us`, aws-us-east-1). Every
# default below came from GET /projects/cold-brook-02833828 and its /branches
# and /endpoints listings on 2026-07-29, not from editing the old value towards
# the new one. Two of them are NOT the same as the EU project's and would have
# been silently wrong if they had been carried over:
#
#   history_retention_seconds  21600 -> 604800   (the plan changed too)
#   staging_max_cu             1     -> 8        (the project default is 0.25-8)
#
# The EU project is retired. A default here that still names it is not a stale
# comment, it is a configuration pointed at a project that does not exist.

variable "org_id" {
  type        = string
  description = "Neon organisation that owns the project. Verified against GET /projects/cold-brook-02833828 on 2026-07-29: org-tiny-leaf-89756764, name '312.dev LLC'. Unchanged by the US cutover: the new project was created in the same organisation. Neon's API requires org_id as a query parameter when listing projects, so an organisation-owned project is not addressable through the older personal-account shape."
  default     = "org-tiny-leaf-89756764"
}

variable "project_id" {
  type        = string
  description = "Identifier of the EXISTING Neon project this root adopts. Not a name: Neon project IDs are opaque and permanent. Consumed by the import blocks in imports.tf. Repointed from steep-frost-83698289 (EU) to cold-brook-02833828 (US) on 2026-07-29; that was a state-rm-and-reimport, not a variable edit, because a project's region is immutable. See imports.tf."
  default     = "cold-brook-02833828"
}

variable "project_name" {
  type        = string
  description = "Human-readable project name. Live value is 'pull-fm-us'. The `-us` suffix is a cutover artifact rather than a preference: the name had to differ from the EU project's while both existed. `name` is updatable in place, so dropping the suffix is a one-line change plus an apply once nobody is reading the old name; it is deliberately NOT bundled into the retirement, because renaming a project in the same change that deletes its predecessor makes both harder to reason about if either goes wrong."
  default     = "pull-fm-us"
}

# ---------------------------------------------------------------------------
# THIS VALIDATION USED TO REQUIRE AN EU REGION AND CITED GDPR. THE POSTURE
# CHANGED; THE VALIDATION DID NOT DISAPPEAR, IT CHANGED SIDES.
# ---------------------------------------------------------------------------
#
# WHAT IT USED TO SAY. `startswith(var.region_id, "aws-eu-")`, on the stated
# grounds that "Pull.fm processes EU personal data and the GDPR posture in
# docs/PLAN.md assumes EU-only hosting". That was a real control and it did its
# job: the US project failed it, which is why the cutover could not be finished
# by editing one default.
#
# WHY THAT REASON NO LONGER APPLIES. The residency posture is now United States
# only, and it is stated as such in legal/privacy-policy.md, which records the
# database as "Neon Postgres, United States region (aws-us-east-1)" and deletes
# the whole Chapter V cross-border analysis on the ground that after the move
# there is no EEA-resident data to transfer. So the EU check is not a control
# that was weakened to unblock an apply; it is a control whose premise was
# withdrawn by a decision taken above this file.
#
# WHY IT IS STILL A VALIDATION AND NOT A DELETION. The reason to constrain the
# region at all never depended on which region was chosen. A Neon region is
# immutable, `region_id` is ForceNew, and `neon_project` carries
# prevent_destroy, so a wrong value here is not a typo that plans a move: it is
# a plan that proposes destroying the database and then fails the lifecycle
# lock. Failing at variable-validation time, with a message that says why, is
# several minutes and one less panic better than failing at plan time.
variable "region_id" {
  type        = string
  description = "Neon deployment region. UNITED STATES only, matching the residency posture in legal/privacy-policy.md. THE REGION OF AN EXISTING PROJECT CANNOT BE CHANGED; Neon's own documentation says a different region means a new project and a data migration, which is exactly what the 2026-07-29 cutover was."
  default     = "aws-us-east-1"

  validation {
    condition     = startswith(var.region_id, "aws-us-")
    error_message = "region_id must be a US region (the live project is aws-us-east-1). This check used to require aws-eu-* on GDPR grounds; the residency posture moved to United States only on 2026-07-29 and legal/privacy-policy.md now states that. Changing this value does not move a project: the region is immutable and ForceNew, so it plans a destroy of the live database and then trips prevent_destroy on neon_project."
  }
}

variable "pg_version" {
  type        = number
  description = "Postgres major version. Live value is 18, and docker-compose.dev.yml pins postgres:18-alpine to match; a skew between local and cloud is how 'migrations passed locally' turns into an incident. Neon supports 14 through 18 as of 2026-07-29. THIS ATTRIBUTE IS ForceNew: changing it plans a project replacement, not an in-place upgrade."
  default     = 18

  validation {
    condition     = var.pg_version >= 14 && var.pg_version <= 18
    error_message = "pg_version must be a Neon-supported major version (14 to 18)."
  }
}

variable "compute_provisioner" {
  type        = string
  description = "Neon compute provisioner. Live value is k8s-neonvm, which is the one that supports autoscaling; k8s-pod does not."
  default     = "k8s-neonvm"

  validation {
    condition     = contains(["k8s-neonvm", "k8s-pod"], var.compute_provisioner)
    error_message = "compute_provisioner must be k8s-neonvm or k8s-pod."
  }
}

# --- point-in-time restore ---------------------------------------------------

variable "history_retention_seconds" {
  type        = number
  description = <<-DESC
    Point-in-time restore window, in seconds. Live value on the US project is
    604800 (7 days).

    THIS NUMBER CHANGED WITH THE PROJECT AND IS NOT A CARRIED-OVER DEFAULT. The
    EU project was 21600 (6 hours), which was the ceiling on free_v3. The US
    project is on launch_v3, which is a paid plan, and it was created with a
    7 day window. Leaving 21600 here after the repoint would have planned a
    REDUCTION of the restore window from seven days to six hours on the live
    production database, which is a plan that applies cleanly and is only
    noticed when somebody needs to restore.

    THIS MUST BE SET EXPLICITLY AND MUST MATCH. The provider declares a static
    default of 86400 (24 hours) for this attribute, so leaving it out of the
    configuration does not mean "leave it alone", it means "plan a change to 24
    hours".

    Gate L requires a configured PITR window, and this is where that number
    lives.
  DESC
  default     = 604800

  validation {
    condition     = var.history_retention_seconds >= 0 && var.history_retention_seconds <= 2592000
    error_message = "history_retention_seconds must be between 0 and 2592000 (30 days)."
  }
}

# ---------------------------------------------------------------------------
# ADOPTION IDENTIFIERS. THESE HAVE NO DEFAULTS AND MUST COME FROM A GITIGNORED
# terraform.tfvars, AND THAT IS A DISCLOSURE CONSTRAINT RATHER THAN A STYLE ONE.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. The six import blocks in imports.tf used to carry the live
# branch and endpoint ids as string literals. `tools/check-public-identifiers.mjs`
# has detectors for exactly those two shapes, on the stated grounds that a Neon
# endpoint hostname is reachable from the public internet with the credential as
# the only network control, and that a branch id addresses a restorable copy of
# production data through the control plane. Both were OPEN FINDINGS recorded in
# that check's baseline, and the baseline only shrinks: writing the US ids in
# after the cutover would have added eleven NEW findings to a public repository
# and failed the gate.
#
# The head of infra/neon/README.md said the ids were "deliberately not written
# here; ask the control plane for them". `imports.tf` was the one file that did
# not honour that.
#
# WHY VARIABLES AND NOT SOMETHING CLEVERER. An import block's `id` must be known
# at plan time, so it cannot be a resource attribute, a data source or an output.
# Deleting the import blocks after the first apply was the other option and it was
# rejected: they are inert while state is intact, and they are the RESCUE if state
# is ever lost or rolled back. Without them a plan against empty state does not
# error, it proposes CREATING A SECOND NEON PROJECT, which is the failure this
# root repeats most often in its own comments.
#
# So the ids live in `terraform.tfvars`, which `.gitignore` already covers, next
# to nothing else. The consequences, stated rather than discovered:
#
#   - `terraform plan` in this root REQUIRES that file. Without it the run fails
#     with "No value for required variable", which is a safe failure: it stops,
#     it names what is missing, and it cannot plan the wrong thing. That is
#     already true of `backend.hcl`, so a fresh checkout gains no new obstacle.
#   - `terraform validate` does NOT require it, so the credential-free CI path
#     (`terraform init -backend=false && terraform validate`) is unaffected.
#   - The values are always re-derivable from the control plane. The command is in
#     terraform.tfvars.example, and it is the authority: an id written down by hand
#     is an id that can be stale, and this root has already been repointed once.
#
# Each carries a shape validation so a truncated or transposed value fails at
# variable-validation time rather than as an unhelpful "resource not found"
# partway through an import.

variable "main_branch_id" {
  type        = string
  description = "Id of the project's DEFAULT branch, used only to build the composite import ids for neon_database.main and neon_role.owner. Not written in any tracked file: read it from GET /projects/<project_id>/branches, where it is the branch with default true. Terraform's own view of it after adoption is the main_branch_id OUTPUT, which is derived from the project rather than from this variable."

  validation {
    condition     = can(regex("^br-[a-z]+-[a-z]+-[a-z0-9]{8,}$", var.main_branch_id))
    error_message = "main_branch_id must look like a Neon branch id (br-word-word-suffix). Read it from GET /projects/<project_id>/branches rather than transcribing it."
  }
}

variable "main_endpoint_id" {
  type        = string
  description = "Id of the read_write endpoint on the default branch, used only to build the import id for neon_endpoint.main. Read it from GET /projects/<project_id>/endpoints; it is the one whose branch_id is the default branch."

  validation {
    condition     = can(regex("^ep-[a-z]+-[a-z]+-[a-z0-9]{8,}$", var.main_endpoint_id))
    error_message = "main_endpoint_id must look like a Neon endpoint id (ep-word-word-suffix). Read it from GET /projects/<project_id>/endpoints."
  }
}

variable "staging_branch_id" {
  type        = string
  description = "Id of the EXISTING staging branch, used only to build the import id for neon_branch.staging. THIS IS THE ONE THAT MATTERS MOST: on the US project the staging branch was cut outside Terraform, so without this import the plan reads '1 to add' and applying it creates a SECOND branch named `staging` while the live one goes unmanaged. Neon does not require branch names to be unique. Read it from GET /projects/<project_id>/branches."

  validation {
    condition     = can(regex("^br-[a-z]+-[a-z]+-[a-z0-9]{8,}$", var.staging_branch_id))
    error_message = "staging_branch_id must look like a Neon branch id (br-word-word-suffix). Read it from GET /projects/<project_id>/branches."
  }
}

variable "staging_endpoint_id" {
  type        = string
  description = "Id of the EXISTING read_write endpoint on the staging branch, used only to build the import id for neon_endpoint.staging. Same trap as staging_branch_id: without it, an apply creates a second endpoint rather than adopting the live one. Read it from GET /projects/<project_id>/endpoints."

  validation {
    condition     = can(regex("^ep-[a-z]+-[a-z]+-[a-z0-9]{8,}$", var.staging_endpoint_id))
    error_message = "staging_endpoint_id must look like a Neon endpoint id (ep-word-word-suffix). Read it from GET /projects/<project_id>/endpoints."
  }
}

# --- branches ----------------------------------------------------------------

variable "staging_branch_name" {
  type        = string
  description = "Name of the long-lived staging branch, a child of `main`. The convention is that an environment branch is named after its environment; see docs/runbooks/neon-migration.md. Branches replace the ephemeral-teardown pattern in docs/PLAN.md section 10c: a branch costs storage for its diff from the parent and nothing else while its compute is suspended."
  default     = "staging"
}

variable "default_branch_protected" {
  type        = bool
  description = <<-DESC
    Mark the default branch (`main`, which serves production) protected. Live
    value is false.

    STILL FALSE, AND THE REASON IT IS FALSE HAS CHANGED. Do not re-read the old
    justification as though it still stood.

    WHAT THE OLD COMMENT SAID. Two reasons: protected branches are a paid-plan
    feature and the org was on free_v3, so true would plan a change the API
    refuses; and protection blocks a reset from a parent, which is the operation
    the branching workflow exists to make cheap.

    BOTH HAVE EXPIRED. The US project is on launch_v3, a paid plan, so this is
    no longer a request the API would reject. And the restore drill already
    refuses to touch the default branch on its own account
    (infra/backup/restore-drill.sh reads `default` off GET /branches and dies if
    the target is it), so protecting `main` would not take anything away from
    it.

    SO WHY IS IT STILL FALSE. Only because that is the live value, and this root
    adopts rather than dictates. Turning it on is now a genuinely available
    hardening step rather than a blocked one, and it is left for a change that
    is about that and has an apply behind it, not smuggled into a migration.
    Note it interacts with `allowed_ips`, whose API shape carries a
    `protected_branches_only` flag.
  DESC
  default     = false
}

# --- compute sizing ----------------------------------------------------------
#
# THE PLAN CHANGED UNDER THIS SECTION AND EVERY NUMBER IN IT WAS FREE-PLAN
# ARITHMETIC. Read the new figures before reusing the old reasoning.
#
# The EU project was on `free_v3`: 100 CU-hours per project per month, an
# autoscaling ceiling of 2 CU, a 512 MiB branch size limit, 10 branches, and
# scale-to-zero after 5 minutes that could not be disabled.
#
# The US project `cold-brook-02833828` is on `launch_v3`. Read back on
# 2026-07-29: `branches_limit` 5000, `branch_logical_size_limit_bytes` 16 TiB,
# and `default_endpoint_settings` of 0.25 to 8 CU with `suspend_timeout_seconds`
# 0. Compute is no longer a fixed monthly allowance that simply stops; past the
# included hours it is billed. That flips the shape of the risk from "staging
# can exhaust production's allowance" to "staging can spend money", and the
# control that expresses the second one is `var.quota` below, not an asymmetry
# between two endpoint ceilings.

variable "staging_min_cu" {
  type        = number
  description = "Minimum compute units for the staging endpoint. 0.25 is the floor, is the live value, and is the right value for an environment that is idle most of the month: the floor is what the compute costs while nothing is happening."
  default     = 0.25
}

# ---------------------------------------------------------------------------
# THIS IS THE VALUE THAT MADE `terraform plan` PERMANENTLY DIRTY ON THIS ROOT.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. The default was 1, and the live staging endpoint was 8. Plan
# reported `autoscaling_limit_max_cu 8 -> 1` on every single run, on the EU
# project before the cutover and on the US project after it. Nobody applied it,
# because nobody believed it, which is the actual damage: a root whose plan is
# never clean teaches everyone reading it to skip the plan. The README even
# carried a banner saying the plan WAS clean while it was not.
#
# WHY THE OLD VALUE WAS 1. "Kept below the production ceiling on purpose:
# staging burns the same shared 100 CU-hour allowance production does, and a
# runaway load test on staging must not be able to spend production's compute
# budget." Every clause of that is free_v3 arithmetic. There is no 100 CU-hour
# allowance on launch_v3, and the 2 CU ceiling it was reasoning under is now 8.
#
# WHY 8 AND NOT SOMETHING SMALLER. Three reasons, in order of weight:
#
#   1. It is what the project's own `default_endpoint_settings` says (0.25 to 8),
#      so it is what every endpoint created in this project gets. Declaring
#      anything else here makes staging the odd one out by configuration rather
#      than by decision.
#   2. The MusicBrainz canonical load RUNS AGAINST THE STAGING BRANCH
#      (infra/mb-loader/mb-canonical-load.sh, measured against staging on
#      2026-07-29) and docs/runbooks/mb-canonical-data.md records that load
#      succeeding on a project reporting "0.25 to 8 CU of compute autoscaling",
#      streaming a 2.32 GB archive into roughly 10 GB resident. Clamping staging
#      to 1 CU does not make that load fail, it makes it slow, and a load test
#      bottlenecked on a deliberately undersized database produces numbers that
#      mean nothing.
#   3. Autoscaling max is a CEILING, not a reservation. Staging sits at the 0.25
#      floor and scales to zero; raising the ceiling changes what an active
#      minute may cost, not what an idle month does.
#
# WHAT WAS GIVEN UP, STATED PLAINLY RATHER THAN GLOSSED. The old value did
# enforce "staging's ceiling is lower than production's". That invariant is gone:
# production's endpoint adopts the same 0.25-8 and this one now matches it. It
# could not have been kept - lowering staging breaks reason 2, and raising
# production is not this file's decision - and it was never the right mechanism
# anyway. A per-endpoint ceiling bounds one compute's peak; it does not bound
# spend. `var.quota` is enforced server-side across the whole project and is
# still null. That is the gap, it is named here, and it is named again there.
variable "staging_max_cu" {
  type        = number
  description = "Maximum compute units for the staging endpoint. 8, matching the live endpoint and the project's own default_endpoint_settings. This is a CEILING on an endpoint that idles at the 0.25 floor and scales to zero, not a reservation. The former value of 1 was free_v3 arithmetic and was the source of a permanent plan diff; see the block above before lowering it."
  default     = 8
}

variable "staging_suspend_timeout_seconds" {
  type        = number
  description = "Inactivity before the staging compute suspends. 0 means 'use the platform default', which is 5 minutes, and is the live value. Do not set -1 (never suspend) here: scale-to-zero is the entire reason a standing staging branch is affordable, and on launch_v3 an unsuspendable idle compute is billed rather than merely eating an allowance."
  default     = 0
}

# --- roles -------------------------------------------------------------------

variable "owner_role_name" {
  type        = string
  description = "Owner role on the `main` branch. Live value is neondb_owner, created by the Neon console when the project was made. Not renamed to something prettier: a role rename is a create-plus-drop in Neon terms and would orphan the database it owns."
  default     = "neondb_owner"
}

variable "database_name" {
  type        = string
  description = "Application database on the `main` branch. Live value is neondb, created by the Neon console. The staging branch inherits it, which is why there is no second neon_database resource for staging."
  default     = "neondb"
}

# `create_app_role` USED TO LIVE HERE AND HAS BEEN REMOVED, not defaulted off.
#
# It gated a `neon_role.app` resource. That resource could never have produced a
# least-privilege role: Neon grants neon_superuser to every role created through
# its API, and Postgres 16+ makes that membership unrevocable by anyone except
# the grantor or a superuser, neither of which a Neon customer has. The full
# measurement is in main.tf and in infra/neon/sql/create-app-role.sql.
#
# A boolean that can only ever select between "no app role" and "an app role
# that is secretly an administrator" is worse than no boolean, because it reads
# in review as a hardening switch waiting to be flipped.
#
# The role is created by infra/neon/sql/create-app-role.sql instead. Its name
# stays here because the outputs assemble connection-string templates from it.

variable "app_role_name" {
  type        = string
  description = <<-DESC
    Name of the least-privilege application role that the BFF authenticates as
    at runtime.

    NOT CREATED BY THIS CONFIGURATION. It is created by
    infra/neon/sql/create-app-role.sql, which must use the same name, and the
    value is declared here because the `*_app_*` outputs build connection-string
    templates from it and because it is the identity `allowed_ips` and any
    future audit would be reasoning about.

    Changing it is a two-part operation: this variable and the literals in
    infra/neon/sql/*.sql, which hardcode it deliberately so that a mismatch
    fails a precondition check rather than silently granting to a role nothing
    connects as.
  DESC
  default     = "pullfm_app"
}

# --- network posture ---------------------------------------------------------

variable "allowed_ips" {
  type        = list(string)
  description = <<-DESC
    Source addresses permitted to connect to the project's endpoints. Empty in
    every committed configuration, and null is sent when it is empty so the
    attribute is omitted from the API call entirely rather than sent as an empty
    allowlist.

    This is the Neon equivalent of the origin firewall in modules/firewall, and
    it is the single largest security regression of this migration: a
    self-managed Postgres on a private Hetzner network had no public interface
    at all, while a Neon endpoint is reachable from the internet by anyone
    holding the credential. The mitigating control today is that the credential
    is the only control.

    Populating it with the BFF egress addresses (the app_egress_ipv4 output of
    the environment roots) is the fix. It requires a Scale plan, so it is
    recorded in the runbook as a plan-upgrade prerequisite rather than left as
    an unexplained empty list.

    THE 2026-07-29 PLAN CHANGE DOES NOT UNLOCK THIS, WHICH IS WORTH SAYING
    BECAUSE OTHER PARAGRAPHS IN THIS FILE DID BECOME OBSOLETE. The US project
    moved to launch_v3, which cleared the free_v3 blockers on branch count,
    branch size, PITR window and protected branches. Neon lists IP Allow on
    Scale and above, so launch_v3 is still below it and PULLFM-RISK-007 stands
    unchanged. Not re-tested against this project: the live settings object
    reports an empty `ips` list either way, so an empty list is not evidence
    that the feature is available.
  DESC
  default     = []

  validation {
    condition     = !contains(var.allowed_ips, "0.0.0.0/0") && !contains(var.allowed_ips, "::/0")
    error_message = "allowed_ips must never contain a default route. An allowlist of everything is not an allowlist."
  }
}

# --- consumption quota -------------------------------------------------------
#
# ---------------------------------------------------------------------------
# THIS IS NOW ARMED. IT WAS NULL, AND THE COMMENT THAT EXPLAINED WHY IT WAS
# NULL SAID THE DECISION WAS THE OWNER'S. THE OWNER HAS MADE IT.
# ---------------------------------------------------------------------------
#
# THE DECISION, RECORDED BECAUSE ITS CONSEQUENCE IS AN OUTAGE. The budget is
# USD 35 per month for Neon. The owner was told plainly that exceeding a quota
# suspends every active compute in the project and that Neon refuses to start
# them again until the billing period rolls over, which on `main` means
# production is down, and accepted that: an outage rather than a surprise bill.
# So this is armed rather than replaced with an alert. Anyone reading this after
# an outage should know the suspension is the control working, not failing.
#
# ---------------------------------------------------------------------------
# THE PRICING THIS ARITHMETIC IS BUILT ON. READ IT BEFORE CHANGING A NUMBER.
# ---------------------------------------------------------------------------
#
# Launch plan (`launch_v3`), read from https://neon.com/pricing and
# https://neon.com/docs/introduction/usage-calculations on 2026-07-29:
#
#   base fee                     USD 0.00     pay-as-you-go, NO monthly minimum
#   compute                      USD 0.106    per CU-hour
#   root + child branch storage  USD 0.35     per GB-month
#   instant restore (PITR)       USD 0.20     per GB-month
#   snapshots                    USD 0.09     per GB-month  (none in use)
#   public network transfer      500 GB per project included, then USD 0.10/GB
#   extra branches               USD 1.50 per branch-month past 10 (2 in use)
#
# THERE IS NO BASE FEE AND THERE ARE NO INCLUDED COMPUTE HOURS, and that is the
# single most important correction to the older comments in this file. Several
# of them, and infra/neon/README.md, said "compute past the INCLUDED HOURS is
# billed". That describes the retired Launch plan (a monthly fee with an
# allowance). The current Launch plan is pure consumption: the FIRST CU-second
# of the month is billed. Budgeting against a non-existent allowance would have
# over-provisioned this quota by the size of that allowance.
#
# Storage is normalised to a 744 hour month and GB means 1e9 bytes, not 2^30:
# byte-hours / 744 / 1e9 = GB-months.
#
# ---------------------------------------------------------------------------
# active_time_seconds VERSUS compute_time_seconds. CONFUSING THESE IS A 32x
# ERROR ON THIS PROJECT, SO IT IS SPELLED OUT RATHER THAN ASSUMED.
# ---------------------------------------------------------------------------
#
#   active_time_seconds  WALL-CLOCK seconds a compute is not scaled to zero,
#                        summed over every compute in the project. NOT weighted
#                        by compute size. NOT a billed metric.
#   compute_time_seconds CU-SECONDS: wall-clock seconds multiplied by the
#                        compute's size in CU. One second at 0.25 CU costs 0.25
#                        of it; one second at 8 CU costs 8.
#
# Every endpoint in this project autoscales 0.25 to 8 CU, so one active second
# can cost anywhere from 0.25 to 8 CU-seconds: a THIRTY-TWO-FOLD spread (8 /
# 0.25). Sizing a spend cap off active time would be wrong by up to that factor
# at the top of the range.
#
# compute_time_seconds IS the billed compute metric. It is the legacy name for
# what the usage-based API now calls `compute_unit_seconds`, and CU-hours are
# just compute_time_seconds / 3600. That is why the cap goes on this dimension
# and not the other one.
#
# Measured on the live project on 2026-07-30, which is the ratio to sanity-check
# against: 7,464 compute-seconds against 19,432 active seconds, so the project
# averaged 0.384 CU. The computes sit near the 0.25 floor and burst rarely.
#
# ---------------------------------------------------------------------------
# FROM USD 35 TO THE NUMBERS BELOW.
# ---------------------------------------------------------------------------
#
# STEP 1: RESERVE WHAT THE QUOTA CANNOT CAP. Two of the four live billing lines
# are storage, and NO quota dimension bounds storage spend (see
# logical_size_bytes below for why the one that looks like it does, does not).
# They therefore come off the top as a reserve rather than being capped:
#
#   branch storage      measured 2026-07-30: staging 11,051,925,504 bytes
#                       (11.05 GB, the MusicBrainz canonical data) plus main
#                       32,907,264 bytes (0.033 GB). 11.08 GB x 0.35 = USD 3.88.
#                       RESERVED USD 5.00, which covers growth to about 14.3 GB.
#   instant restore     7 day window (history_retention_seconds = 604800). At
#                       steady state the window holds roughly one MusicBrainz
#                       reload's worth of superseded pages, so about 11 GB
#                       resident: 11 x 0.20 = USD 2.20. RESERVED USD 4.00, which
#                       covers about two reload cycles sitting in the window at
#                       once.
#
#   uncappable reserve  USD 9.00
#
# STEP 2: WHAT IS LEFT FOR THE CAPPED LINES. 35.00 - 9.00 = USD 26.00, split
# between compute and egress.
#
# STEP 3: EGRESS. 500 GB per project is included and the project transferred
# 987,517 bytes (under 1 MB) in its first day, so the allowance is roughly four
# orders of magnitude above real use. The cap is set at 520 GB: 20 GB past the
# allowance at USD 0.10 = USD 2.00 worst case. That buys a hard money bound for
# almost nothing, because 520 GB is still about 17,000x measured use, so it
# cannot trip on a normal month. It is set at 520 and not at exactly 500 on
# purpose: a cap at the allowance boundary would suspend production at the
# moment egress cost begins, which is an outage that saves USD 0.00.
#
# STEP 4: COMPUTE. 26.00 - 2.00 = USD 24.00, which at USD 0.106 per CU-hour is
# 226.4 CU-hours. ROUNDED DOWN to 200 CU-hours = 720,000 CU-seconds = USD 21.20.
#
# STEP 5: THE HEADROOM, STATED. Worst case with everything at its cap or its
# reserve:
#
#   compute        720,000 / 3600 x 0.106      = USD 21.20   (hard-capped)
#   egress         (520 - 500) x 0.10          = USD  2.00   (hard-capped)
#   branch storage reserve                     = USD  5.00   (NOT capped)
#   instant restore reserve                    = USD  4.00   (NOT capped)
#   snapshots, extra branches, base fee        = USD  0.00
#                                                ------------
#                                                USD 32.20
#
# That is 8.0% under the USD 35 budget, and the headroom is doing three specific
# jobs rather than being decorative: it absorbs the two uncapped storage lines
# drifting above their reserves before anyone notices; it absorbs Neon metering
# hourly and enforcing the quota periodically rather than instantaneously, so
# consumption can overshoot the trip point slightly; and it means a month that
# lands near the cap does not produce a bill over budget, which is the whole
# point of a cap.
#
# ---------------------------------------------------------------------------
# THE PART THAT MATTERS OPERATIONALLY, AND IT IS NOT COMFORTABLE.
# ---------------------------------------------------------------------------
#
# 200 CU-hours is NOT a lot of headroom over what this project costs simply by
# existing. An endpoint held warm at the 0.25 CU FLOOR for a whole 744 hour
# month consumes 744 x 0.25 = 186 CU-hours, or USD 19.72. That is 93% of this
# quota spent on production merely being reachable, before one query.
#
# It does not trip TODAY because scale-to-zero is working: `main` was active
# 2,168 seconds out of 33,600 wall-clock (6.5%) and burned 551 compute-seconds,
# which extrapolates to about 12 CU-hours a month. Staging's MusicBrainz load
# costs 6,913 compute-seconds (1.92 CU-hours) per run at roughly four runs a
# month, so about 8 CU-hours. Today's regime is therefore around 21 CU-hours a
# month against a 200 CU-hour cap: nearly 10x headroom.
#
# THE THING THAT CHANGES THAT IS PRODUCTION GETTING TRAFFIC. Once `main` stops
# scaling to zero - real users, or merely a health check or a pooler keepalive
# often enough to defeat the five minute suspend - it alone takes 186 of the 200
# and this quota becomes a live outage risk within days. Two consequences, both
# deliberate:
#
#   1. NEVER set suspend_timeout_seconds to -1 on any endpoint in this project.
#      Scale-to-zero is not a nicety here, it is the reason the budget fits.
#      `staging_suspend_timeout_seconds` above already says this; it is true of
#      `main` for a harder reason.
#   2. Consumption must be watched BEFORE the cliff, because with a hard quota
#      and no warning the first signal is total database unavailability. The
#      check is in infra/neon/README.md under "The spend cap, and how to see it
#      coming".
#
# Stated plainly so nobody rediscovers it during an incident: USD 35 a month on
# `launch_v3` buys about 226 CU-hours after storage, and an always-warm 0.25 CU
# production compute is 186 of them. The budget is roughly 1.2x the cost of the
# database existing. That is a fact about the budget, not a bug in the quota.
#
# ---------------------------------------------------------------------------
# THE QUOTA IS PER PROJECT, AND THE BUDGET IS PER ORGANISATION.
# ---------------------------------------------------------------------------
#
# `settings.quota` bounds `cold-brook-02833828` and nothing else. The invoice is
# the organisation's. This is not hypothetical: the v2 consumption API still
# reports 8,247 compute-unit-seconds for the retired EU project
# `steep-frost-83698289` inside the CURRENT billing period, because it was
# deleted partway through it. That spend is already incurred and does not recur
# (GET on that project now returns 404), but it is the demonstration: a second
# project in this organisation would be entirely outside this cap. The
# compensating control is `pullfm_assert_neon_scope` in infra/lib/credentials.sh,
# which refuses to run if the key can see a project other than `pull-fm-us`.

variable "quota" {
  type = object({
    active_time_seconds  = optional(number, 0)
    compute_time_seconds = optional(number, 0)
    written_data_bytes   = optional(number, 0)
    data_transfer_bytes  = optional(number, 0)
    logical_size_bytes   = optional(number, 0)
  })
  description = <<-DESC
    Per-project consumption quota, sized to a USD 35 per month budget on the
    `launch_v3` plan. When a quota is exceeded Neon suspends every active compute
    in the project and refuses to start them again until the billing period rolls
    over. Zero means unlimited for that dimension.

    ARMED, WITH THE OUTAGE RISK ACCEPTED. On `main` a suspension means production
    is down. That is the accepted trade: an outage rather than a surprise bill.
    The full derivation from USD 35 to each number is in the comment block above
    this variable, including the pricing it was computed from and its URL.

    THIS IS THE SPEND CAP HETZNER DOES NOT HAVE. docs/PLAN.md section 2 records
    Gate $ as "one vendor armed, one vendor limitation": Hetzner publishes no
    budget API and the operator could not find the option in the console either.
    Neon does have one, it is enforced server-side, and it is now declared.

    TWO OF THE FIVE DIMENSIONS ARE BOUND AND THREE ARE DELIBERATELY UNLIMITED.
    Zero is not "not got round to it" in any of the three cases:

      active_time_seconds   0, UNLIMITED. It is not a billed metric. Two computes
                            warm at 0.25 CU cost exactly what one warm at 0.5 CU
                            costs but consume twice the active time, so a cap
                            here can suspend production while spend is far under
                            budget: an outage that saves nothing.
                            compute_time_seconds already dominates it as a spend
                            control, since every active second costs at least
                            0.25 CU-seconds at the autoscaling floor.

      compute_time_seconds  720,000 = 200 CU-hours = USD 21.20 at USD 0.106 per
                            CU-hour. This is the billed compute metric and the
                            only dimension that can run away, so it carries the
                            cap. Project-wide, so a runaway load test on staging
                            spends production's budget - which is exactly the
                            thing `staging_max_cu` was wrongly being asked to
                            prevent, and could not, because a per-endpoint
                            ceiling bounds one compute's peak and not spend.

      written_data_bytes    0, UNLIMITED, and this one is evidence-based rather
                            than argued. The live project reports 0 written bytes
                            project-wide AND 0 on both branches, inside a
                            consumption period that contains an 11 GB COPY. The
                            metric is not populated on `launch_v3`; it is a
                            legacy dimension with no counterpart in the v2
                            metrics and no line in the price list, so it bounds
                            no spend. A number here would be inert at best, and
                            an outage trigger nobody reasoned about if Neon ever
                            starts populating it.

      data_transfer_bytes   520,000,000,000 = 520 GB. 500 GB per project is
                            included, so the worst case this permits is 20 GB of
                            overage at USD 0.10 = USD 2.00. Measured use is under
                            1 MB a day, so the cap is about 17,000x real traffic:
                            a hard money bound that cannot trip normally.

      logical_size_bytes    0, UNLIMITED, AND THIS IS THE ONE WORTH READING. It
                            is not a monthly spend dimension at all: it is the
                            maximum size ANY ONE BRANCH may reach, it applies for
                            the branch's LIFETIME rather than per billing period,
                            and exceeding it suspends that branch's compute. So
                            it does not clear at the rollover the way the others
                            do; it needs a human.

                            The value that would make it a spend control is about
                            14 GB, bounding branch storage near the USD 5.00
                            reserve. THAT VALUE WOULD SUSPEND STAGING ON THE NEXT
                            SCHEDULED JOB. infra/mb-loader/mb-canonical-load.sh
                            is stage-then-swap: it CREATEs mb.canonical_stage_*,
                            COPYs the whole dump in, builds five or six indexes,
                            ANALYZEs, and only then DROPs mb.canonical and
                            renames. Both full copies, heap and indexes, coexist
                            for the entire load, so the branch peaks at roughly
                            2x its steady 11.05 GB - about 22 GB - every time
                            pullfm-mb-canonical.timer finds a new dump.

                            A cap high enough to clear that peak safely (say 30
                            to 40 GB) bounds storage at USD 10.50 to USD 14.00
                            per branch, which is not a bound inside a USD 35
                            budget. And because the limit is per branch it never
                            bounds the project's total storage anyway. So the
                            dimension is a branch-size guardrail, not a spend
                            cap, and using it as one here buys a self-inflicted
                            outage on a timer. Storage is MONITORED instead; see
                            infra/neon/README.md.

    SETTING THIS TO ALL ZEROES IS THE DOCUMENTED WAY OUT OF A SUSPENSION. Neon's
    own guidance for restoring access before the billing period rolls over is to
    set the quota to 0. That is why nothing here validates that the cap is
    non-zero: such a validation would block the recovery path during the outage
    it was meant to prevent. The validations below bound it from ABOVE only.
  DESC

  default = {
    active_time_seconds  = 0
    compute_time_seconds = 720000
    written_data_bytes   = 0
    data_transfer_bytes  = 520000000000
    logical_size_bytes   = 0
  }

  # Bound from above, never from below. 900,000 CU-seconds is 250 CU-hours, or
  # USD 26.50 at USD 0.106 - the absolute most the USD 35 budget can buy once the
  # USD 9.00 of uncappable storage is reserved. This catches the fat-finger that
  # matters, which is an extra zero: 7,200,000 would be 2,000 CU-hours and USD
  # 212. It does NOT encode the price, so it does not silently rot into a wrong
  # number if Neon reprices; it encodes the ceiling the price implies today, and
  # the arithmetic to redo is in the comment block above.
  validation {
    condition     = var.quota == null || var.quota.compute_time_seconds <= 900000
    error_message = "quota.compute_time_seconds must not exceed 900000 (250 CU-hours). At USD 0.106 per CU-hour that is USD 26.50, which is all the USD 35 monthly budget leaves after reserving USD 9.00 for branch storage and instant restore, neither of which any quota dimension can bound. The armed value is 720000 (200 CU-hours, USD 21.20). Redo the arithmetic in the comment above variable \"quota\" before raising this."
  }

  # 600 GB permits 100 GB past the 500 GB included allowance, or USD 10.00 - the
  # most a single line can take out of this budget before the compute cap has to
  # shrink to pay for it. The armed value is 520 GB (USD 2.00 worst case).
  validation {
    condition     = var.quota == null || var.quota.data_transfer_bytes <= 600000000000
    error_message = "quota.data_transfer_bytes must not exceed 600000000000 (600 GB). 500 GB per project is included on launch_v3, so 600 GB already permits USD 10.00 of egress overage at USD 0.10/GB. The armed value is 520000000000 (520 GB, USD 2.00 worst case)."
  }

  # logical_size_bytes is per branch and for the branch's LIFETIME, and the
  # MusicBrainz loader peaks staging at about 22 GB (2x its steady 11.05 GB)
  # because it builds a full second copy before dropping the first. A cap below
  # 25 GB therefore suspends staging on a scheduled job and does not clear at the
  # billing rollover. Zero (unlimited) is the armed value and stays permitted.
  validation {
    condition     = var.quota == null || var.quota.logical_size_bytes == 0 || var.quota.logical_size_bytes >= 25000000000
    error_message = "quota.logical_size_bytes must be 0 (unlimited) or at least 25000000000 (25 GB). It caps a SINGLE branch for that branch's LIFETIME, not per billing period, so tripping it does not clear at the rollover. infra/mb-loader/mb-canonical-load.sh is stage-then-swap and holds two full copies of the 11.05 GB canonical table at once, peaking near 22 GB, so any lower cap suspends staging the next time pullfm-mb-canonical.timer finds a new dump. See the comment above variable \"quota\"."
  }
}
