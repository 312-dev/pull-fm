# Two kinds of output live here and the distinction is load-bearing.
#
# Hostnames, identifiers and role names are NOT secrets. A Neon endpoint host is
# public DNS; publishing it grants nothing, and the config-management layer and
# the runbooks need it.
#
# Connection URIs ARE secrets: they carry the role password inline. Every one of
# them is marked sensitive, which keeps it out of plan output and CI logs. It
# does NOT keep it out of the state file, and nothing can: Neon returns role
# passwords through its API, so the provider stores them. See README.md.
#
# ---------------------------------------------------------------------------
# POOLED versus DIRECT: which consumer needs which, and why
# ---------------------------------------------------------------------------
#
# POOLED (`-pooler` host, PgBouncer in transaction mode inside Neon's proxy)
#   -> the BFF's own connection pool (apps/bff/src/lib/db.ts), and anything else
#      that runs many short-lived statements from many processes. This is the
#      default for application traffic and is why a separate PgBouncer is not
#      deployed alongside the cloud environments any more.
#
# DIRECT (no `-pooler`)
#   -> the migration runner (packages/db/scripts/migrate.mjs). It is NOT a
#      preference. The runner takes a SESSION-level advisory lock
#      (`pg_advisory_lock`) to serialise two BFF nodes deploying at once. A
#      session lock taken through a transaction pooler is released the moment
#      the transaction ends and the connection is handed to somebody else, so
#      the lock silently stops serialising anything and both runners proceed.
#      Running migrations through the pooler does not fail loudly; it fails by
#      corrupting a deploy under concurrency, which is worse.
#   -> anything needing session state: LISTEN/NOTIFY, session-level SET,
#      prepared statements outside a transaction, `CREATE INDEX CONCURRENTLY`.
#   -> psql for a human, so `\timing` and friends behave.
#
# ---------------------------------------------------------------------------

# --- identifiers (not secret) ------------------------------------------------

output "project_id" {
  description = "Neon project ID. Opaque and permanent."
  value       = neon_project.pullfm.id
}

output "org_id" {
  description = "Neon organisation that owns the project."
  value       = var.org_id
}

output "region_id" {
  description = "Neon deployment region."
  value       = neon_project.pullfm.region_id
}

output "pg_version" {
  description = "Postgres major version. docker-compose.dev.yml must pin the same one."
  value       = neon_project.pullfm.pg_version
}

output "main_branch_id" {
  description = "ID of the default branch (`main`), which serves production. The literal used to be written into this description and is not any more: a branch id addresses a restorable copy of production data through the control plane, which is what tools/check-public-identifiers.mjs is for. Branch ids ARE stable across a rename - the EU project's default branch was renamed from `production` to `main` and kept its id - which is worth knowing and is not a fact about the live project."
  value       = neon_project.pullfm.default_branch_id
}

output "main_branch_name" {
  description = "Name of the default branch. This configuration deliberately does not declare it (see imports.tf), so a console-side rename produces no plan diff. Publishing it here is how such a rename becomes visible at all."
  value       = neon_project.pullfm.branch[0].name
}

output "staging_branch_id" {
  description = "ID of the staging branch. This is the identifier a branch reset targets, so it belongs in the runbook."
  value       = neon_branch.staging.id
}

output "database_name" {
  description = "Application database, present on both branches (staging inherits it from main)."
  value       = neon_project.pullfm.database_name
}

output "owner_role_name" {
  description = "Role that owns the application database on both branches."
  value       = var.owner_role_name
}

output "history_retention_seconds" {
  description = "Configured point-in-time restore window. Gate L requires this to be a number rather than an intention."
  value       = neon_project.pullfm.history_retention_seconds
}

# --- hostnames (not secret) --------------------------------------------------

output "main_host_direct" {
  description = "Endpoint host for the main branch, no pooler. Migrations and psql."
  value       = neon_project.pullfm.database_host
}

output "main_host_pooled" {
  description = "Endpoint host for the main branch via the pooler. Application traffic."
  value       = neon_project.pullfm.database_host_pooler
}

output "staging_host_direct" {
  description = "Staging endpoint host, no pooler. Built from the endpoint id and proxy_host, NOT from neon_endpoint.host, which becomes the POOLED host once pooling is enabled. See the locals in main.tf."
  value       = local.staging_direct_host

  precondition {
    condition     = !strcontains(local.staging_direct_host, "-pooler")
    error_message = "Refusing to publish '${local.staging_direct_host}' as a DIRECT host: it contains '-pooler'. Migrations use this endpoint and need session-scoped advisory locks, which a transaction pooler breaks silently."
  }
}

output "staging_host_pooled" {
  description = "Staging endpoint host via the pooler. Application traffic."
  value       = local.staging_pooled_host

  # Hard gate on the derivation, at the point the value leaves the module. A
  # `check` block only warns (see checks.tf), and a hostname that does not
  # resolve must not be readable out of `terraform output` at all, because that
  # is where the runbook copies connection strings from.
  precondition {
    condition     = local.staging_pooled_host == replace(local.staging_direct_host, "/^([^.]+)\\./", "$1-pooler.") && !strcontains(local.staging_pooled_host, "-pooler-pooler")
    error_message = "Refusing to publish '${local.staging_pooled_host}' as a POOLED host. It must be the direct host ('${local.staging_direct_host}') with exactly one '-pooler' appended to its first label, and must never contain '-pooler-pooler'. A doubled marker means it was derived from an attribute that was already pooled, which is the bug this precondition exists to catch."
  }
}

# ---------------------------------------------------------------------------
# WHICH ROLE, AND WHY EVERY OUTPUT NAME SAYS SO
# ---------------------------------------------------------------------------
#
# Every connection-string output below is named
#
#     <branch>_database_url_<role>_<endpoint>
#
# because the previous names (`main_database_url_pooled`) said which ENDPOINT a
# string used and were silent about which ROLE it authenticated as, and the role
# is the half that decides what a leaked string can do. Two privilege levels now
# exist, so a name that omits the role is a name that cannot be checked.
#
#   owner  ->  neondb_owner. Owns every object in the database. Can DROP, ALTER,
#              CREATE. This is the MIGRATION identity and nothing else.
#   app    ->  pullfm_app. SELECT, INSERT, UPDATE, DELETE and sequence USAGE,
#              on this database only. Cannot DROP, cannot ALTER, cannot CREATE,
#              cannot read pg_authid, cannot SET ROLE to anything. This is the
#              RUNTIME identity for the BFF.
#
# The split matters because these two are not the same risk. A leaked runtime
# credential reaches the data, which is bad and is what envelope encryption
# (PLAN.md section 5) exists to bound. A leaked owner credential additionally
# reaches the SCHEMA, so it can drop the audit log, disable a trigger, or add a
# column, and the migration identity is the only thing that needs that power.
#
# THE OWNER AND APP STRINGS ARE SHAPED DIFFERENTLY, ON PURPOSE.
#
# The owner's password is created by Neon and returned by its API, so Terraform
# has it and the string is complete and `sensitive`. The app role is created by
# SQL (see main.tf for the measurement that forced that), so Terraform does not
# have its password and must not: accepting one as a variable would render it
# into the plan file, and plan files get attached to pull requests on a public
# repository. The `*_app_*` outputs are therefore TEMPLATES with a placeholder,
# and are not marked sensitive because they contain no secret.
#
# That asymmetry is deliberate and is the honest shape of the problem. An output
# that pretended to be a complete app connection string would have to have got
# the password from somewhere Terraform should not have been looking.

# --- owner connection strings (SECRET: password included) --------------------

output "main_database_url_owner_pooled" {
  description = "MAIN branch, OWNER role (neondb_owner), pooled endpoint. Full DDL rights. Not for the application; use main_database_url_app_pooled_template. Present because it is the only complete string available until the SQL app role exists, and because psql-through-the-pooler is occasionally wanted."
  value       = neon_project.pullfm.connection_uri_pooler
  sensitive   = true
}

output "main_database_url_owner_direct" {
  description = "MAIN branch, OWNER role (neondb_owner), direct endpoint. THIS IS DATABASE_URL_DIRECT for production: packages/db/scripts/migrate.mjs runs DDL and takes a session-scoped pg_advisory_lock, so it needs both the owner's privileges and an endpoint that is not a transaction pooler. Also the connection used to run infra/neon/sql/*.sql."
  value       = neon_project.pullfm.connection_uri
  sensitive   = true
}

output "staging_database_url_owner_pooled" {
  description = "STAGING branch, OWNER role, pooled endpoint. Same caveats as the main-branch equivalent."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.owner_role_name,
    urlencode(data.neon_branch_role_password.staging_owner.password),
    local.staging_pooled_host,
    var.database_name,
    local.ssl_suffix,
  )
  sensitive = true
}

output "staging_database_url_owner_direct" {
  description = "STAGING branch, OWNER role, direct endpoint. This is DATABASE_URL_DIRECT for the staging migration step."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.owner_role_name,
    urlencode(data.neon_branch_role_password.staging_owner.password),
    local.staging_direct_host,
    var.database_name,
    local.ssl_suffix,
  )
  sensitive = true
}

# --- application-role connection strings (TEMPLATES, no secret) --------------
#
# Substitute the password that infra/neon/sql/create-app-role.sql was given, URL
# -encoding it first if it contains any of : / ? # [ ] @ or %, then store the
# result in 1Password. Terraform never sees the finished string, which is why
# these are not sensitive and why `terraform output` is not the source of truth
# for DATABASE_URL any more.

output "main_database_url_app_pooled_template" {
  description = "MAIN branch, APP role (pullfm_app), pooled endpoint. THIS IS DATABASE_URL for the production BFF once the password is substituted. Pooled because the BFF opens many short-lived connections from a pool of its own."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.app_role_name,
    local.app_password_placeholder,
    neon_project.pullfm.database_host_pooler,
    var.database_name,
    local.ssl_suffix,
  )
}

output "main_database_url_app_direct_template" {
  description = "MAIN branch, APP role, direct endpoint. Not used by the application. It exists so an operator can connect AS the app role with psql and confirm first-hand what it cannot do, which is the only way the least-privilege claim gets checked rather than assumed."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.app_role_name,
    local.app_password_placeholder,
    neon_project.pullfm.database_host,
    var.database_name,
    local.ssl_suffix,
  )
}

output "staging_database_url_app_pooled_template" {
  description = "STAGING branch, APP role, pooled endpoint. This is DATABASE_URL for the staging BFF. The staging app role is a SEPARATE credential with its own password unless staging was branched after the role existed; run infra/neon/sql/create-app-role.sql against staging too."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.app_role_name,
    local.app_password_placeholder,
    local.staging_pooled_host,
    var.database_name,
    local.ssl_suffix,
  )
}

output "staging_database_url_app_direct_template" {
  description = "STAGING branch, APP role, direct endpoint. For verifying the staging role's privileges by hand."
  value = format(
    "postgres://%s:%s@%s/%s%s",
    var.app_role_name,
    local.app_password_placeholder,
    local.staging_direct_host,
    var.database_name,
    local.ssl_suffix,
  )
}

# --- role names and the assignment table (not secret) ------------------------

output "app_role_name" {
  description = "Name of the least-privilege runtime role. Declared by this configuration and CREATED BY SQL (infra/neon/sql/create-app-role.sql), not by Terraform. See main.tf for why it cannot be a neon_role resource."
  value       = var.app_role_name
}

# A machine-readable statement of which environment variable takes which output
# and which role it therefore authenticates as.
#
# It exists because this mapping was previously written only in prose, in two
# runbooks, and prose is where a wrong answer survives: pointing DATABASE_URL at
# an owner string is invisible at runtime. Everything works, and the only
# difference is that a leaked credential can now drop the audit log. Publishing
# the table next to the outputs means the two cannot drift apart silently.
output "database_url_assignments" {
  description = "Which env var takes which output, and the role and privilege level that implies. Not a secret: names only."
  value = {
    DATABASE_URL = {
      role        = var.app_role_name
      privileges  = "SELECT, INSERT, UPDATE, DELETE on application tables; USAGE on sequences"
      endpoint    = "pooled"
      main        = "main_database_url_app_pooled_template"
      staging     = "staging_database_url_app_pooled_template"
      consumer    = "apps/bff (runtime)"
      needs_setup = "password substituted from infra/neon/sql/create-app-role.sql"
    }
    DATABASE_URL_DIRECT = {
      role        = var.owner_role_name
      privileges  = "owner: full DDL on the application database"
      endpoint    = "direct"
      main        = "main_database_url_owner_direct"
      staging     = "staging_database_url_owner_direct"
      consumer    = "packages/db/scripts/migrate.mjs, psql, infra/neon/sql/*.sql"
      needs_setup = "none, complete in terraform output"
    }
  }
}
