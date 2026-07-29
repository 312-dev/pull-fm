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
  description = "ID of the default branch (`main`), which serves production. Stable across a rename: this project's branch was renamed from `production` to `main` on 2026-07-29 and kept the id br-curly-wave-as91izv6."
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
  description = "Staging endpoint host, no pooler."
  value       = local.staging_direct_host
}

output "staging_host_pooled" {
  description = "Staging endpoint host via the pooler."
  value       = local.staging_pooled_host
}

# --- connection strings (SECRET) ---------------------------------------------

output "main_database_url_pooled" {
  description = "Connection string to the main branch via the pooler. This is DATABASE_URL for the production BFF."
  value       = neon_project.pullfm.connection_uri_pooler
  sensitive   = true
}

output "main_database_url_direct" {
  description = "Connection string to the main branch, no pooler. This is DATABASE_URL_DIRECT, used by the migration runner and by a human with psql."
  value       = neon_project.pullfm.connection_uri
  sensitive   = true
}

output "staging_database_url_pooled" {
  description = "Staging connection string via the pooler. This is DATABASE_URL for the staging BFF."
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

output "staging_database_url_direct" {
  description = "Staging connection string, no pooler. This is DATABASE_URL_DIRECT for the staging migration step."
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

# --- least-privilege application role (only when enabled) --------------------

output "app_role_name" {
  description = "Name of the least-privilege application role, or null when create_app_role is false."
  value       = var.create_app_role ? neon_role.app[0].name : null
}

output "main_app_database_url_pooled" {
  description = "Main-branch connection string for the least-privilege role via the pooler, or null when create_app_role is false. Do not point DATABASE_URL at this until the GRANT migration has shipped."
  value = var.create_app_role ? format(
    "postgres://%s:%s@%s/%s%s",
    neon_role.app[0].name,
    urlencode(neon_role.app[0].password),
    neon_project.pullfm.database_host_pooler,
    var.database_name,
    local.ssl_suffix,
  ) : null
  sensitive = true
}

output "main_app_database_url_direct" {
  description = "Main-branch connection string for the least-privilege role without the pooler, or null when create_app_role is false."
  value = var.create_app_role ? format(
    "postgres://%s:%s@%s/%s%s",
    neon_role.app[0].name,
    urlencode(neon_role.app[0].password),
    neon_project.pullfm.database_host,
    var.database_name,
    local.ssl_suffix,
  ) : null
  sensitive = true
}
