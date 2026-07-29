# Adoption of the pre-existing Neon project.
#
# The project was created in the Neon console on 2026-07-29, before this
# configuration existed. Every identifier below was read back from the live
# control plane (Neon API v2) on 2026-07-29 rather than copied from a ticket:
#
#   GET /projects/steep-frost-83698289
#     org_id      org-tiny-leaf-89756764   ("312.dev LLC", subscription free_v3)
#     name        pull-fm
#     region_id   aws-eu-central-1         (Frankfurt)
#     pg_version  18
#     provisioner k8s-neonvm
#     history_retention_seconds 21600      (6h, the Free plan ceiling)
#     store_passwords true
#     branches_limit 10, branch_logical_size_limit 512 MB
#
#   GET /projects/.../branches
#     br-curly-wave-as91izv6   name "main", default true, protected false
#
#     RE-VERIFIED 2026-07-29 after the branch was renamed from "production" to
#     "main" through the Neon API. The branch ID is stable across a rename, so
#     the import identifier below is unchanged, and so is the endpoint host that
#     every connection string is built from
#     (ep-red-wave-as1i96ei.c-4.eu-central-1.aws.neon.tech). Both were checked
#     against the live API rather than assumed.
#
#   GET /projects/.../branches/br-curly-wave-as91izv6/databases
#     neondb owned by neondb_owner
#
#   GET /projects/.../branches/br-curly-wave-as91izv6/roles
#     neondb_owner
#
#   GET /projects/.../endpoints
#     ep-red-wave-as1i96ei  read_write, pooler_enabled FALSE,
#                           0.25 to 2 CU, suspend_timeout_seconds 0
#
# BRANCH NAMING CONVENTION: `main` is the default branch and is what production
# connects to. Every environment branch is a CHILD of `main` and is named after
# the environment it serves, so today that is exactly `staging`. The convention
# is recorded in docs/runbooks/neon-migration.md as well, because a naming
# scheme that only exists in one file drifts the first time somebody adds a
# branch from the console.
#
# The default branch is deliberately NOT imported as a `neon_branch` resource.
# It is the project's own default branch, already represented by the project
# resource, and managing it twice would put two resources in a fight over one
# object. A consequence worth knowing: because this configuration never declares
# the default branch's name, renaming it in the console is invisible to
# `terraform plan`. The main_branch_name output exists so the name is at least
# visible in `terraform output` when it changes.
#
# Import blocks rather than `terraform import`: they are declarative, they show
# up in `terraform plan` before anything is written to state, and they are
# reviewable in a pull request. They can be deleted once the first apply has
# run, but leaving them costs nothing and documents where the resources came
# from.

import {
  to = neon_project.pullfm
  id = var.project_id
}

# Composite identifier: <project_id>/<branch_id>/<name>.
import {
  to = neon_database.main
  id = "${var.project_id}/br-curly-wave-as91izv6/${var.database_name}"
}

import {
  to = neon_role.owner
  id = "${var.project_id}/br-curly-wave-as91izv6/${var.owner_role_name}"
}

# Composite identifier: <project_id>/<endpoint_id>.
import {
  to = neon_endpoint.main
  id = "${var.project_id}/ep-red-wave-as1i96ei"
}
