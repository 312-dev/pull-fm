# Pull.fm - Neon serverless Postgres.
#
# This root ADOPTS an existing project rather than creating one. The project,
# its default branch, its database, its owner role and its read-write endpoint
# were all created in the Neon console on 2026-07-29 and are brought under
# management by the import blocks in imports.tf. There must never be a second
# Neon project; see that file for the identifiers and how they were verified.
#
# BRANCH NAMING: `main` is the default branch and serves production. Every
# environment branch is a child of `main`, named after its environment, so the
# only one today is `staging`.
#
# WHAT THIS ROOT OWNS THAT THE HETZNER ROOTS DO NOT: the database for BOTH
# environments. One Neon project holds the `main` branch and a `staging`
# branch, so it has exactly one Terraform owner, for the same reason
# envs/shared owns the zone-wide TLS posture. If envs/staging and envs/prod each
# managed a slice of it, every apply of one would fight the other.

locals {
  # Neon's pooled endpoint host is the direct host with "-pooler" appended to
  # its FIRST label, and nothing else changes. This is not inferred from the
  # naming convention: it is the algorithm the provider itself uses
  # (provider/resource_project.go, newPooledHost), and it agrees with what the
  # live API returns for the main branch's endpoint:
  #
  #   read_write_host:        ep-red-wave-as1i96ei.c-4.eu-central-1.aws.neon.tech
  #   read_write_pooled_host: ep-red-wave-as1i96ei-pooler.c-4.eu-central-1.aws.neon.tech
  #
  # The project resource exposes database_host_pooler for the DEFAULT endpoint
  # already, so this local exists only for the staging endpoint, which has no
  # such attribute.
  staging_direct_host = neon_endpoint.staging.host
  staging_pooled_host = replace(neon_endpoint.staging.host, "/^([^.]+)\\./", "$1-pooler.")

  # sslmode=require is not optional and is not decoration. Neon terminates TLS
  # at the proxy and refuses plaintext, and a connection string that omits it
  # depends on the client library's default, which differs between drivers.
  ssl_suffix = "?sslmode=require"

  # Stands in for the application role's password in the `*_app_*_template`
  # outputs. Terraform does not know that password and must not be given it: a
  # value assigned to a variable is rendered into the plan file even when the
  # variable is marked sensitive, plan files get attached to pull requests, and
  # this repository is public. The same argument that keeps NEON_API_KEY out of
  # providers.tf keeps this out of variables.tf.
  #
  # Deliberately loud rather than a plausible-looking dummy, so that a template
  # copied into a config file without substitution fails to authenticate instead
  # of connecting as something unexpected.
  app_password_placeholder = "REPLACE_WITH_APP_ROLE_PASSWORD"
}

# --- project -----------------------------------------------------------------

resource "neon_project" "pullfm" {
  name       = var.project_name
  org_id     = var.org_id
  region_id  = var.region_id
  pg_version = var.pg_version

  compute_provisioner       = var.compute_provisioner
  history_retention_seconds = var.history_retention_seconds
  default_branch_protected  = var.default_branch_protected

  # Sent only when non-empty. An empty list is not the same as an absent
  # attribute here: absent means "no allowlist configured", while an empty list
  # is an allowlist that permits nothing.
  allowed_ips = length(var.allowed_ips) > 0 ? var.allowed_ips : null

  dynamic "quota" {
    for_each = var.quota == null ? [] : [var.quota]
    content {
      active_time_seconds  = quota.value.active_time_seconds
      compute_time_seconds = quota.value.compute_time_seconds
      written_data_bytes   = quota.value.written_data_bytes
      data_transfer_bytes  = quota.value.data_transfer_bytes
      logical_size_bytes   = quota.value.logical_size_bytes
    }
  }

  # FOUR BLOCKS ARE DELIBERATELY ABSENT: `branch`, `default_endpoint_settings`,
  # `maintenance_window` and `store_password`. All four are Optional+Computed in
  # the provider, so omitting them adopts whatever the console already set and
  # plans no change. Declaring them would be worse than redundant:
  #
  #   - Every field of `branch` is ForceNew. The live default branch is `main`
  #     with database `neondb` owned by `neondb_owner`. Writing
  #     prettier names here would not rename anything; it would plan to DESTROY
  #     AND RECREATE THE PROJECT. Those three names are surfaced as variables
  #     and outputs instead, and the database and role are adopted below as
  #     resources in their own right.
  #   - `default_endpoint_settings` would compete with neon_endpoint.main
  #     below for ownership of the same compute.
  #   - `maintenance_window` is a paid-plan feature that the console has already
  #     populated (Mondays 01:00-02:00 UTC).
  #
  # history_retention_seconds is the exception that proves the rule: it carries
  # a static provider default of 86400, so it is the one attribute where
  # omission means "change it" rather than "leave it".

  lifecycle {
    # Neon cannot change a project's region, and pg_version is ForceNew: both
    # would be expressed as destroy-and-recreate, which for this resource means
    # deleting the production database. A plan that proposes replacing this
    # resource is always a mistake, so it fails here instead of at apply.
    prevent_destroy = true
  }
}

# --- default branch contents -------------------------------------------------
#
# A branch in Neon is a copy-on-write clone of its parent INCLUDING the parent's
# databases and roles, verified against Neon's own documentation: "When creating
# a new branch, the branch will have the same Postgres roles and passwords as
# the parent branch." That is why there is no neon_database or neon_role for the
# staging branch below. Creating one would attempt to add a database that the
# branch already inherited.

resource "neon_database" "main" {
  project_id = neon_project.pullfm.id
  branch_id  = neon_project.pullfm.default_branch_id
  name       = var.database_name
  owner_name = var.owner_role_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_role" "owner" {
  project_id = neon_project.pullfm.id
  branch_id  = neon_project.pullfm.default_branch_id
  name       = var.owner_role_name

  lifecycle {
    # Dropping the owner of the application database orphans every object in
    # it. This is the one role that must not be removed by a careless plan.
    prevent_destroy = true
  }
}

# --- the application role is NOT a resource here, and that is the point ------
#
# There is no `neon_role.app` below. An earlier revision of this file had one,
# gated on a `create_app_role` variable, on the assumption that Terraform could
# create the role and SQL could grant to it. The first half of that assumption
# is false, and it fails in a way that would have looked fine in review.
#
# WHY. Neon grants membership in `neon_superuser` to every role created through
# the Console, the API or the CLI. `neon_role` is an API call, so a role created
# here is a member. The membership carries CREATEDB, CREATEROLE, BYPASSRLS and
# REPLICATION, plus pg_read_all_data, pg_write_all_data, pg_monitor and
# pg_signal_backend, plus ALL on the public schema WITH GRANT OPTION. Role
# attributes are not inherited through membership, which makes this look
# survivable, but a member may `SET ROLE neon_superuser` and use every one of
# them. `neon_role` therefore cannot express a non-administrative role.
#
# AND IT CANNOT BE REPAIRED AFTERWARDS. Measured against Postgres 18 on
# 2026-07-29 rather than reasoned about:
#
#   neondb_owner=> REVOKE neon_superuser FROM pullfm_app;
#   WARNING:  role "pullfm_app" has not been granted membership in role
#             "neon_superuser" by role "neondb_owner"
#   REVOKE ROLE
#
# A warning, a success code, and nothing revoked. Postgres 16 made role
# membership track its grantor and a REVOKE only removes grants issued by the
# revoking role; this one was issued by Neon's control plane. Naming the grantor
# is refused outright, and ADMIN OPTION does not help because the restriction is
# about the grantor rather than about admin rights. Only the original grantor or
# a superuser can revoke, and Neon offers customers neither.
#
# WHAT REPLACES IT. `infra/neon/sql/create-app-role.sql` creates the role with
# SQL, which Neon documents as the way to get a role that is "only granted the
# basic public schema privileges granted to newly created roles in a standalone
# Postgres installation". `grant-app-role.sql` grants it exactly SELECT, INSERT,
# UPDATE and DELETE plus sequence USAGE, and `verify-app-role.sql` asserts both
# halves. None of that is expressible in this provider: its eleven resources
# contain no grant primitive at all (checked in provider/provider.go, not in the
# documentation).
#
# WHAT THIS ROOT STILL OWNS. The hostnames, the database name and the role names
# that a connection string is assembled from. See the `*_app_*` outputs, which
# are templates carrying a password placeholder rather than complete strings,
# because the one component Terraform must never learn is the password.
#
# The owner role below stays exactly as it was. It is the migration identity,
# and migrations legitimately need DDL.

# --- main-branch compute -----------------------------------------------------
#
# Adopted, not created. The console made this endpoint with the project, and it
# is the only read_write endpoint the default branch may have.

resource "neon_endpoint" "main" {
  project_id = neon_project.pullfm.id
  branch_id  = neon_project.pullfm.default_branch_id
  type       = "read_write"

  # THE ONLY INTENTIONAL CHANGE TO THE ADOPTED PRODUCTION COMPUTE. The console
  # created this endpoint with pooling off, so the pooled host resolves but
  # refuses connections. Neon's pooler is PgBouncer in transaction mode running
  # inside the Neon proxy, which is precisely the component this migration
  # deletes from the Hetzner topology, so it has to be on for the pooled
  # connection string to mean anything.
  pooler_enabled = true
  pooler_mode    = "transaction"

  # Autoscaling limits and suspend timeout are deliberately absent: they are
  # Optional+Computed, and the live values (0.25 to 2 CU, platform-default
  # suspend) are the console's and are correct. Scale-to-zero after 5 minutes
  # cannot be disabled on the Free plan in any case.

  lifecycle {
    prevent_destroy = true
  }
}

# --- staging branch ----------------------------------------------------------
#
# This is the resource that replaces `./infra/staging-env.sh down`. Tearing down
# a Hetzner environment destroys servers because servers bill by the hour;
# a Neon branch bills for the storage of its diff from the parent and for the
# compute hours it actually serves, both of which round to nothing while it
# sits idle. Destroying it to save money would be destroying it for no reason.

resource "neon_branch" "staging" {
  project_id = neon_project.pullfm.id
  parent_id  = neon_project.pullfm.default_branch_id
  name       = var.staging_branch_name

  # Explicitly unprotected. Protection is a paid-plan feature, and a protected
  # staging branch could not be reset from production, which is the operation
  # the whole branching workflow exists to make cheap.
  protected = "no"

  # A branch inherits the roles that exist AT THE MOMENT IT IS CREATED, so the
  # owner must be in state before the branch is cut.
  #
  # The same rule applies to the application role and Terraform cannot express
  # it, because that role is created by SQL after this apply (see the block
  # above). The consequence is operational rather than avoidable: a branch that
  # predates the SQL role does not have it, and creating it on `main` does not
  # backfill. infra/neon/sql/*.sql are run PER BRANCH, and the runbook says so
  # in the one place an operator will be looking.
  depends_on = [neon_role.owner]
}

# A branch with no compute is storage that cannot be connected to. Neon does not
# create one implicitly through the API ("A branch can be created with or
# without a compute"), so the endpoint is explicit.
resource "neon_endpoint" "staging" {
  project_id = neon_project.pullfm.id
  branch_id  = neon_branch.staging.id
  type       = "read_write"

  pooler_enabled = true
  pooler_mode    = "transaction"

  autoscaling_limit_min_cu = var.staging_min_cu
  autoscaling_limit_max_cu = var.staging_max_cu
  suspend_timeout_seconds  = var.staging_suspend_timeout_seconds

  compute_provisioner = var.compute_provisioner
}

# --- credentials -------------------------------------------------------------
#
# The staging branch inherits the owner role and its password from production at
# branch creation, but the provider does not surface an inherited role's
# password on the branch, so it is read back explicitly. This is a data source
# rather than a resource on purpose: the role on the staging branch is not a
# separate object to manage, it is the same role seen through a different
# branch.
data "neon_branch_role_password" "staging_owner" {
  project_id = neon_project.pullfm.id
  branch_id  = neon_branch.staging.id
  role_name  = var.owner_role_name
}
