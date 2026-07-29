# No variable in this root holds a credential. NEON_API_KEY is consumed directly
# by the provider from the environment; see providers.tf.
#
# Every default below was READ BACK FROM THE LIVE PROJECT on 2026-07-29 rather
# than chosen. This root ADOPTS an existing Neon project (see imports.tf), so a
# default that disagrees with reality is not a preference, it is a plan that
# changes production. Where an attribute is ForceNew, a disagreement is a plan
# that DESTROYS production. Read the comment on each one before editing it.

variable "org_id" {
  type        = string
  description = "Neon organisation that owns the project. Verified against GET /projects/steep-frost-83698289 on 2026-07-29: org-tiny-leaf-89756764, name '312.dev LLC'. Neon's API now requires org_id as a query parameter when listing projects, so an organisation-owned project is no longer addressable through the older personal-account shape."
  default     = "org-tiny-leaf-89756764"
}

variable "project_id" {
  type        = string
  description = "Identifier of the EXISTING Neon project this root adopts. Not a name: Neon project IDs are opaque and permanent. Consumed by the import block in imports.tf."
  default     = "steep-frost-83698289"
}

variable "project_name" {
  type        = string
  description = "Human-readable project name. Live value is 'pull-fm'."
  default     = "pull-fm"
}

variable "region_id" {
  type        = string
  description = "Neon deployment region. EU only, for the same reason modules/compute validates the Hetzner location: Pull.fm processes EU personal data and the GDPR posture in docs/PLAN.md assumes EU-only hosting. THE REGION OF AN EXISTING PROJECT CANNOT BE CHANGED; Neon's own documentation says a different region means a new project and a data migration."
  default     = "aws-eu-central-1"

  validation {
    condition     = startswith(var.region_id, "aws-eu-")
    error_message = "region_id must be an EU region (aws-eu-central-1 Frankfurt or aws-eu-west-2 London). A US or APAC region would silently break the EU-only data residency assumption in docs/PLAN.md."
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
    Point-in-time restore window, in seconds. Live value is 21600 (6 hours),
    which is the ceiling on the Free plan.

    THIS MUST BE SET EXPLICITLY AND MUST MATCH. The provider declares a static
    default of 86400 (24 hours) for this attribute, so leaving it out of the
    configuration does not mean "leave it alone", it means "plan a change to 24
    hours" against a plan that cannot grant it.

    Gate L requires a configured PITR window, and this is now where that number
    lives. Six hours is short; raising it is a plan upgrade, not a code change.
  DESC
  default     = 21600

  validation {
    condition     = var.history_retention_seconds >= 0 && var.history_retention_seconds <= 2592000
    error_message = "history_retention_seconds must be between 0 and 2592000 (30 days)."
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

    LEFT FALSE DELIBERATELY. Protected branches are a paid-plan feature and this
    organisation is on free_v3, so setting it true plans a change the API will
    refuse. It is also in tension with the workflow this migration exists to
    enable: protection blocks the branch from being reset from a parent, which
    is exactly the operation a "restore staging from production" drill performs.

    Flip it on when the org moves to a paid plan AND the runbook's restore drill
    has been rewritten to reset the staging branch rather than the default one.
  DESC
  default     = false
}

# --- compute sizing ----------------------------------------------------------
#
# Free plan: 100 CU-hours per project per month, autoscaling up to 2 CU, and
# scale-to-zero after 5 minutes of inactivity which CANNOT be disabled. A 0.25
# CU compute therefore runs for about 400 hours a month before the allowance is
# gone, shared across every branch in the project.

variable "staging_min_cu" {
  type        = number
  description = "Minimum compute units for the staging endpoint. 0.25 is the floor and the right value for an environment that only runs during a gate session."
  default     = 0.25
}

variable "staging_max_cu" {
  type        = number
  description = "Maximum compute units for the staging endpoint. Kept below the production ceiling on purpose: staging burns the same shared 100 CU-hour allowance production does, and a runaway load test on staging must not be able to spend production's compute budget."
  default     = 1
}

variable "staging_suspend_timeout_seconds" {
  type        = number
  description = "Inactivity before the staging compute suspends. 0 means 'use the platform default', which is 5 minutes and is not adjustable on the Free plan. Do not set -1 (never suspend) here: scale-to-zero cannot be disabled on Free, and it is the entire reason a standing staging branch is affordable."
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

variable "create_app_role" {
  type        = bool
  description = <<-DESC
    Create a least-privilege application role alongside the owner role.

    FALSE BY DEFAULT, AND THAT IS NOT AN OVERSIGHT. Terraform can create the
    role; it cannot grant it anything, because GRANT is SQL and belongs in
    packages/db/migrations. A role created here today would be a role that can
    authenticate and then read nothing, so pointing DATABASE_URL at it would
    take the API down.

    Turn it on in the same change that adds the GRANT migration, not before.
    Until then the BFF connects as the owner, which is worse security and is
    recorded as such rather than hidden.
  DESC
  default     = false
}

variable "app_role_name" {
  type        = string
  description = "Name of the least-privilege application role, when create_app_role is true."
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
  DESC
  default     = []

  validation {
    condition     = !contains(var.allowed_ips, "0.0.0.0/0") && !contains(var.allowed_ips, "::/0")
    error_message = "allowed_ips must never contain a default route. An allowlist of everything is not an allowlist."
  }
}

# --- consumption quota -------------------------------------------------------

variable "quota" {
  type = object({
    active_time_seconds  = optional(number, 0)
    compute_time_seconds = optional(number, 0)
    written_data_bytes   = optional(number, 0)
    data_transfer_bytes  = optional(number, 0)
    logical_size_bytes   = optional(number, 0)
  })
  description = <<-DESC
    Per-project consumption quota. When a quota is exceeded Neon suspends every
    active compute in the project and refuses to start them again until the
    billing period rolls over. Zero means unlimited for that dimension.

    THIS IS THE SPEND CAP HETZNER DOES NOT HAVE. docs/PLAN.md section 2 records
    Gate $ as "one vendor armed, one vendor limitation": Hetzner publishes no
    budget API and the operator could not find the option in the console either.
    Neon does have one, it is enforced server-side, and it is declarable here.

    Null by default because the block is Optional+Computed in the provider, so
    omitting it produces no diff against the adopted project. Set it in the same
    change that moves the org off the Free plan, where a quota starts to mean
    money rather than an allowance that simply stops.
  DESC
  default     = null
}
